import { Octokit } from "@octokit/rest";
import { logger } from "../../logger.js";

function truncate(text: string, maxLen = 6000): string {
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + "\n... (결과가 너무 길어 잘렸습니다)";
  }
  return text;
}

export class GitHubClient {
  private octokit: Octokit;
  private owner: string;

  constructor(token: string, owner: string) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
  }

  async listRepos(): Promise<string> {
    try {
      const { data } = await this.octokit.repos.listForOrg({
        org: this.owner,
        per_page: 50,
        sort: "updated",
      });
      const repos = data.map((r) => ({
        name: r.name,
        description: r.description,
        language: r.language,
        stars: r.stargazers_count,
        updated_at: r.updated_at,
        default_branch: r.default_branch,
      }));
      return truncate(JSON.stringify(repos, null, 2));
    } catch (e) {
      logger.error("GitHub listRepos failed:", e);
      return "리포지토리 목록 조회에 실패했습니다.";
    }
  }

  async getRepoTree(repo: string, path?: string, branch?: string): Promise<string> {
    try {
      const ref = branch || await this.getDefaultBranch(repo);
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path: path || "",
        ref,
      });
      if (Array.isArray(data)) {
        const items = data.map((item) => ({
          name: item.name,
          type: item.type,
          path: item.path,
        }));
        return truncate(JSON.stringify(items, null, 2));
      }
      return truncate(JSON.stringify(data, null, 2));
    } catch (e) {
      logger.error("GitHub getRepoTree failed:", e);
      return "디렉토리 구조 조회에 실패했습니다.";
    }
  }

  async getFileContent(repo: string, path: string, branch?: string): Promise<string> {
    try {
      const ref = branch || await this.getDefaultBranch(repo);
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo,
        path,
        ref,
      });
      if ("content" in data && "encoding" in data) {
        const content = Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf-8");
        return truncate(content, 8000);
      }
      return "파일 내용을 읽을 수 없습니다 (디렉토리입니다).";
    } catch (e) {
      logger.error("GitHub getFileContent failed:", e);
      return "파일 내용 조회에 실패했습니다.";
    }
  }

  async getReadme(repo: string, branch?: string): Promise<string> {
    try {
      const ref = branch || await this.getDefaultBranch(repo);
      const { data } = await this.octokit.repos.getReadme({
        owner: this.owner,
        repo,
        ref,
      });
      const content = Buffer.from(data.content, data.encoding as BufferEncoding).toString("utf-8");
      return truncate(content, 8000);
    } catch (e) {
      logger.error("GitHub getReadme failed:", e);
      return "README 조회에 실패했습니다.";
    }
  }

  async listPullRequests(repo: string, state?: string, limit?: number): Promise<string> {
    try {
      const { data } = await this.octokit.pulls.list({
        owner: this.owner,
        repo,
        state: (state as "open" | "closed" | "all") || "open",
        per_page: limit || 20,
        sort: "updated",
        direction: "desc",
      });
      const prs = data.map((pr) => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        user: pr.user?.login,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: pr.merged_at,
        labels: pr.labels.map((l) => l.name),
        draft: pr.draft,
        url: pr.html_url,
      }));
      return truncate(JSON.stringify(prs, null, 2));
    } catch (e) {
      logger.error("GitHub listPullRequests failed:", e);
      return "PR 목록 조회에 실패했습니다.";
    }
  }

  async getPullRequest(repo: string, number: number): Promise<string> {
    try {
      const [prRes, filesRes, reviewsRes] = await Promise.all([
        this.octokit.pulls.get({ owner: this.owner, repo, pull_number: number }),
        this.octokit.pulls.listFiles({ owner: this.owner, repo, pull_number: number, per_page: 50 }),
        this.octokit.pulls.listReviews({ owner: this.owner, repo, pull_number: number, per_page: 20 }),
      ]);

      const pr = prRes.data;
      const result = {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        body: truncate(pr.body || "", 2000),
        user: pr.user?.login,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        merged_at: pr.merged_at,
        labels: pr.labels.map((l) => l.name),
        draft: pr.draft,
        additions: pr.additions,
        deletions: pr.deletions,
        changed_files: pr.changed_files,
        base: pr.base.ref,
        head: pr.head.ref,
        url: pr.html_url,
        files: filesRes.data.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
        reviews: reviewsRes.data.map((r) => ({
          user: r.user?.login,
          state: r.state,
          body: truncate(r.body || "", 500),
        })),
      };
      return truncate(JSON.stringify(result, null, 2), 8000);
    } catch (e) {
      logger.error("GitHub getPullRequest failed:", e);
      return "PR 상세 조회에 실패했습니다.";
    }
  }

  async listCommits(repo: string, branch?: string, limit?: number): Promise<string> {
    try {
      const { data } = await this.octokit.repos.listCommits({
        owner: this.owner,
        repo,
        sha: branch,
        per_page: limit || 20,
      });
      const commits = data.map((c) => ({
        sha: c.sha.slice(0, 7),
        message: c.commit.message.split("\n")[0],
        author: c.commit.author?.name || c.author?.login,
        date: c.commit.author?.date,
        url: c.html_url,
      }));
      return truncate(JSON.stringify(commits, null, 2));
    } catch (e) {
      logger.error("GitHub listCommits failed:", e);
      return "커밋 이력 조회에 실패했습니다.";
    }
  }

  async searchCode(query: string, repo?: string): Promise<string> {
    try {
      const q = repo ? `${query} repo:${this.owner}/${repo}` : `${query} org:${this.owner}`;
      const { data } = await this.octokit.search.code({
        q,
        per_page: 15,
      });
      const results = data.items.map((item) => ({
        repository: item.repository?.full_name,
        path: item.path,
        name: item.name,
        url: item.html_url,
      }));
      return truncate(JSON.stringify({ total_count: data.total_count, items: results }, null, 2));
    } catch (e) {
      logger.error("GitHub searchCode failed:", e);
      return "코드 검색에 실패했습니다.";
    }
  }

  async listIssues(repo: string, state?: string, limit?: number): Promise<string> {
    try {
      const { data } = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo,
        state: (state as "open" | "closed" | "all") || "open",
        per_page: limit || 20,
        sort: "updated",
        direction: "desc",
      });
      const issues = data.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        user: i.user?.login,
        labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
        created_at: i.created_at,
        updated_at: i.updated_at,
        comments: i.comments,
        url: i.html_url,
      }));
      return truncate(JSON.stringify(issues, null, 2));
    } catch (e) {
      logger.error("GitHub listIssues failed:", e);
      return "이슈 목록 조회에 실패했습니다.";
    }
  }

  async getIssue(repo: string, number: number): Promise<string> {
    try {
      const { data } = await this.octokit.issues.get({
        owner: this.owner,
        repo,
        issue_number: number,
      });
      const result = {
        number: data.number,
        title: data.title,
        state: data.state,
        body: truncate(data.body || "", 4000),
        user: data.user?.login,
        labels: data.labels.map((l) => (typeof l === "string" ? l : l.name)),
        assignees: data.assignees?.map((a) => a.login),
        created_at: data.created_at,
        updated_at: data.updated_at,
        comments: data.comments,
        url: data.html_url,
      };
      return truncate(JSON.stringify(result, null, 2));
    } catch (e) {
      logger.error("GitHub getIssue failed:", e);
      return "이슈 상세 조회에 실패했습니다.";
    }
  }

  async listBranches(repo: string, limit?: number): Promise<string> {
    try {
      const { data } = await this.octokit.repos.listBranches({
        owner: this.owner,
        repo,
        per_page: limit || 30,
      });
      const branches = data.map((b) => ({
        name: b.name,
        protected: b.protected,
      }));
      return truncate(JSON.stringify(branches, null, 2));
    } catch (e) {
      logger.error("GitHub listBranches failed:", e);
      return "브랜치 목록 조회에 실패했습니다.";
    }
  }

  async getRepoInfo(repo: string): Promise<string> {
    try {
      const { data } = await this.octokit.repos.get({
        owner: this.owner,
        repo,
      });
      const result = {
        name: data.name,
        full_name: data.full_name,
        description: data.description,
        language: data.language,
        stars: data.stargazers_count,
        forks: data.forks_count,
        open_issues: data.open_issues_count,
        default_branch: data.default_branch,
        created_at: data.created_at,
        updated_at: data.updated_at,
        pushed_at: data.pushed_at,
        topics: data.topics,
        license: data.license?.name,
        url: data.html_url,
      };
      return JSON.stringify(result, null, 2);
    } catch (e) {
      logger.error("GitHub getRepoInfo failed:", e);
      return "리포지토리 정보 조회에 실패했습니다.";
    }
  }

  private async getDefaultBranch(repo: string): Promise<string> {
    const { data } = await this.octokit.repos.get({ owner: this.owner, repo });
    return data.default_branch;
  }
}
