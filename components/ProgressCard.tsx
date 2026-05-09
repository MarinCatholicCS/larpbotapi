"use client";

import { Progress } from "@/components/ui/progress";
import { StatusResponse } from "@/lib/types";

const STAGE_LABELS: Record<StatusResponse["stage"], string> = {
  fetching_repos: "Fetching repos",
  indexing: "Indexing with Nia",
  analyzing: "Investigating claims",
  complete: "Done",
  error: "Error",
};

export default function ProgressCard({ status }: { status: StatusResponse }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span className="uppercase tracking-widest">{STAGE_LABELS[status.stage]}</span>
        <span>{status.progress}%</span>
      </div>
      <Progress value={status.progress} className="h-1 bg-zinc-800" />
      <p className="text-sm text-zinc-400 animate-pulse">{status.message}</p>
    </div>
  );
}
