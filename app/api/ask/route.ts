import { NextRequest, NextResponse } from "next/server";
import { queryNia } from "@/lib/nia";

export const maxDuration = 30;

/**
 * Free-form question over already-indexed repos.
 *
 * POST /api/ask
 *   { username: "stananan", repos: ["blewIt", "iloveush"], query: "is there real auth?" }
 *
 * Returns one Nia answer per repo in parallel. Repos are assumed to already
 * be indexed by a prior /api/analyze run (Nia caches by slug indefinitely).
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { username, repos, query } = body as {
    username: string;
    repos: string[];
    query: string;
  };

  if (!username || !Array.isArray(repos) || !query) {
    return NextResponse.json(
      { error: "username, repos, query required" },
      { status: 400 }
    );
  }

  const perRepo = await Promise.all(
    repos.slice(0, 5).map(async (repoName) => {
      const slug = `${username}/${repoName}`;
      try {
        const snippets = await queryNia(slug, query);
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
        };
      } catch (err) {
        return {
          repo: repoName,
          slug,
          answer: `(Nia error: ${err instanceof Error ? err.message : "unknown"})`,
          citations: [] as string[],
        };
      }
    })
  );

  return NextResponse.json({ query, perRepo });
}
