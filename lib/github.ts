const GITHUB_API = "https://api.github.com";

function headers() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface RepoMeta {
  name: string;
  fullName: string;
  url: string;
  htmlUrl: string;
  description: string | null;
  language: string | null;
  languages: Record<string, number>;
  stars: number;
  forks: number;
  commitCount: number;
  lastCommit: string | null;
  topics: string[];
  createdAt: string;
}

export interface CommitSample {
  sha: string;
  message: string;
  date: string;
  url: string;
}

async function ghFetch(path: string) {
  const res = await fetch(`${GITHUB_API}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub API ${path} → ${res.status}`);
  return res.json();
}

export async function getTopRepos(username: string, limit = 5): Promise<RepoMeta[]> {
  const repos = await ghFetch(
    `/users/${username}/repos?type=owner&sort=pushed&per_page=100`
  );

  const nonForks = repos
    .filter((r: { fork: boolean }) => !r.fork)
    .sort(
      (a: { stargazers_count: number; pushed_at: string }, b: { stargazers_count: number; pushed_at: string }) =>
        b.stargazers_count - a.stargazers_count || new Date(b.pushed_at).getTime() - new Date(a.pushed_at).getTime()
    )
    .slice(0, limit);

  return Promise.all(nonForks.map((r: { name: string }) => getRepoMeta(username, r.name)));
}

export async function getRepoMeta(owner: string, repo: string): Promise<RepoMeta> {
  const [repoData, languages, commits] = await Promise.all([
    ghFetch(`/repos/${owner}/${repo}`),
    ghFetch(`/repos/${owner}/${repo}/languages`),
    ghFetch(`/repos/${owner}/${repo}/commits?per_page=1`).catch(() => []),
  ]);

  let commitCount = 0;
  // Extract commit count from Link header isn't reliable here; use contributor stats
  try {
    const contributors = await ghFetch(`/repos/${owner}/${repo}/contributors?per_page=100`);
    commitCount = contributors.reduce(
      (sum: number, c: { contributions: number }) => sum + c.contributions,
      0
    );
  } catch {
    commitCount = 0;
  }

  return {
    name: repoData.name,
    fullName: repoData.full_name,
    url: repoData.clone_url,
    htmlUrl: repoData.html_url,
    description: repoData.description,
    language: repoData.language,
    languages,
    stars: repoData.stargazers_count,
    forks: repoData.forks_count,
    commitCount,
    lastCommit: commits[0]?.commit?.committer?.date ?? null,
    topics: repoData.topics ?? [],
    createdAt: repoData.created_at,
  };
}

export async function getCommitSample(
  owner: string,
  repo: string,
  n = 20
): Promise<CommitSample[]> {
  const commits = await ghFetch(
    `/repos/${owner}/${repo}/commits?per_page=${n}`
  );
  return commits.map((c: {
    sha: string;
    commit: { message: string; committer: { date: string } };
    html_url: string;
  }) => ({
    sha: c.sha.slice(0, 7),
    message: c.commit.message.split("\n")[0].slice(0, 100),
    date: c.commit.committer.date,
    url: c.html_url,
  }));
}

export async function getFileTree(owner: string, repo: string): Promise<string[]> {
  try {
    const tree = await ghFetch(
      `/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`
    );
    return (tree.tree as { path: string; type: string }[])
      .filter((f) => f.type === "blob")
      .map((f) => f.path)
      .slice(0, 200); // cap to avoid huge trees
  } catch {
    return [];
  }
}

export async function getFileContent(
  owner: string,
  repo: string,
  path: string
): Promise<string> {
  const data = await ghFetch(`/repos/${owner}/${repo}/contents/${path}`);
  if (data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8").slice(0, 4000);
  }
  return data.content ?? "";
}
