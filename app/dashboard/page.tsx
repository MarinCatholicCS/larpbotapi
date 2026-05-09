"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LogOut, ExternalLink, RefreshCw, Inbox, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AnalysisResult } from "@/lib/types";

interface CandidateRow {
  github_username: string;
  larp_score: number | null;
  analyzed_at: string;
}

interface InboxThread {
  threadId: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  snippet: string;
  date: string;
  githubUsername: string | null;
  hasReport: boolean;
}

function scoreColor(n: number | null) {
  if (n === null) return "#64748b";
  if (n >= 70) return "#ef4444";
  if (n >= 40) return "#f97316";
  return "#4ade80";
}

function verdictFromScore(n: number | null): "CONTRADICTED" | "UNVERIFIED" | "SUPPORTED" | "PENDING" {
  if (n === null) return "PENDING";
  if (n >= 70) return "CONTRADICTED";
  if (n >= 40) return "UNVERIFIED";
  return "SUPPORTED";
}

const verdictStyle: Record<string, string> = {
  CONTRADICTED: "bg-red-950/60 text-red-400 border border-red-900",
  UNVERIFIED: "bg-yellow-950/60 text-yellow-400 border border-yellow-900",
  SUPPORTED: "bg-green-950/60 text-green-400 border border-green-900",
  PENDING: "bg-slate-800 text-slate-400 border border-slate-700",
};

