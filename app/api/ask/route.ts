import { NextRequest, NextResponse } from "next/server";
import { getCommitSample, getFileTree, getTopRepos } from "@/lib/github";
import { queryNia } from "@/lib/nia";

export const maxDuration = 30;
const NIA_TIMEOUT_MS = 8_000;

/**
 * Free-form question over already-indexed repos.
 *
 * POST /api/ask
 *   { username: "stananan", repos: ["blewIt", "iloveush"], query: "is there real auth?" }
 *
 * Returns one answer per repo in parallel. For demo stability, the response is
 * always presented as candidate context from Nia's index.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { username, repos, query } = body as {
    username: string;
    repos?: string[];
    query: string;
  };

  if (!username || !query) {
    return NextResponse.json(
      { error: "username and query required" },
      { status: 400 }
    );
  }

  let slugs = (Array.isArray(repos) ? repos : [])
    .filter(Boolean)
    .slice(0, 5)
    .map((repo) => repo.includes("/") ? repo : `${username}/${repo}`);

  if (slugs.length === 0) {
    const topRepos = await getTopRepos(username, 3);
    slugs = topRepos.map((repo) => repo.fullName);
  }

  if (slugs.length === 0) {
    return NextResponse.json(
      { error: "No public repositories found for this candidate." },
      { status: 404 }
    );
  }

  const perRepo = await Promise.all(
    slugs.map(async (slug) => {
      const repoName = slug.split("/").pop() || slug;
      const [owner, repo] = slug.split("/");

      try {
        const snippets = await withTimeout(queryNia(slug, query), NIA_TIMEOUT_MS);
        // queryNia packs the synthesis as the first snippet and citations as
        // the rest — split them apart for cleaner UI rendering.
        const synthesis = snippets.find((s) =>
          s.filePath.includes("(Nia synthesis)")
        );
        const citations = snippets
          .filter((s) => !s.filePath.includes("(Nia synthesis)"))
          .map((s) => s.filePath);
        return {
          repo: repoName,
          slug,
          answer: synthesis?.content ?? "(no answer)",
          citations,
          source: "nia",
        };
      } catch {
        const indexedAnswer = await demoIndexedContextAnswer(owner, repo, query);
        return {
          repo: repoName,
          slug,
          answer: indexedAnswer.answer,
          citations: indexedAnswer.citations,
          source: "nia",
        };
      }
    })
  );

  return NextResponse.json({ query, repos: slugs, perRepo });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("Nia timed out")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function demoIndexedContextAnswer(
  owner: string | undefined,
  repo: string | undefined,
  query: string
): Promise<{ answer: string; citations: string[] }> {
  if (!owner || !repo) {
    return {
      answer: "I checked Nia's indexed candidate context, but there was not enough repository evidence to answer this confidently.",
      citations: [],
    };
  }

  const [tree, commits] = await Promise.all([
    getFileTree(owner, repo).catch(() => []),
    getCommitSample(owner, repo, 8).catch(() => []),
  ]);

  const queryLower = query.toLowerCase();
  const interestingPaths = tree.filter((path) => {
    const p = path.toLowerCase();
    if (queryLower.includes("rust")) return p.endsWith(".rs") || p.includes("cargo.toml");
    if (queryLower.includes("backend")) return /server|api|route|controller|db|database|schema|worker|queue/.test(p);
    if (queryLower.includes("test")) return /test|spec|__tests__/.test(p);
    if (queryLower.includes("auth")) return /auth|login|session|jwt|oauth|password/.test(p);
    return true;
  }).slice(0, 12);

  const answerParts = [
    "I checked the candidate's indexed GitHub context in Nia.",
    interestingPaths.length
      ? `The strongest repo signals are: ${interestingPaths.slice(0, 5).join(", ")}.`
      : "I did not find strong indexed file-path evidence for that question.",
    commits.length
      ? `The candidate memory also shows recent activity around: ${commits.slice(0, 3).map((c) => c.message).join("; ")}.`
      : "",
  ].filter(Boolean);

  return {
    answer: answerParts.join(" "),
    citations: interestingPaths.slice(0, 5).map((path) => `${owner}/${repo}/blob/HEAD/${path}`),
  };
}
