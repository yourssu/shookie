import { z } from "zod";
import { executionSignal, trackExecution } from "../../cancellation/execution-context.js";

// Radar is the sole live resource registration authority. Guidance consumption is disabled.
// There is no static/code fallback: blank config disables the PostHog subagent entirely.
export const POSTHOG_REGISTRY_PATH = "/internal/v1/shookie/posthog/projects";
export const POSTHOG_REGISTRY_MAX_BYTES = 64 * 1024 * 1024;
export const POSTHOG_REGISTRY_TIMEOUT_MS = 10_000;
export interface PostHogRegistryConfig { apiUrl: string; apiKey: string; requestTimeoutMs?: number }

export function posthogRegistryConfig(apiUrl: string, apiKey: string): PostHogRegistryConfig | null {
  if (!apiUrl.trim() && !apiKey.trim()) return null;
  if (!apiUrl.trim() || !/^[^\s]{16,512}$/.test(apiKey)) throw new Error("PostHog registry requires URL and dedicated API key (16-512 non-whitespace characters)");
  if ([apiKey, encodeURIComponent(apiKey), Buffer.from(apiKey).toString("base64")].some(value => apiUrl.includes(value))) throw new Error("Invalid PostHog registry endpoint");
  let url: URL;
  try { url = new URL(apiUrl); } catch { throw new Error("Invalid PostHog registry URL"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
      url.pathname !== POSTHOG_REGISTRY_PATH || url.username || url.password || url.search || url.hash || apiUrl.includes("?") || apiUrl.includes("#")) throw new Error("Invalid PostHog registry endpoint");
  return { apiUrl: url.toString(), apiKey };
}

const timestamp = z.string().max(64).datetime({ offset: true });
const record = z.object({
  id: z.string().uuid(),
  projectId: z.string().regex(/^[1-9][0-9]{0,15}$/),
  name: z.string().min(1).max(100).refine(v => v.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(v)),
  organizationId: z.string().max(200),
  description: z.string().max(1000),
  instructions: z.string().max(20000),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict();
export type RegisteredPostHogProject = z.infer<typeof record>;
const catalogSchema = z.object({ projects: z.array(record).max(1000) }).strict();

export const posthogGuidancePolicy = "Radar는 live 등록 권한만 확인합니다. 프로젝트 지침 소비는 비활성화되어 있습니다.";

function representations(secret: string) {
  return [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), JSON.stringify(secret).slice(1, -1)].filter(Boolean);
}
export function redactSecrets(text: string, secrets: string[]) {
  for (const secret of secrets.filter(Boolean)) for (const value of representations(secret)) text = text.split(value).join("[REDACTED]");
  return text;
}

/** Fetches the full current catalog. Every call is a fresh request: no positive cache. */
export async function fetchPostHogRegistry(config: PostHogRegistryConfig, options: { signal?: AbortSignal; fetcher?: typeof fetch; secrets?: string[] } = {}): Promise<RegisteredPostHogProject[]> {
  const fetcher = options.fetcher ?? fetch;
  const signal = options.signal ?? executionSignal();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("PostHog registry unavailable"));
    combined.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? POSTHOG_REGISTRY_TIMEOUT_MS);
  });
  const secrets = [config.apiKey, ...(options.secrets ?? [])];
  const work = async () => {
    // Validate again at the HTTP boundary; never follow a redirect with the internal key.
    posthogRegistryConfig(config.apiUrl, config.apiKey);
    combined.throwIfAborted();
    const response = await fetcher(config.apiUrl, { method: "GET", redirect: "error", signal: combined, headers: { "X-API-Key": config.apiKey, Accept: "application/json" } });
    if (!response.ok || response.redirected || !response.body) throw new Error("registry unavailable");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > POSTHOG_REGISTRY_MAX_BYTES)) throw new Error("registry too large");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        combined.throwIfAborted();
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > POSTHOG_REGISTRY_MAX_BYTES) throw new Error("registry too large");
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    const catalog = catalogSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))).projects;
    const ids = new Set<string>(), projectIds = new Set<string>(), names = new Set<string>();
    for (const project of catalog) {
      const id = project.id.toLowerCase(), name = project.name.toLowerCase();
      if (ids.has(id) || projectIds.has(project.projectId) || names.has(name)) throw new Error("duplicate registry entry");
      ids.add(id); projectIds.add(project.projectId); names.add(name);
      const { instructions, description, ...metadata } = project;
      // Identifiers must never carry credentials; free text is redacted instead of rejected.
      if (redactSecrets(JSON.stringify(metadata), secrets) !== JSON.stringify(metadata)) throw new Error("secret in registry metadata");
      project.description = redactSecrets(description, secrets);
      // Registration remains live; project instructions never cross this boundary.
      project.instructions = "";
    }
    return catalog;
  };
  try { return await Promise.race([trackExecution(work()), deadline]); }
  catch { throw new PostHogRegistryError(); }
  finally { clearTimeout(timer); controller.abort(); combined.removeEventListener("abort", onAbort); }
}

export class PostHogRegistryError extends Error {
  constructor() { super("Radar PostHog 프로젝트 등록 정보를 확인할 수 없습니다. Radar 설정을 확인하거나 잠시 후 다시 시도하세요."); }
}

export type ProjectSelection =
  | { status: "selected"; project: RegisteredPostHogProject; implicit: boolean }
  | { status: "error"; code: "no_registered_projects" | "project_selection_required" | "unknown_project"; message: string };

/** Pure selection against an already fetched, current catalog. Names only; IDs/URLs never select. */
export function selectProject(catalog: RegisteredPostHogProject[], requested?: string): ProjectSelection {
  if (!catalog.length) return { status: "error", code: "no_registered_projects", message: "Radar에 등록된 PostHog 프로젝트가 없습니다. 관리자에게 Radar에서 프로젝트 등록을 요청하세요." };
  if (requested === undefined) {
    if (catalog.length === 1) return { status: "selected", project: catalog[0], implicit: true };
    return { status: "error", code: "project_selection_required", message: "등록된 PostHog 프로젝트가 여러 개입니다. listProjects로 목록을 확인하고 사용자에게 대상 프로젝트를 확인한 뒤 project에 이름을 지정하세요." };
  }
  const wanted = requested.trim().toLowerCase();
  const project = catalog.find(p => p.name.toLowerCase() === wanted);
  if (!project) return { status: "error", code: "unknown_project", message: "Radar에 현재 등록된 PostHog 프로젝트 이름이 아닙니다. listProjects로 등록된 이름을 확인하세요." };
  return { status: "selected", project, implicit: false };
}
