import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getTopRepos } from "@/lib/github";
import { indexRepo, pollIndexStatus } from "@/lib/nia";
import { parseClaims, verifyClaim, synthesizeOverall } from "@/lib/openai";
import { createJob, updateJob } from "@/lib/jobStore";
import { AnalysisResult } from "@/lib/types";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { githubUsername, claims } = body as { githubUsername: string; claims: string };

  if (!githubUsername || !claims) {
    return NextResponse.json({ error: "githubUsername and claims are required" }, { status: 400 });
  }

  const jobId = randomUUID();
  createJob(jobId);

  // Run analysis async — return jobId immediately so UI can poll
  runAnalysis(jobId, githubUsername, claims).catch((err) => {
    updateJob(jobId, { stage: "error", message: err.message });
  });

  return NextResponse.json({ jobId });
}

async function runAnalysis(jobId: string, username: string, claimsText: string): Promise<void> {
  // 1. Fetch top repos
  updateJob(jobId, { stage: "fetching_repos", progress: 5, message: "Fetching GitHub repositories..." });
  const repos = await getTopRepos(username, 3);

  if (repos.length === 0) {
    updateJob(jobId, { stage: "error", message: "No public repositories found for this user." });
    return;
  }

  // 2. Index repos with Nia in parallel
  updateJob(jobId, { stage: "indexing", progress: 15, message: `Indexing ${repos.length} repositories with Nia...` });

  const indexIds: Record<string, string> = {};
  await Promise.all(
    repos.map(async (repo, i) => {
      try {
        const indexId = await indexRepo(repo.url);
        indexIds[repo.name] = indexId;
        updateJob(jobId, {
          progress: 15 + (i + 1) * 15,
          message: `Indexed ${repo.name}...`,
        });
        await pollIndexStatus(indexId);
        updateJob(jobId, {
          progress: 30 + (i + 1) * 10,
          message: `${repo.name} ready.`,
        });
      } catch (err) {
        // Non-fatal: proceed without Nia for this repo
        console.error(`Failed to index ${repo.name}:`, err);
      }
    })
  );

  // 3. Parse claims
  updateJob(jobId, { stage: "analyzing", progress: 55, message: "Parsing claims..." });
  const parsedClaims = await parseClaims(claimsText);

  // 4. Verify each claim with agentic loop
  const repoMetas = repos.map((r) => ({
    name: r.name,
    fullName: r.fullName,
    htmlUrl: r.htmlUrl,
    language: r.language,
  }));

  const verifiedClaims = [];
  const niaUsed = { flag: false };
  for (let i = 0; i < parsedClaims.length; i++) {
    const claim = parsedClaims[i];
    updateJob(jobId, {
      progress: 55 + Math.round(((i + 1) / parsedClaims.length) * 35),
      message: `Verifying: "${claim.slice(0, 60)}..."`,
    });
    const result = await verifyClaim({
      claim,
      indexIds,
      repoMetas,
      owner: username,
      niaUsed,
    });
    verifiedClaims.push(result);
  }

  // 5. Synthesize overall verdict
  updateJob(jobId, { progress: 95, message: "Synthesizing verdict..." });
  const overall = await synthesizeOverall(username, verifiedClaims);

  const result: AnalysisResult = {
    candidate: username,
    githubUrl: `https://github.com/${username}`,
    analyzedRepos: repos.map((r) => r.name),
    overallLarpScore: overall.overallLarpScore,
    overallVerdict: overall.overallVerdict,
    subscores: overall.subscores,
    claims: verifiedClaims,
    redemption: overall.redemption,
    niaVerified: niaUsed.flag,
    analyzedAt: new Date().toISOString(),
  };

  // Store result in job for frontend to retrieve
  updateJob(jobId, {
    stage: "complete",
    progress: 100,
    message: JSON.stringify(result),
  });
}
