import { NextResponse } from "next/server";
import { google } from "googleapis";

export const maxDuration = 30;

interface ThreadSummary {
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  date: string;
  githubUsername: string | null;
  hasReport: boolean;
}

function gmailClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

function extractEmail(from: string): { email: string; name: string } {
  // "Name <email@host>" or just "email@host"
  const match = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1].replace(/^"|"$/g, "").trim(), email: match[2] };
  return { email: from.trim(), name: from.trim() };
}

function extractGithubUsername(text: string): string | null {
  const m = text.match(/github\.com\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Returns inbox threads where an applicant has emailed the recruiter.
 * Filters out threads we initiated. For each thread returns sender info,
 * subject, GitHub username if found anywhere in the thread, and whether
 * we've already replied with a LARP Report.
 */
export async function GET() {
  try {
    const gmail = gmailClient();
    const me = (await gmail.users.getProfile({ userId: "me" })).data.emailAddress || "";

    // List recent threads in the primary category (where applicants email us)
    const list = await gmail.users.threads.list({
      userId: "me",
      q: "category:primary",
      maxResults: 30,
    });

    const threads: ThreadSummary[] = [];
    for (const t of list.data.threads || []) {
      try {
        const full = await gmail.users.threads.get({
          userId: "me",
          id: t.id || "",
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        const messages = full.data.messages || [];
        if (messages.length === 0) continue;

        // Skip threads we initiated (first message from us — outbound)
        const firstHeaders = messages[0].payload?.headers || [];
        const firstFrom = firstHeaders.find((h) => h.name === "From")?.value || "";
        if (firstFrom.toLowerCase().includes(me.toLowerCase())) continue;

        // The applicant is whoever sent the first message
        const { email: fromEmail, name: fromName } = extractEmail(firstFrom);
        const subject = firstHeaders.find((h) => h.name === "Subject")?.value || "(no subject)";
        const date = firstHeaders.find((h) => h.name === "Date")?.value || "";

        // Find a github URL anywhere in the thread (across all messages)
        let githubUsername: string | null = null;
        let hasReport = false;
        for (const msg of messages) {
          const headers = msg.payload?.headers || [];
          const f = headers.find((h) => h.name === "From")?.value || "";
          const subj = headers.find((h) => h.name === "Subject")?.value || "";
          if (f.toLowerCase().includes(me.toLowerCase()) && subj.toLowerCase().startsWith("larp report:")) {
            hasReport = true;
          }
          if (!githubUsername) {
            const text = (msg.snippet || "") + " " + subj;
            githubUsername = extractGithubUsername(text);
          }
        }

        threads.push({
          threadId: t.id || "",
          fromEmail,
          fromName,
          subject,
          snippet: t.snippet || messages[0].snippet || "",
          date,
          githubUsername,
          hasReport,
        });
      } catch {
        // skip malformed thread
      }
    }

    return NextResponse.json({ inbox: me, threads });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "unknown" },
      { status: 500 }
    );
  }
}
