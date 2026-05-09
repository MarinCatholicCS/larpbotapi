import { StatusResponse } from "./types";

// In-memory job store (sufficient for hackathon demo; resets on cold start)
const jobs = new Map<string, StatusResponse>();

export function createJob(jobId: string): void {
  jobs.set(jobId, {
    jobId,
    stage: "fetching_repos",
    progress: 0,
    message: "Starting analysis...",
  });
}

export function updateJob(jobId: string, patch: Partial<Omit<StatusResponse, "jobId">>): void {
  const existing = jobs.get(jobId);
  if (existing) jobs.set(jobId, { ...existing, ...patch });
}

export function getJob(jobId: string): StatusResponse | undefined {
  return jobs.get(jobId);
}
