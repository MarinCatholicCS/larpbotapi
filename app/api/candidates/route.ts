import { NextRequest, NextResponse } from "next/server";

const TL_API = "https://api.tensorlake.ai";

async function invokeTensorlake(app: string, body: unknown) {
  const key = process.env.TENSORLAKE_API_KEY;
  if (!key) throw new Error("TENSORLAKE_API_KEY not set");

  // Invoke the Tensorlake application (async — returns request_id)
  const invoke = await fetch(`${TL_API}/applications/${app}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!invoke.ok) throw new Error(`Tensorlake invoke failed: ${invoke.status}`);
  const { request_id } = await invoke.json();

  // Poll for result (max 15s for simple memory reads)
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const out = await fetch(`${TL_API}/applications/${app}/requests/${request_id}/output`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (out.ok) return out.json();
  }
  throw new Error("Tensorlake query timed out");
}

// GET /api/candidates — list all analyzed candidates
export async function GET(_req: NextRequest) {
  try {
    const candidates = await invokeTensorlake("query_candidates", null);
    return NextResponse.json(candidates);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// GET /api/candidates?username=stananan — fetch one candidate
// (handled via query param on the same route)
export async function POST(req: NextRequest) {
  const { githubUsername } = await req.json();
  if (!githubUsername) {
    return NextResponse.json({ error: "githubUsername required" }, { status: 400 });
  }
  try {
    const result = await invokeTensorlake("get_candidate", githubUsername);
    if (!result) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
