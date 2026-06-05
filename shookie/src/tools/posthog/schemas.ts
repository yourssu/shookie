import { z } from "zod";

export const projectSchema = z.string().optional().describe("PostHog 프로젝트 이름 (기본: 첫 번째 프로젝트)");

export const queryEventsSchema = z.object({
  project: projectSchema,
  event: z.string().optional().describe("조회할 이벤트 이름"),
  after: z.string().optional().describe("조회 시작 일시 (ISO 8601)"),
  before: z.string().optional().describe("조회 종료 일시 (ISO 8601)"),
  limit: z.number().default(100).describe("최대 조회 수"),
});

export const queryInsightsSchema = z.object({
  project: projectSchema,
  insight_id: z.string().optional().describe("인사이트 ID (특정 인사이트 조회 시)"),
});

export const queryHogQLSchema = z.object({
  project: projectSchema,
  query: z.string().describe("실행할 HogQL 쿼리"),
});

export const getDashboardSchema = z.object({
  project: projectSchema,
  dashboard_id: z.string().describe("대시보드 ID"),
});

export const listPersonsSchema = z.object({
  project: projectSchema,
  distinct_id: z.string().optional().describe("사용자 식별자"),
  email: z.string().optional().describe("사용자 이메일"),
  limit: z.number().default(100).describe("최대 조회 수"),
});

export const simpleLimitSchema = z.object({
  project: projectSchema,
  limit: z.number().default(100).describe("최대 조회 수"),
});

export const noInputSchema = z.object({
  project: projectSchema,
});

export const resultSchema = z.object({
  result: z.string().describe("API 응답 결과"),
});
