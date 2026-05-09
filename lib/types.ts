export interface Receipt {
  type: "commit" | "file" | "repo" | "pattern";
  label: string;
  detail: string;
  url: string;
}

export interface ClaimVerification {
  claim: string;
  verdict: "VERIFIED" | "PARTIAL" | "UNVERIFIED" | "CONTRADICTED";
  confidence: number;
  summary: string;
  evidence: string;
  receipts: Receipt[];
  whatToAskNext: string;
}

export interface AnalysisResult {
  candidate: string;
  githubUrl: string;
  analyzedRepos: string[];
  overallLarpScore: number;
  overallVerdict: string;
  subscores: {
    skillInflation: number;
    projectSubstance: number;
    roleAuthenticity: number;
    codeDepth: number;
  };
  claims: ClaimVerification[];
  redemption: string;
  analyzedAt: string;
  /** True if Nia returned at least one substantive search result during verification. */
  niaVerified?: boolean;
}

export interface StatusResponse {
  jobId: string;
  stage: "fetching_repos" | "indexing" | "analyzing" | "complete" | "error";
  progress: number;
  message: string;
}
