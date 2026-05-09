"use client";

import { useState } from "react";
import { AnalysisResult, StatusResponse } from "@/lib/types";
import ResultsPanel from "@/components/ResultsPanel";
import ProgressCard from "@/components/ProgressCard";

type Phase = "idle" | "loading" | "done" | "error";

export default function Home() {
  const [username, setUsername] = useState("");
  const [claims, setClaims] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPhase("loading");
    setStatus(null);
    setResult(null);
    setErrorMsg("");

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubUsername: username.trim(), claims }),
      });
      const { jobId } = await res.json();
      await pollStatus(jobId);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Unknown error");
      setPhase("error");
    }
  }

  async function pollStatus(jobId: string) {
    return new Promise<void>((resolve) => {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/status/${jobId}`);
          const data: StatusResponse = await res.json();
          setStatus(data);

          if (data.stage === "complete") {
            clearInterval(interval);
            const parsed: AnalysisResult = JSON.parse(data.message);
            setResult(parsed);
            setPhase("done");
            resolve();
          } else if (data.stage === "error") {
            clearInterval(interval);
            setErrorMsg(data.message);
            setPhase("error");
            resolve();
          }
        } catch {
          clearInterval(interval);
          setErrorMsg("Lost connection to server.");
          setPhase("error");
          resolve();
        }
      }, 2000);
    });
  }

  async function loadDemo() {
    setPhase("loading");
    setStatus({ jobId: "demo", stage: "analyzing", progress: 80, message: "Loading demo data..." });
    await new Promise((r) => setTimeout(r, 600));
    const res = await fetch("/demo.json");
    const data = await res.json();
    setResult(data);
    setPhase("done");
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100 font-mono">
      <div className="max-w-3xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-2xl font-bold tracking-tight text-white">LARPbot</span>
            <span className="text-xs bg-red-900/50 text-red-400 border border-red-800 px-2 py-0.5 rounded">
              BETA
            </span>
          </div>
          <p className="text-zinc-400 text-sm leading-relaxed">
            AI didn&apos;t kill resume fraud — it accelerated it.
            <br />
            Paste a GitHub username and their claims. We&apos;ll check the receipts.
          </p>
        </div>

        {/* Form */}
        {phase === "idle" && (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">
                GitHub Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="stananan"
                required
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500 uppercase tracking-widest block mb-1">
                Claims to Verify
              </label>
              <textarea
                value={claims}
                onChange={(e) => setClaims(e.target.value)}
                placeholder="Says they have 3 years of React experience and built a production ML pipeline. Claims to have led the backend architecture for a real-time system."
                required
                rows={4}
                className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600 resize-none"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="submit"
                className="flex-1 bg-white text-zinc-950 rounded px-4 py-2 text-sm font-semibold hover:bg-zinc-200 transition-colors"
              >
                Investigate
              </button>
              <button
                type="button"
                onClick={loadDemo}
                className="px-4 py-2 text-sm text-zinc-500 border border-zinc-800 rounded hover:border-zinc-600 hover:text-zinc-300 transition-colors"
              >
                Load demo
              </button>
            </div>
          </form>
        )}

        {/* Loading */}
        {phase === "loading" && status && <ProgressCard status={status} />}

        {/* Error */}
        {phase === "error" && (
          <div className="bg-red-950/30 border border-red-900 rounded p-4 text-sm text-red-400">
            <span className="font-semibold">Error: </span>{errorMsg}
            <button
              onClick={() => setPhase("idle")}
              className="block mt-3 text-xs text-zinc-500 underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* Results */}
        {phase === "done" && result && (
          <ResultsPanel
            result={result}
            onReset={() => { setPhase("idle"); setResult(null); }}
          />
        )}
      </div>
    </main>
  );
}