function formatDate(iso: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

function Initials({ name }: { name: string }) {
  const letters = name.replace(/[^a-zA-Z]/g, "").slice(0, 2).toUpperCase() || "??";
  return (
    <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold text-slate-300 flex-shrink-0">
      {letters}
    </div>
  );
}

interface MergedRow {
  username: string;
  fromEmail: string | null;
  fromName: string | null;
  subject: string | null;
  larpScore: number | null;
  threadId: string | null;
  date: string;
  hasReport: boolean;
}

function mergeData(candidates: CandidateRow[], threads: InboxThread[]): MergedRow[] {
  const byUser = new Map<string, MergedRow>();

  for (const c of candidates) {
    byUser.set(c.github_username.toLowerCase(), {
      username: c.github_username,
      fromEmail: null,
      fromName: null,
      subject: null,
      larpScore: c.larp_score,
      threadId: null,
      date: c.analyzed_at,
      hasReport: true,
    });
  }

  for (const t of threads) {
    const u = (t.githubUsername || "").toLowerCase();
    const existing = u ? byUser.get(u) : undefined;
    if (existing) {
      existing.fromEmail = t.fromEmail;
      existing.fromName = t.fromName;
      existing.subject = t.subject;
      existing.threadId = t.threadId;
      if (!existing.date) existing.date = t.date;
    } else {
      // Pending — emailed in but no LARP report yet
      const key = u || `__thread_${t.threadId}`;
      byUser.set(key, {
        username: t.githubUsername || "(no github)",
        fromEmail: t.fromEmail,
        fromName: t.fromName,
        subject: t.subject,
        larpScore: null,
        threadId: t.threadId,
        date: t.date,
        hasReport: t.hasReport,
      });
    }
  }

  return Array.from(byUser.values()).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
}

export default function Dashboard() {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [inbox, setInbox] = useState<string>("tungtungrecruiting@gmail.com");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ row: MergedRow; result: AnalysisResult | null } | null>(null);

  async function load() {
    setRefreshing(true);
    setError(null);
    try {
      const [cRes, iRes] = await Promise.all([
        fetch("/api/candidates"),
        fetch("/api/inbox"),
      ]);
      if (cRes.ok) {
        const data = await cRes.json();
        setCandidates(Array.isArray(data) ? data : []);
      }
      if (iRes.ok) {
        const data = await iRes.json();
        setThreads(data.threads || []);
        if (data.inbox) setInbox(data.inbox);
      } else {
        const data = await iRes.json().catch(() => ({}));
        setError(data.error || "Failed to load inbox");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function openCandidate(row: MergedRow) {
    setSelected({ row, result: null });
    if (!row.hasReport || row.username === "(no github)") return;
    try {
      const res = await fetch("/api/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUsername: row.username }),
      });
      if (res.ok) {
        const data = await res.json();
        setSelected({ row, result: data });
      }
    } catch {
      /* ignore */
    }
  }

  const rows = mergeData(candidates, threads);
  const stats = {
    total: rows.length,
    withReport: rows.filter((r) => r.hasReport).length,
    pending: rows.filter((r) => !r.hasReport && r.username !== "(no github)").length,
    avgScore:
      rows.filter((r) => r.larpScore !== null).reduce((s, r) => s + (r.larpScore || 0), 0) /
        Math.max(1, rows.filter((r) => r.larpScore !== null).length) || 0,
  };

  return (
    <div className="h-screen overflow-hidden bg-slate-900 text-white font-sans flex flex-col">
      {/* Nav */}
      <nav className="flex-shrink-0 flex items-center justify-between px-8 py-4 border-b border-slate-800">
        <Link href="/" className="text-lg font-bold tracking-tight" style={{ fontFamily: "var(--font-orbitron)" }}>
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-violet-400">
            LARP
          </span>
          <span className="text-white">bot</span>
        </Link>
        <div className="flex items-center gap-4">
          <span className="text-xs text-slate-500 flex items-center gap-1.5">
            <Inbox size={12} /> {inbox}
          </span>
          <button
            onClick={load}
            disabled={refreshing}
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors disabled:text-slate-600"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            Refresh
          </button>
          <Link
            href="/"
            className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white transition-colors"
          >
            <LogOut size={13} />
            Sign out
          </Link>
        </div>
      </nav>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight" style={{ fontFamily: "var(--font-orbitron)" }}>
                Dashboard
              </h1>
              <p className="text-sm text-slate-500 mt-0.5">
                Applicants who emailed{" "}
                <span className="text-slate-400 font-mono">{inbox}</span>
              </p>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-4 gap-3">
            <Stat label="Threads" value={stats.total} />
            <Stat label="With Report" value={stats.withReport} />
            <Stat label="Pending" value={stats.pending} />
            <Stat
              label="Avg LARP"
              value={Math.round(stats.avgScore)}
              colored
            />
          </div>

          {error && (
            <div className="bg-red-950/40 border border-red-900 rounded p-3 text-sm text-red-300">
              {error}
            </div>
          )}

          {/* Table */}
          <div className="bg-slate-800/30 border border-slate-700/60 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700/60 text-[0.65rem] uppercase tracking-widest text-slate-500">
                  <th className="text-left px-5 py-3 font-semibold">Applicant</th>
                  <th className="text-left px-5 py-3 font-semibold">GitHub</th>
                  <th className="text-left px-5 py-3 font-semibold">Email subject</th>
                  <th className="text-left px-5 py-3 font-semibold">Verdict</th>
                  <th className="text-left px-5 py-3 font-semibold">LARP score</th>
                  <th className="text-left px-5 py-3 font-semibold">Date</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-slate-500 text-sm">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-12 text-center text-slate-500 text-sm">
                      No applicants yet. Recruiters email{" "}
                      <span className="font-mono text-slate-400">{inbox}</span> with a
                      github.com/&lt;user&gt; URL to get started.
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => {
                  const verdict = verdictFromScore(r.larpScore);
                  return (
                    <tr
                      key={r.threadId || r.username || i}
                      className={cn(
                        "border-b border-slate-700/40 hover:bg-slate-700/20 transition-colors cursor-pointer",
                        i === rows.length - 1 && "border-b-0"
                      )}
                      onClick={() => openCandidate(r)}
                    >
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          <Initials name={r.fromName || r.username} />
                          <div>
                            <div className="font-semibold text-slate-200">
                              {r.fromName || r.username}
                            </div>
                            <div className="text-[0.7rem] text-slate-500 flex items-center gap-1">
                              <Mail size={9} /> {r.fromEmail || "—"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        {r.username !== "(no github)" ? (
                          <a
                            href={`https://github.com/${r.username}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-xs text-slate-400 hover:text-sky-400 font-mono"
                          >
                            {r.username}
                          </a>
                        ) : (
                          <span className="text-xs text-slate-600">none</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-slate-400 text-xs truncate max-w-[200px]">
                        {r.subject || "—"}
                      </td>
                      <td className="px-5 py-3.5">
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-[0.65rem] font-bold uppercase tracking-wider",
                            verdictStyle[verdict]
                          )}
                        >
                          {verdict}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {r.larpScore !== null ? (
                          <div className="flex items-center gap-2">
                            <div className="w-16 h-1.5 bg-slate-700 rounded overflow-hidden">
                              <div
                                className="h-full rounded"
                                style={{
                                  width: `${r.larpScore}%`,
                                  background: scoreColor(r.larpScore),
                                }}
                              />
                            </div>
                            <span
                              className="font-bold tabular-nums text-xs"
                              style={{ color: scoreColor(r.larpScore) }}
                            >
                              {r.larpScore}
                            </span>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-slate-500 text-xs">
                        {formatDate(r.date)}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          {r.hasReport ? "View" : "Open"} <ExternalLink size={11} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Drawer */}
      {selected && (
        <ReportDrawer
          row={selected.row}
          result={selected.result}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, colored }: { label: string; value: number; colored?: boolean }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/60 rounded-xl px-5 py-4">
      <div className="text-[0.65rem] uppercase tracking-widest text-slate-500 font-semibold mb-1">
        {label}
      </div>
      <div
        className="text-3xl font-black tabular-nums"
        style={colored ? { color: scoreColor(value) } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function ReportDrawer({
  row,
  result,
  onClose,
}: {
  row: MergedRow;
  result: AnalysisResult | null;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex justify-end"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl h-full bg-slate-900 border-l border-slate-800 overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-white">
              {row.fromName || row.username}
            </h2>
            <p className="text-xs text-slate-500 font-mono mt-0.5">{row.fromEmail}</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {!row.hasReport && (
          <div className="bg-slate-800 border border-slate-700 rounded p-4 text-sm text-slate-400">
            No LARP Report yet — applicant emailed in but the agent hasn&apos;t finished
            processing (or the email had no GitHub URL).
          </div>
        )}

        {row.hasReport && !result && (
          <div className="text-sm text-slate-500">Loading report…</div>
        )}

        {result && <InlineReport result={result} />}
      </div>
    </div>
  );
}

function InlineReport({ result }: { result: AnalysisResult }) {
  const score = result.overallLarpScore;
  const color = scoreColor(score);
  return (
    <div className="space-y-5">
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-5">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-widest text-slate-500">LARP Score</span>
          <span className="text-3xl font-black tabular-nums" style={{ color }}>
            {score}
            <span className="text-base text-slate-600">/100</span>
          </span>
        </div>
        <p className="text-sm text-slate-300 italic mt-3">&ldquo;{result.overallVerdict}&rdquo;</p>
      </div>

      {result.niaIndexedRepos && result.niaIndexedRepos.length > 0 && (
        <div className="bg-slate-800/40 border border-indigo-900/40 rounded-xl p-4">
          <p className="text-[0.65rem] uppercase tracking-widest text-indigo-300 mb-2">
            Indexed by Nia ({result.niaQueriedRepos?.length ?? 0} of {result.niaIndexedRepos.length} queried)
          </p>
          <ul className="space-y-1">
            {result.niaIndexedRepos.map((slug) => {
              const queried = result.niaQueriedRepos?.includes(slug);
              return (
                <li key={slug} className="flex items-center gap-2 text-xs">
                  <span className={queried ? "text-indigo-400" : "text-slate-600"}>
                    {queried ? "✓" : "·"}
                  </span>
                  <a
                    href={`https://github.com/${slug}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "font-mono",
                      queried ? "text-indigo-300" : "text-slate-500"
                    )}
                  >
                    {slug}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div>
        <p className="text-[0.65rem] uppercase tracking-widest text-slate-500 mb-2">
          Claims ({result.claims.length})
        </p>
        <div className="space-y-3">
          {result.claims.map((c, i) => (
            <div
              key={i}
              className="bg-slate-800/40 border border-slate-700 rounded p-3 space-y-2"
            >
              <p className="text-sm text-slate-200 font-medium">&ldquo;{c.claim}&rdquo;</p>
              <div className="flex items-center gap-2 text-xs">
                <span
                  className={cn(
                    "px-1.5 py-0.5 rounded font-bold",
                    c.verdict === "VERIFIED"
                      ? "bg-green-950/60 text-green-400 border border-green-900"
                      : c.verdict === "PARTIAL"
                      ? "bg-yellow-950/60 text-yellow-400 border border-yellow-900"
                      : "bg-red-950/60 text-red-400 border border-red-900"
                  )}
                >
                  {c.verdict}
                </span>
                <span className="text-slate-500">{Math.round(c.confidence * 100)}%</span>
              </div>
              <p className="text-xs text-slate-400">{c.summary}</p>
              {c.receipts.length > 0 && (
                <div className="space-y-1.5 pt-1">
                  {c.receipts.map((r, j) => (
                    <div key={j}>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-slate-400 hover:text-sky-400 font-mono"
                      >
                        ◆ {r.label}
                      </a>
                      {r.snippet && (
                        <pre className="ml-3 mt-1 px-2 py-1 bg-black border border-slate-800 rounded text-[10px] text-slate-300 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
                          {r.snippet.length > 240 ? r.snippet.slice(0, 240) + "…" : r.snippet}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
