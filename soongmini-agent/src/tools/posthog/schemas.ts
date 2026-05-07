import { z } from "zod";

export const queryEventsSchema = z.object({
  event: z.string().optional().describe("조회할 이벤트 이름"),
  after: z.string().optional().describe("조회 시작 일시 (ISO 8601)"),
  before: z.string().optional().describe("조회 종료 일시 (ISO 8601)"),
  limit: z.number().default(100).describe("최대 조회 수"),
});

export const queryInsightsSchema = z.object({
  insight_id: z.string().optional().describe("인사이트 ID (특정 인사이트 조회 시)"),
});

export const queryHogQLSchema = z.object({
  query: z.string().describe("실행할 HogQL 쿼리"),
});

export const getDashboardSchema = z.object({
  dashboard_id: z.string().describe("대시보드 ID"),
});

export const listPersonsSchema = z.object({
  distinct_id: z.string().optional().describe("사용자 식별자"),
  email: z.string().optional().describe("사용자 이메일"),
  limit: z.number().default(100).describe("최대 조회 수"),
});

export const simpleLimitSchema = z.object({
  limit: z.number().default(100).describe("최대 조회 수"),
});

export const resultSchema = z.object({
  result: z.string().describe("API 응답 결과"),
});
