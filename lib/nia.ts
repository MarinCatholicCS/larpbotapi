const NIA_API = "https://api.nia.ai/v1";

function headers() {
  return {
    Authorization: `Bearer ${process.env.NIA_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function indexRepo(repoUrl: string): Promise<string> {
  const res = await fetch(`${NIA_API}/indexes`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url: repoUrl }),
  });
  if (!res.ok) throw new Error(`Nia indexRepo failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.id ?? data.indexId ?? data.index_id;
}

export async function pollIndexStatus(indexId: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${NIA_API}/indexes/${indexId}`, { headers: headers() });
    if (!res.ok) throw new Error(`Nia status check failed: ${res.status}`);
    const data = await res.json();
    const status: string = data.status ?? data.state ?? "";
    if (status === "ready" || status === "complete" || status === "completed") return;
    if (status === "error" || status === "failed") throw new Error(`Nia indexing failed: ${JSON.stringify(data)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Nia index ${indexId} timed out after ${timeoutMs}ms`);
}

export interface NiaSnippet {
  content: string;
  filePath: string;
  score: number;
}

export async function queryNia(indexId: string, query: string, topK = 5): Promise<NiaSnippet[]> {
  const res = await fetch(`${NIA_API}/indexes/${indexId}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, top_k: topK }),
  });
  if (!res.ok) throw new Error(`Nia query failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const results = data.results ?? data.snippets ?? data.chunks ?? [];
  return results.map((r: { content?: string; text?: string; file_path?: string; filePath?: string; path?: string; score?: number; similarity?: number }) => ({
    content: r.content ?? r.text ?? "",
    filePath: r.file_path ?? r.filePath ?? r.path ?? "",
    score: r.score ?? r.similarity ?? 0,
  }));
}
