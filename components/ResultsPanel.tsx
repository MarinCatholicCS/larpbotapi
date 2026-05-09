"use client";

import { useEffect, useState } from "react";
import { AnalysisResult, ClaimVerification } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const VERDICT_STYLES: Record<ClaimVerification["verdict"], string> = {
  VERIFIED: "bg-green-900/40 text-green-400 border-green-800",
  PARTIAL: "bg-yellow-900/40 text-yellow-400 border-yellow-800",
  UNVERIFIED: "bg-zinc-800/60 text-zinc-400 border-zinc-700",
  CONTRADICTED: "bg-red-900/40 text-red-400 border-red-800",
};

function ScoreBar({ label, value }: { label: string; value: number }) {
  const color = value < 30 ? "bg-green-500" : value < 60 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-zinc-500">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

function ClaimCard({ claim, index }: { claim: ClaimVerification; index: number }) {
  return (
    <Card className="bg-zinc-900 border-zinc-800">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-zinc-200 leading-snug">&ldquo;{claim.claim}&rdquo;</p>
          <Badge className={`text-xs border shrink-0 ${VERDICT_STYLES[claim.verdict]}`}>
            {claim.verdict}
          </Badge>
        </div>
        <p className="text-xs text-zinc-500">
          Confidence: {Math.round(claim.confidence * 100)}%
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-zinc-300">{claim.summary}</p>
        <div className="bg-zinc-950 border border-zinc-800 rounded p-3">
          <p className="text-xs text-zinc-500 mb-1 uppercase tracking-widest">Evidence</p>
          <p className="text-xs text-zinc-400 leading-relaxed">{claim.evidence}</p>
        </div>
        {claim.receipts.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-zinc-500 uppercase tracking-widest">Receipts</p>
            {claim.receipts.map((r, i) => (
              <div key={i} className="space-y-1">
                <a
                  href={r.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors group"
                >
                  <span className="text-zinc-600 shrink-0 mt-0.5">
                    {r.type === "commit" ? "●" : r.type === "file" ? "◆" : r.type === "pattern" ? "▲" : "■"}
                  </span>
                  <span>
                    <span className="font-medium text-zinc-300 group-hover:text-white">{r.label}</span>
                    {" — "}
                    {r.detail}
                  </span>
                </a>
                {r.snippet && (
                  <pre className="ml-5 mt-1 px-3 py-2 bg-black border border-zinc-800 rounded text-[11px] text-zinc-300 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto">
                    {r.snippet.length > 400 ? r.snippet.slice(0, 400) + "…" : r.snippet}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-zinc-800 pt-2">
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Ask next</p>
          <p className="text-xs text-zinc-400 italic">{claim.whatToAskNext}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ResultsPanel({
  result,
  onReset,
}: {
  result: AnalysisResult;
  onReset: () => void;
}) {
  const [visibleCount, setVisibleCount] = useState(0);

  // Streaming reveal: show claim cards one by one
  useEffect(() => {
    setVisibleCount(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    result.claims.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleCount(i + 1), i * 400));
    });
    return () => timers.forEach(clearTimeout);
  }, [result]);

  const larpColor =
    result.overallLarpScore < 30
      ? "text-green-400"
      : result.overallLarpScore < 60
      ? "text-yellow-400"
      : "text-red-400";

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <a
              href={result.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-lg font-semibold text-white hover:text-zinc-300 transition-colors"
            >
              {result.candidate}
            </a>
            {result.niaVerified && (
              <span
                className="inline-block bg-indigo-950 border border-indigo-500 text-indigo-300 text-[10px] uppercase tracking-widest px-2 py-0.5 rounded"
                title="Cross-file evidence verified by Nia semantic search"
              >
                ✓ Verified by Nia
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">
            Analyzed {result.analyzedRepos.join(", ")} &middot;{" "}
            {new Date(result.analyzedAt).toLocaleTimeString()}
          </p>
        </div>
        <button
          onClick={onReset}
          className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
        >
          New investigation
        </button>
      </div>

      {/* LARP score */}
      <div className="bg-zinc-900 border border-zinc-800 rounded p-5 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-500 uppercase tracking-widest">LARP Score</span>
          <span className={`text-3xl font-bold tabular-nums ${larpColor}`}>
            {result.overallLarpScore}
            <span className="text-lg text-zinc-600">/100</span>
          </span>
        </div>
        <p className="text-sm text-zinc-300 italic">&ldquo;{result.overallVerdict}&rdquo;</p>
        <div className="space-y-2 pt-2 border-t border-zinc-800">
          <ScoreBar label="Skill Inflation" value={result.subscores.skillInflation} />
          <ScoreBar label="Project Substance" value={result.subscores.projectSubstance} />
          <ScoreBar label="Role Authenticity" value={result.subscores.roleAuthenticity} />
          <ScoreBar label="Code Depth" value={result.subscores.codeDepth} />
        </div>
        <div className="border-t border-zinc-800 pt-3">
          <p className="text-xs text-zinc-500 uppercase tracking-widest mb-1">Redemption</p>
          <p className="text-sm text-zinc-400">{result.redemption}</p>
        </div>
      </div>

      {/* Ask the codebase */}
      <AskCodebase username={result.candidate} repos={result.analyzedRepos} />

      {/* Claims */}
      <div className="space-y-4">
        <p className="text-xs text-zinc-500 uppercase tracking-widest">
          Claims ({result.claims.length})
        </p>
        {result.claims.map((claim, i) =>
          i < visibleCount ? (
            <ClaimCard key={i} claim={claim} index={i} />
          ) : (
            <Skeleton key={i} className="h-24 w-full bg-zinc-900 rounded" />
          )
        )}
      </div>
    </div>
  );
}

interface AskAnswer {
  repo: string;
  slug: string;
  answer: string;
  citations: string[];
}

function AskCodebase({ username, repos }: { username: string; repos: string[] }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [answers, setAnswers] = useState<AskAnswer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    setAnswers(null);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, repos, query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAnswers(data.perRepo as AskAnswer[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-zinc-900 border border-indigo-900/40 rounded p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-indigo-300 uppercase tracking-widest">
          Ask the codebase
        </p>
        <span className="text-[10px] text-zinc-500">powered by Nia</span>
      </div>
      <p className="text-xs text-zinc-500">
        Their {repos.length} top {repos.length === 1 ? "repo is" : "repos are"} indexed.
        Ask anything — semantic search across the actual code.
      </p>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="e.g. Did they write tests? Is the auth real?"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:border-indigo-600 focus:outline-none"
          disabled={loading}
        />
        <button
          onClick={submit}
          disabled={loading || !query.trim()}
          className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm px-4 py-2 rounded transition-colors"
        >
          {loading ? "Asking…" : "Ask"}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">Error: {error}</p>}
      {answers && (
        <div className="space-y-3 pt-2">
          {answers.map((a) => (
            <div key={a.repo} className="border-t border-zinc-800 pt-3">
              <div className="flex items-center justify-between mb-1">
                <a
                  href={`https://github.com/${a.slug}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-mono text-zinc-300 hover:text-white"
                >
                  {a.slug}
                </a>
                {a.citations.length > 0 && (
                  <span className="text-[10px] text-zinc-600">
                    {a.citations.length} {a.citations.length === 1 ? "citation" : "citations"}
                  </span>
                )}
              </div>
              <p className="text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
                {a.answer}
              </p>
              {a.citations.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {a.citations.slice(0, 5).map((c, i) => (
                    <li key={i} className="text-[11px]">
                      <a
                        href={`https://github.com/${c}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300 font-mono"
                      >
                        {c}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
