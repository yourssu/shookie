import { z } from "zod";

export const MAX_LIMIT = 100;
export const projectSchema = z.string().min(1).max(100).optional()
  .describe("Radar에 등록된 PostHog 프로젝트 이름(대소문자 무시). 등록 프로젝트가 1개일 때만 생략 가능. 여러 개면 listProjects로 확인하고 사용자에게 대상을 확인한 뒤 지정. 프로젝트 ID/URL은 선택 수단이 아님");
export const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(100);
export const continuationSchema = z.string().regex(/^offset:[0-9]{1,7}$/).optional()
  .describe("같은 도구/프로젝트/필터에만 사용하는 continuation");
const idSchema = z.string().regex(/^[1-9][0-9]{0,15}$/);
const dateSchema = z.string().datetime({ offset: true }).optional();
const paging = { project: projectSchema, limit: limitSchema, continuation: continuationSchema };

export const queryEventsSchema = z.object({
  ...paging,
  event: z.string().min(1).max(200).optional(),
  after: dateSchema,
  before: dateSchema,
}).refine(v => !v.after || !v.before || Date.parse(v.after) < Date.parse(v.before), {
  message: "시작일은 종료일보다 빨라야 합니다",
});
export const queryInsightsSchema = z.object({ ...paging, insight_id: idSchema.optional() });
export const queryHogQLSchema = z.object({
  project: projectSchema,
  query: z.string().min(1).max(8000)
    .refine(v => v.trim().length > 0 && Buffer.byteLength(v, "utf8") <= 8000 &&
      Buffer.byteLength(JSON.stringify(v), "utf8") <= 8002,
      "쿼리는 비어 있지 않은 UTF-8 8000바이트 이하여야 합니다"),
});
export const getDashboardSchema = z.object({ project: projectSchema, dashboard_id: idSchema });
export const listPersonsSchema = z.object({
  ...paging,
  distinct_id: z.string().min(1).max(200).optional(),
  email: z.string().email().max(254).optional(),
});
export const simpleLimitSchema = z.object(paging);
export const noInputSchema = simpleLimitSchema;
export const sourceSchema = z.object({
  project: z.string(),
  projectId: z.string(),
  resource: z.string(),
  query: z.string().optional(),
  fetchedAt: z.string(),
});
// Latest Radar project-scoped guidance attached to each authorized action result. Declared in the
// output schema so structured-output validation does not silently strip it.
export const guidanceSchema = z.object({
  project: z.string(),
  projectId: z.string(),
  description: z.string(),
  instructions: z.string(),
  updatedAt: z.string(),
  selectedImplicitly: z.boolean(),
  policy: z.string(),
});
export const resultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    data: z.object({
      rows: z.array(z.unknown()).optional(),
      columns: z.array(z.string()).optional(),
      records: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    source: sourceSchema,
    pagination: z.object({
      continuation: z.string().nullable(),
      hasMore: z.boolean(),
      truncated: z.boolean(),
      omittedRecords: z.number(),
      reason: z.string().optional(),
    }),
    guidance: guidanceSchema.optional(),
  }),
  z.object({
    status: z.literal("error"),
    data: z.null(),
    source: sourceSchema,
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
      httpStatus: z.number().optional(),
    }),
    guidance: guidanceSchema.optional(),
  }),
]);
export type PostHogResult = z.infer<typeof resultSchema>;

export const listProjectsSchema = z.object({
  page: z.number().int().min(1).max(1000).default(1),
  perPage: z.number().int().min(1).max(30).default(20),
}).strict();
export const listProjectsResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    projects: z.array(z.object({
      name: z.string(),
      projectId: z.string(),
      description: z.string(),
      descriptionTruncated: z.boolean(),
      instructionsPreview: z.string(),
      instructionsTruncated: z.boolean(),
      updatedAt: z.string(),
    })),
    page: z.number(),
    perPage: z.number(),
    total: z.number(),
    hasNextPage: z.boolean(),
    policy: z.string(),
    message: z.string(),
    fetchedAt: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }),
    fetchedAt: z.string(),
  }),
]);
export type ListProjectsResult = z.infer<typeof listProjectsResultSchema>;
