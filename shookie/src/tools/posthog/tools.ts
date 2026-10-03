import { createTool } from "@mastra/core/tools";
import { PostHogClientManager, type PostHogClient } from "./client.js";
import {
  queryEventsSchema,
  queryInsightsSchema,
  queryHogQLSchema,
  getDashboardSchema,
  listPersonsSchema,
  simpleLimitSchema,
  noInputSchema,
  resultSchema,
  type PostHogResult,
} from "./schemas.js";

export function createPostHogTools(manager: PostHogClientManager) {
  async function run(project: string | undefined, action: (client: PostHogClient) => Promise<PostHogResult>): Promise<PostHogResult> {
    let client: PostHogClient;
    try { client = manager.getClient(project); }
    catch { return { status: "error", data: null, source: { project: project ?? manager.getDefaultName(), projectId: "", resource: "project", fetchedAt: new Date().toISOString() }, error: { code: "unknown_project", message: "프로젝트 이름을 확인해 주세요.", retryable: false } }; }
    return action(client);
  }
  return {
    queryEvents: createTool({
      id: "query-events",
      description: "PostHog 이벤트 목록을 조회합니다.",
      inputSchema: queryEventsSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.queryEvents(input);
      }),
    }),
    queryInsights: createTool({
      id: "query-insights",
      description: "PostHog 인사이트(분석 리포트)를 조회합니다.",
      inputSchema: queryInsightsSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.queryInsights(input.insight_id, input);
      }),
    }),
    listFeatureFlags: createTool({
      id: "list-feature-flags",
      description: "PostHog 기능 플래그 목록을 조회합니다.",
      inputSchema: noInputSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.listFeatureFlags(input);
      }),
    }),
    listDashboards: createTool({
      id: "list-dashboards",
      description: "PostHog 대시보드 목록을 조회합니다.",
      inputSchema: noInputSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.listDashboards(input);
      }),
    }),
    getDashboard: createTool({
      id: "get-dashboard",
      description: "특정 PostHog 대시보드의 상세 정보와 포함된 인사이트를 조회합니다.",
      inputSchema: getDashboardSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.getDashboard(input.dashboard_id);
      }),
    }),
    queryHogQL: createTool({
      id: "query-hogql",
      description: "HogQL 쿼리를 실행합니다.",
      inputSchema: queryHogQLSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.queryHogQL(input.query);
      }),
    }),
    listPersons: createTool({
      id: "list-persons",
      description: "PostHog 사용자를 조회합니다.",
      inputSchema: listPersonsSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.listPersons({ distinctId: input.distinct_id, email: input.email, limit: input.limit, continuation: input.continuation });
      }),
    }),
    listCohorts: createTool({
      id: "list-cohorts",
      description: "PostHog 코호트(사용자 그룹) 목록을 조회합니다.",
      inputSchema: simpleLimitSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.listCohorts(input.limit, input.continuation);
      }),
    }),
    listExperiments: createTool({
      id: "list-experiments",
      description: "PostHog 실험(A/B 테스트) 목록을 조회합니다.",
      inputSchema: simpleLimitSchema,
      outputSchema: resultSchema,
      execute: async (input) => run(input.project, async (client) => {
        return client.listExperiments(input.limit, input.continuation);
      }),
    }),
  };
}
