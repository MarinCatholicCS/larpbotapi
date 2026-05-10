import { NextResponse } from "next/server";

const TRIGGER_DEBOUNCE_MS = 15_000;

let lastTriggerAt = 0;

function parseTensorlakeBody(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function POST() {
  const now = Date.now();
  if (now - lastTriggerAt < TRIGGER_DEBOUNCE_MS) {
    return NextResponse.json({
      ok: true,
      forwardedToTensorlake: false,
      deduped: true,
      reason: "Recent inbox poll already triggered",
    });
  }

  const key = process.env.TENSORLAKE_API_KEY;
  if (!key) {
    return NextResponse.json(
      { ok: false, error: "TENSORLAKE_API_KEY is not set in this deployment" },
      { status: 500 },
    );
  }

  try {
    // Any Pub/Sub push means "new mail, go check"; await the trigger so Vercel logs
    // show whether Tensorlake accepted the invocation.
    const response = await fetch("https://api.tensorlake.ai/applications/poll_recruiting_inbox", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: '""',
    });
    const text = await response.text();
    const tensorlake = parseTensorlakeBody(text);

    if (!response.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Tensorlake rejected the webhook trigger",
          tensorlakeStatus: response.status,
          tensorlake,
        },
        { status: 502 },
      );
    }

    lastTriggerAt = now;

    return NextResponse.json({
      ok: true,
      forwardedToTensorlake: true,
      tensorlakeStatus: response.status,
      tensorlake,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown Tensorlake trigger error",
      },
      { status: 502 },
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    hint: "POST from Pub/Sub to trigger",
    hasTensorlakeKey: Boolean(process.env.TENSORLAKE_API_KEY),
  });
}
