import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { GitHubClient } from "./client.js";
import {
  repoParamSchema,
  pathParamSchema,
  listPullRequestsSchema,
  getPullRequestSchema,
  listCommitsSchema,
  searchCodeSchema,
  listIssuesSchema,
  getIssueSchema,
  listBranchesSchema,
  getReadmeSchema,
  resultSchema,
} from "./schemas.js";

export function createGitHubTools(client: GitHubClient) {
  return {
    listRepos: createTool({
      id: "list-repos",
      description: "접근 가능한 리포지토리 목록을 조회합니다.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      execute: async () => {
        return { result: await client.listRepos() };
      },
    }),

    getRepoInfo: createTool({
      id: "get-repo-info",
      description: "특정 리포지토리의 상세 정보를 조회합니다.",
      inputSchema: repoParamSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.getRepoInfo(input.repo) };
      },
    }),

    getRepoTree: createTool({
      id: "get-repo-tree",
      description: "리포지토리의 디렉토리 구조를 탐색합니다. path를 생략하면 루트 디렉토리를 보여줍니다.",
      inputSchema: pathParamSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.getRepoTree(input.repo, input.path, input.branch) };
      },
    }),

    getFileContent: createTool({
      id: "get-file-content",
      description: "특정 파일의 내용을 읽어옵니다.",
      inputSchema: pathParamSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.getFileContent(input.repo, input.path, input.branch) };
      },
    }),

    getReadme: createTool({
      id: "get-readme",
      description: "리포지토리의 README.md 내용을 조회합니다.",
      inputSchema: getReadmeSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.getReadme(input.repo, input.branch) };
      },
    }),

    listPullRequests: createTool({
      id: "list-pull-requests",
      description: "리포지토리의 Pull Request 목록을 조회합니다.",
      inputSchema: listPullRequestsSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.listPullRequests(input.repo, input.state, input.limit) };
      },
    }),

    getPullRequest: createTool({
      id: "get-pull-request",
      description: "특정 PR의 상세 정보(변경 파일, 리뷰, 추가/삭제 라인 수)를 조회합니다.",
      inputSchema: getPullRequestSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.getPullRequest(input.repo, input.number) };
      },
    }),

    listCommits: createTool({
      id: "list-commits",
      description: "리포지토리의 최근 커밋 이력을 조회합니다.",
      inputSchema: listCommitsSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.listCommits(input.repo, input.branch, input.limit) };
      },
    }),

    searchCode: createTool({
      id: "search-code",
      description: "리포지토리 내 코드를 검색합니다.",
      inputSchema: searchCodeSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.searchCode(input.query, input.repo) };
      },
    }),

    listIssues: createTool({
      id: "list-issues",
      description: "리포지토리의 이슈 목록을 조회합니다.",
      inputSchema: listIssuesSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.listIssues(input.repo, input.state, input.limit) };
      },
    }),

    getIssue: createTool({
      id: "get-issue",
      description: "특정 이슈의 상세 내용을 조회합니다.",
      inputSchema: getIssueSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.getIssue(input.repo, input.number) };
      },
    }),

    listBranches: createTool({
      id: "list-branches",
      description: "리포지토리의 브랜치 목록을 조회합니다.",
      inputSchema: listBranchesSchema,
      outputSchema: resultSchema,
      execute: async (input) => {
        return { result: await client.listBranches(input.repo, input.limit) };
      },
    }),
  };
}
