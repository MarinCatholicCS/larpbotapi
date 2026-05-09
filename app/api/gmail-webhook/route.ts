import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  // Pub/Sub will retry on non-2xx, so ack first, fire-and-forget the poll trigger.
  // We don't need to inspect the push payload — any push means "new mail, go check".
  fetch("https://api.tensorlake.ai/applications/poll_recruiting_inbox", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.TENSORLAKE_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: '""',
  }).catch(() => {
    // ignore — next push will retry the trigger
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST from Pub/Sub to trigger" });
}
