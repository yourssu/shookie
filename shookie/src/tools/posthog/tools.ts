import { randomUUID } from "node:crypto";
import { createTool } from "@mastra/core/tools";
import { executionSignal, executionTools } from "../../cancellation/execution-context.js";
import { PostHogClientManager, type PostHogClient } from "./client.js";
import { posthogGuidancePolicy } from "./registry.js";
import {
  queryEventsSchema,
  queryInsightsSchema,
  queryHogQLSchema,
  getDashboardSchema,
  listPersonsSchema,
  simpleLimitSchema,
  noInputSchema,
  resultSchema,
  listProjectsSchema,
  listProjectsResultSchema,
  type ListProjectsResult,
  type PostHogResult,
} from "./schemas.js";

export function createPostHogTools(manager: PostHogClientManager) {
  // Production tools only accept the live registry-backed manager; no static project list.
  if (!(manager instanceof PostHogClientManager)) throw new Error("PostHog registry manager required");
  // Opaque tokens are scoped to this tool instance, authorized project ID and exact action inputs.
  // Provider offsets never cross the production tool boundary.
  const continuations = new Map<string, { projectId: string; scope: string; offset: string; expires: number }>();
  type Context = { abortSignal?: AbortSignal } | undefined;
  async function run(project: string | undefined, context: Context, operation: string, input: Record<string, unknown>, action: (client: PostHogClient, continuation?: string) => Promise<PostHogResult>): Promise<PostHogResult> {
    // Re-authorize against the current Radar catalog before every PostHog request,
    // including continuation pages. Revoked/renamed projects fail here without a PostHog call.
    const auth = await manager.authorize(project, executionSignal(context?.abortSignal));
    if (auth.status === "error") {
      return { status: "error", data: null,
        source: { project: project ?? "", projectId: "", resource: "project", fetchedAt: new Date().toISOString() },
        error: { code: auth.code, message: auth.message, retryable: auth.retryable } };
    }
    const { project: _project, continuation: token, ...filters } = input;
    const scope = JSON.stringify([operation, Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))]);
    let offset: string | undefined;
    if (token !== undefined) {
      const saved = typeof token === "string" ? continuations.get(token) : undefined;
      if (!saved || saved.expires <= Date.now() || saved.projectId !== auth.project.projectId || saved.scope !== scope) {
        return { status: "error", data: null,
          source: { project: auth.project.name, projectId: auth.project.projectId, resource: operation, fetchedAt: new Date().toISOString() },
          error: { code: "invalid_continuation", message: "이전 페이지 토큰의 프로젝트 또는 조회 조건이 달라졌거나 만료되었습니다. 첫 페이지부터 다시 조회하세요.", retryable: false } };
      }
      offset = saved.offset;
    }
    const result = await action(auth.client, offset);
    if (result.status === "success" && result.pagination.continuation) {
      for (const [key, value] of continuations) if (value.expires <= Date.now()) continuations.delete(key);
      while (continuations.size >= 1000) continuations.delete(continuations.keys().next().value!);
      const next = `phc:${randomUUID()}`;
      continuations.set(next, { projectId: auth.project.projectId, scope, offset: result.pagination.continuation, expires: Date.now() + 30 * 60_000 });
      result.pagination.continuation = next;
    }
    return { ...result, guidance: {
      project: auth.project.name, projectId: auth.project.projectId, description: "",
      instructions: "", updatedAt: auth.project.updatedAt,
      selectedImplicitly: auth.implicit, policy: posthogGuidancePolicy,
    } };
  }
  return executionTools({
    listProjects: createTool({
      id: "list-projects",
      description: "Radar에 현재 등록된 PostHog 프로젝트 목록(이름, 식별 metadata)을 페이지 단위로 조회합니다. 등록된 프로젝트만 조회 대상이며 프로젝트 지침 소비는 비활성화되어 있습니다.",
      inputSchema: listProjectsSchema,
      outputSchema: listProjectsResultSchema,
      execute: async (input, context): Promise<ListProjectsResult> => {
        const fetchedAt = new Date().toISOString();
        let catalog;
        try { catalog = await manager.listProjects(executionSignal(context?.abortSignal)); }
        catch {
          return { status: "error", fetchedAt, error: { code: "registry_unavailable", retryable: true,
            message: "Radar PostHog 프로젝트 등록 정보를 확인할 수 없습니다. Radar 설정을 확인하거나 잠시 후 다시 시도하세요." } };
        }
        const page = input.page ?? 1, perPage = input.perPage ?? 20;
        const start = (page - 1) * perPage;
        // Defense in depth: free-text registry fields never enter model-facing previews.
        const projects = catalog.slice(start, start + perPage).map(p => ({
          name: p.name, projectId: p.projectId, description: "", descriptionTruncated: false,
          instructionsPreview: "", instructionsTruncated: false, updatedAt: p.updatedAt,
        }));
        const message = !catalog.length ? "Radar에 등록된 PostHog 프로젝트가 없습니다. 관리자에게 Radar에서 프로젝트 등록을 요청하세요."
          : catalog.length === 1 ? "등록된 프로젝트가 1개이므로 project를 생략하면 이 프로젝트를 사용합니다."
          : "등록된 프로젝트가 여러 개입니다. 사용자 요청에서 대상이 명확하지 않으면 먼저 확인하고 project에 이름을 지정하세요.";
        return { status: "success", projects, page, perPage, total: catalog.length, hasNextPage: start + perPage < catalog.length,
          policy: posthogGuidancePolicy, message, fetchedAt };
      },
    }),
    queryEvents: createTool({
      id: "query-events",
      description: "PostHog 이벤트 목록을 조회합니다.",
      inputSchema: queryEventsSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "queryEvents", input, (client, continuation) => client.queryEvents({ ...input, continuation })),
    }),
    queryInsights: createTool({
      id: "query-insights",
      description: "PostHog 인사이트(분석 리포트)를 조회합니다.",
      inputSchema: queryInsightsSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "queryInsights", input, (client, continuation) => client.queryInsights(input.insight_id, { ...input, continuation })),
    }),
    listFeatureFlags: createTool({
      id: "list-feature-flags",
      description: "PostHog 기능 플래그 목록을 조회합니다.",
      inputSchema: noInputSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "listFeatureFlags", input, (client, continuation) => client.listFeatureFlags({ ...input, continuation })),
    }),
    listDashboards: createTool({
      id: "list-dashboards",
      description: "PostHog 대시보드 목록을 조회합니다.",
      inputSchema: noInputSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "listDashboards", input, (client, continuation) => client.listDashboards({ ...input, continuation })),
    }),
    getDashboard: createTool({
      id: "get-dashboard",
      description: "특정 PostHog 대시보드의 상세 정보와 포함된 인사이트를 조회합니다.",
      inputSchema: getDashboardSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "getDashboard", input, (client, continuation) => client.getDashboard(input.dashboard_id)),
    }),
    queryHogQL: createTool({
      id: "query-hogql",
      description: "HogQL 쿼리를 실행합니다. 도구는 쿼리의 읽기 전용 여부를 강제하지 않습니다.",
      inputSchema: queryHogQLSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "queryHogQL", input, (client, continuation) => client.queryHogQL(input.query)),
    }),
    listPersons: createTool({
      id: "list-persons",
      description: "PostHog 사용자를 조회합니다.",
      inputSchema: listPersonsSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "listPersons", input, (client, continuation) =>
        client.listPersons({ distinctId: input.distinct_id, email: input.email, limit: input.limit, continuation })),
    }),
    listCohorts: createTool({
      id: "list-cohorts",
      description: "PostHog 코호트(사용자 그룹) 목록을 조회합니다.",
      inputSchema: simpleLimitSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "listCohorts", input, (client, continuation) => client.listCohorts(input.limit, continuation)),
    }),
    listExperiments: createTool({
      id: "list-experiments",
      description: "PostHog 실험(A/B 테스트) 목록을 조회합니다.",
      inputSchema: simpleLimitSchema,
      outputSchema: resultSchema,
      execute: async (input, context) => run(input.project, context, "listExperiments", input, (client, continuation) => client.listExperiments(input.limit, continuation)),
    }),
  });
}
