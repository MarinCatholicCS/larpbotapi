import OpenAI from "openai";
import { getCommitSample, getFileContent, getFileTree } from "./github";
import { queryNia, NiaSnippet } from "./nia";
import { ClaimVerification, Receipt } from "./types";

function stripJson(text: string): string {
  text = text.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "");
  }
  return text.trim();
}

const client = new OpenAI();

export async function parseClaims(claimsText: string): Promise<string[]> {
  const resp = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `Parse the following candidate claims into a JSON array of individual, specific claims. Each claim should be a single verifiable assertion. Return ONLY a JSON array of strings, no markdown.\n\nClaims: ${claimsText}`,
      },
    ],
  });
  const text = stripJson(resp.choices[0].message.content?.trim() ?? "");
  try {
    return JSON.parse(text);
  } catch {
    return claimsText.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  }
}

interface AgentContext {
  claim: string;
  indexIds: Record<string, string>; // repoName → indexId
  repoMetas: Array<{ name: string; fullName: string; htmlUrl: string; language: string | null }>;
  owner: string;
}

const MAX_TOOL_CALLS = 8;

export async function verifyClaim(ctx: AgentContext): Promise<ClaimVerification> {
  const tools: OpenAI.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "nia_search",
        description: "Search the indexed codebase for relevant code snippets",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name to search" },
            query: { type: "string", description: "Natural language search query" },
          },
          required: ["repo", "query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "github_commits",
        description: "Get recent commit messages and timestamps for a repository",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
          },
          required: ["repo"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "github_file",
        description: "Read a specific file from a repository",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
            path: { type: "string", description: "File path within the repository" },
          },
          required: ["repo", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "github_tree",
        description: "List all files in a repository",
        parameters: {
          type: "object",
          properties: {
            repo: { type: "string", description: "Repository name" },
          },
          required: ["repo"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_verdict",
        description: "Submit your final verdict on this claim",
        parameters: {
          type: "object",
          properties: {
            verdict: {
              type: "string",
              enum: ["VERIFIED", "PARTIAL", "UNVERIFIED", "CONTRADICTED"],
            },
            confidence: { type: "number", description: "0–1 confidence score" },
            summary: { type: "string", description: "1–2 sentence finding" },
            evidence: { type: "string", description: "Specific quote, commit, or pattern" },
            receipts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["commit", "file", "repo", "pattern"] },
                  label: { type: "string" },
                  detail: { type: "string" },
                  url: { type: "string" },
                },
                required: ["type", "label", "detail", "url"],
              },
            },
            whatToAskNext: { type: "string", description: "Follow-up question for the interviewer" },
          },
          required: ["verdict", "confidence", "summary", "evidence", "receipts", "whatToAskNext"],
        },
      },
    },
  ];

  const repoList = ctx.repoMetas.map((r) => `- ${r.name} (${r.language ?? "unknown"})`).join("\n");
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `You are LARPbot, an AI investigator that verifies developer claims against their actual GitHub code.

Repositories available for investigation:
${repoList}

Your job: investigate the claim, gather evidence using the tools, then call submit_verdict.
Be specific. Use commit SHAs, file paths, and code snippets as evidence.
Don't be mean for its own sake — just honest. Cap tool use to ${MAX_TOOL_CALLS} calls.`,
    },
    {
      role: "user",
      content: `Claim to verify: "${ctx.claim}"\n\nInvestigate this claim against the candidate's GitHub repositories and submit your verdict.`,
    },
  ];

  const collectedReceipts: Receipt[] = [];
  let toolCallCount = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      tools,
      messages,
    });

    const message = response.choices[0].message;
    messages.push(message);

    if (response.choices[0].finish_reason !== "tool_calls") break;

    for (const toolCall of message.tool_calls ?? []) {
      if (toolCall.type !== "function") continue;
      const name = toolCall.function.name;
      const input = JSON.parse(toolCall.function.arguments) as Record<string, string>;

      if (name === "submit_verdict") {
        const parsed = input as unknown as {
          verdict: ClaimVerification["verdict"];
          confidence: number;
          summary: string;
          evidence: string;
          receipts: Receipt[];
          whatToAskNext: string;
        };
        return {
          claim: ctx.claim,
          verdict: parsed.verdict,
          confidence: parsed.confidence,
          summary: parsed.summary,
          evidence: parsed.evidence,
          receipts: [...collectedReceipts, ...(parsed.receipts ?? [])],
          whatToAskNext: parsed.whatToAskNext,
        };
      }

      toolCallCount++;
      let result = "";

      if (toolCallCount > MAX_TOOL_CALLS) {
        result = "Tool call limit reached. Please submit your verdict now.";
      } else {
        try {
          if (name === "nia_search") {
            const indexId = ctx.indexIds[input.repo];
            if (!indexId) {
              result = `No index found for repo: ${input.repo}`;
            } else {
              const snippets: NiaSnippet[] = await queryNia(indexId, input.query);
              result = snippets
                .map((s, i) => `[${i + 1}] ${s.filePath}\n${s.content}`)
                .join("\n\n---\n\n");
              for (const s of snippets.slice(0, 2)) {
                const repo = ctx.repoMetas.find((r) => r.name === input.repo);
                if (repo) {
                  collectedReceipts.push({
                    type: "file",
                    label: s.filePath,
                    detail: s.content.slice(0, 150),
                    url: `${repo.htmlUrl}/blob/HEAD/${s.filePath}`,
                  });
                }
              }
            }
          } else if (name === "github_commits") {
            const repo = ctx.repoMetas.find((r) => r.name === input.repo);
            if (!repo) {
              result = `Repo not found: ${input.repo}`;
            } else {
              const [owner] = repo.fullName.split("/");
              const commits = await getCommitSample(owner, input.repo);
              result = commits
                .map((c) => `${c.sha} ${c.date.slice(0, 10)} ${c.message}`)
                .join("\n");
            }
          } else if (name === "github_file") {
            const repo = ctx.repoMetas.find((r) => r.name === input.repo);
            if (!repo) {
              result = `Repo not found: ${input.repo}`;
            } else {
              const [owner] = repo.fullName.split("/");
              result = await getFileContent(owner, input.repo, input.path);
            }
          } else if (name === "github_tree") {
            const repo = ctx.repoMetas.find((r) => r.name === input.repo);
            if (!repo) {
              result = `Repo not found: ${input.repo}`;
            } else {
              const [owner] = repo.fullName.split("/");
              const tree = await getFileTree(owner, input.repo);
              result = tree.join("\n");
            }
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result || "(empty result)",
      });
    }
  }

  return {
    claim: ctx.claim,
    verdict: "UNVERIFIED",
    confidence: 0.3,
    summary: "Investigation was inconclusive.",
    evidence: "Agent did not reach a definitive finding.",
    receipts: collectedReceipts,
    whatToAskNext: "Ask the candidate to walk through their code live.",
  };
}

export async function synthesizeOverall(
  username: string,
  claims: ClaimVerification[]
): Promise<{
  overallLarpScore: number;
  overallVerdict: string;
  subscores: {
    skillInflation: number;
    projectSubstance: number;
    roleAuthenticity: number;
    codeDepth: number;
  };
  redemption: string;
}> {
  const claimsSummary = claims
    .map((c) => `[${c.verdict} ${Math.round(c.confidence * 100)}%] ${c.claim}: ${c.summary}`)
    .join("\n");

  const resp = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are LARPbot. Based on these per-claim investigation results for GitHub user "${username}", produce an overall assessment.

${claimsSummary}

Return ONLY valid JSON (no markdown) with this exact shape:
{
  "overallLarpScore": <0-100, where 100 = fully fabricated, 0 = completely honest>,
  "overallVerdict": "<one punchy sentence verdict>",
  "subscores": {
    "skillInflation": <0-100>,
    "projectSubstance": <0-100>,
    "roleAuthenticity": <0-100>,
    "codeDepth": <0-100>
  },
  "redemption": "<one genuine positive thing the evidence showed>"
}`,
      },
    ],
  });

  const text = stripJson(resp.choices[0].message.content?.trim() ?? "{}");
  return JSON.parse(text);
}
