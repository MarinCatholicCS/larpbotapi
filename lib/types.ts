export interface Receipt {
  type: "commit" | "file" | "repo" | "pattern";
  label: string;
  detail: string;
  url: string;
  /** Optional 1-3 line excerpt from the actual file/commit. Renders in the UI under the link. */
  snippet?: string;
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
  /** owner/repo slugs that Nia actually answered for (a subset of niaIndexedRepos). */
  niaQueriedRepos?: string[];
  /** owner/repo slugs that were indexed by Nia (whether queried or not). */
  niaIndexedRepos?: string[];
}

export interface StatusResponse {
  jobId: string;
  stage: "fetching_repos" | "indexing" | "analyzing" | "complete" | "error";
  progress: number;
  message: string;
}
