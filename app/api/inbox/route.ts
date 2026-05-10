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
  reportScore: number | null;
  reportSubject: string | null;
  reportText: string | null;
  reportHtml: string | null;
  hasReport: boolean;
}

interface GmailPayload {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPayload[] | null;
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

function decodePart(data?: string | null): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

function stripHtml(text: string): string {
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBody(payload: GmailPayload | null | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) {
    return payload.mimeType === "text/html"
      ? stripHtml(decodePart(payload.body.data))
      : decodePart(payload.body.data);
  }
  const parts = payload.parts || [];
  const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data);
  if (plain?.body?.data) return decodePart(plain.body.data);
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  if (html?.body?.data) return stripHtml(decodePart(html.body.data));
  return parts.map((part) => extractBody(part)).filter(Boolean).join("\n");
}

function extractHtml(payload: GmailPayload | null | undefined): string {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodePart(payload.body.data);
  }
  const parts = payload.parts || [];
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  if (html?.body?.data) return decodePart(html.body.data);
  return parts.map((part) => extractHtml(part)).find(Boolean) || "";
}

function extractReportInfo(subject: string): { username: string | null; score: number | null } {
  const match = subject.match(/^LARP Report:\s*([A-Za-z0-9_-]+)(?:\s*[—-]\s*Score\s*(\d{1,3})\/100)?/i);
  if (!match) return { username: null, score: null };
  return {
    username: match[1] || null,
    score: match[2] ? Number(match[2]) : null,
  };
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
          format: "full",
          metadataHeaders: ["From", "Subject", "Date"],
        });
        const messages = full.data.messages || [];
        if (messages.length === 0) continue;

        // Skip threads we initiated (first message from us — outbound)
        const firstHeaders = messages[0].payload?.headers || [];
        const firstFrom = firstHeaders.find((h) => h.name === "From")?.value || "";
        if (firstFrom.toLowerCase().includes(me.toLowerCase())) continue;

        // The applicant is whoever sent the first message
        const { email: fromEmail, name: headerName } = extractEmail(firstFrom);
        const subject = firstHeaders.find((h) => h.name === "Subject")?.value || "(no subject)";
        const date = firstHeaders.find((h) => h.name === "Date")?.value || "";
        const fromName = headerName || fromEmail;

        // Find a github URL anywhere in the thread. Report subjects are also
        // scanned because the applicant's original snippet can omit the URL.
        let githubUsername: string | null = null;
        let reportScore: number | null = null;
        let reportSubject: string | null = null;
        let reportText: string | null = null;
        let reportHtml: string | null = null;
        let hasReport = false;
        for (const msg of messages) {
          const headers = msg.payload?.headers || [];
          const f = headers.find((h) => h.name === "From")?.value || "";
          const subj = headers.find((h) => h.name === "Subject")?.value || "";
          if (f.toLowerCase().includes(me.toLowerCase()) && subj.toLowerCase().startsWith("larp report:")) {
            hasReport = true;
            const info = extractReportInfo(subj);
            githubUsername = githubUsername || info.username;
            reportScore = reportScore ?? info.score;
            reportSubject = reportSubject || subj;
            reportText = reportText || extractBody(msg.payload);
            reportHtml = reportHtml || extractHtml(msg.payload) || null;
          }
          if (!githubUsername) {
            const text = `${msg.snippet || ""} ${subj} ${extractBody(msg.payload)}`;
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
          reportScore,
          reportSubject,
          reportText,
          reportHtml,
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
