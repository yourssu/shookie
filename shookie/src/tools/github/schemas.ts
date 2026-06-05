import { z } from "zod";

export const repoParamSchema = z.object({
  repo: z.string().describe("리포지토리 이름 (예: soongpt-web)"),
});

export const pathParamSchema = z.object({
  repo: z
    .string()
    .describe(
      "리포지토리 이름. 반드시 'soongpt-web' 또는 'soongpt-backend' 중 하나여야 합니다. " +
        "절대 파일 경로나 디렉토리 경로를 넣지 마세요. 예: soongpt-web (O), src/index.ts (X)"
    ),
  path: z
    .string()
    .describe(
      "리포지토리 내 파일 또는 디렉토리의 경로. repo 아래의 상대경로입니다. " +
        "예: src/index.ts, src/main/kotlin/, package.json"
    ),
  branch: z.string().optional().describe("브랜치 이름 (기본: default branch)"),
});

export const listPullRequestsSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  state: z.enum(["open", "closed", "all"]).default("open").describe("PR 상태 필터"),
  limit: z.number().default(20).describe("최대 조회 수"),
});

export const getPullRequestSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  number: z.number().describe("PR 번호"),
});

export const listCommitsSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  branch: z.string().optional().describe("브랜치 이름"),
  limit: z.number().default(20).describe("최대 조회 수"),
});

export const searchCodeSchema = z.object({
  query: z.string().describe("검색어"),
  repo: z.string().optional().describe("특정 리포지토리로 제한 (미지정 시 조직 전체 검색)"),
});

export const listIssuesSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  state: z.enum(["open", "closed", "all"]).default("open").describe("이슈 상태 필터"),
  limit: z.number().default(20).describe("최대 조회 수"),
});

export const getIssueSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  number: z.number().describe("이슈 번호"),
});

export const listBranchesSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  limit: z.number().default(30).describe("최대 조회 수"),
});

export const getReadmeSchema = z.object({
  repo: z.string().describe("리포지토리 이름"),
  branch: z.string().optional().describe("브랜치 이름"),
});

export const resultSchema = z.object({
  result: z.string().describe("API 응답 결과"),
});
