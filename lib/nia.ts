// Nia v2 API client. Base URL and endpoints differ from the legacy /v1 API
// — see https://apigcp.trynia.ai/v2 (the previous api.nia.ai/v1 is dead).
const NIA_API = "https://apigcp.trynia.ai/v2";

function headers() {
  return {
    Authorization: `Bearer ${process.env.NIA_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/**
 * Index a GitHub repo with Nia. Accepts either an owner/repo slug
 * (e.g. "stananan/blewIt") or a full https://github.com/... URL — the
 * latter is parsed to a slug.
 *
 * Returns the slug, which is what Nia's search endpoint expects in
 * its `repositories` field.
 */
export async function indexRepo(repoUrlOrSlug: string): Promise<string> {
  const slug = repoUrlOrSlug.startsWith("http")
    ? repoUrlOrSlug.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "")
    : repoUrlOrSlug;

  const res = await fetch(`${NIA_API}/sources`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type: "repository", repository: slug }),
  });
  if (!res.ok) throw new Error(`Nia indexRepo failed: ${res.status} ${await res.text()}`);
  // We return the slug rather than the source ID — search is keyed by slug.
  return slug;
}

/**
 * Poll Nia until the source is indexed. Looks up by slug via list-sources,
 * since /v2/search references repos by slug.
 */
export async function pollIndexStatus(slug: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${NIA_API}/sources?type=repository`, { headers: headers() });
    if (res.ok) {
      const data = await res.json();
      const items: Array<{ identifier?: string; status?: string }> =
        data.items ?? data.sources ?? data ?? [];
      const match = items.find((s) => s.identifier === slug);
      if (match) {
        const status = (match.status ?? "").toLowerCase();
        if (["indexed", "ready", "completed", "complete"].includes(status)) return;
        if (["error", "failed"].includes(status)) {
          throw new Error(`Nia indexing failed for ${slug}: ${status}`);
        }
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Don't throw on timeout — search may still work with partial index
}

export interface NiaSnippet {
  content: string;
  filePath: string;
  score: number;
}

/**
 * Query Nia's unified search scoped to one repository (by slug).
 * Returns a synthesized answer + cited file paths — Nia's v2 API
 * does not return raw chunks the way the v1 API did.
 */
export async function queryNia(slug: string, query: string): Promise<NiaSnippet[]> {
  const res = await fetch(`${NIA_API}/search`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      mode: "query",
      messages: [{ role: "user", content: query }],
      repositories: [slug],
      include_sources: true,
      fast_mode: true,
    }),
  });
  if (!res.ok) throw new Error(`Nia query failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const answer: string = data.content ?? "";
  const sources: string[] = data.sources ?? [];

  // Adapt the v2 answer-shape into the snippet[] shape callers expect.
  // We pack the synthesized answer as the first "snippet" and each citation
  // as a follow-up entry, so existing display logic still works.
  const snippets: NiaSnippet[] = [];
  if (answer) snippets.push({ content: answer, filePath: `${slug} (Nia synthesis)`, score: 1.0 });
  for (const cite of sources.slice(0, 5)) {
    snippets.push({ content: `Cited file: ${cite}`, filePath: cite, score: 0.8 });
  }
  return snippets;
}
