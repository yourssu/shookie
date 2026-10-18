import { z } from "zod";
import { executionSignal, trackExecution } from "../../cancellation/execution-context.js";

export const REGISTRY_PATH = "/internal/v1/shookie/github/repositories";
export interface RegistryConfig { apiUrl: string; apiKey: string; requestTimeoutMs?: number }
export function registryConfig(apiUrl: string, apiKey: string): RegistryConfig | null {
  if (!apiUrl.trim() && !apiKey.trim()) return null;
  if (!apiUrl.trim() || !/^[^\s]{16,512}$/.test(apiKey)) throw new Error("GitHub registry requires URL and dedicated API key (16-512 non-whitespace characters)");
  if ([apiKey, encodeURIComponent(apiKey), Buffer.from(apiKey).toString("base64")].some(value => apiUrl.includes(value))) throw new Error("Invalid GitHub registry endpoint");
  let url: URL;
  try { url = new URL(apiUrl); } catch { throw new Error("Invalid GitHub registry URL"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) ||
      url.pathname !== REGISTRY_PATH || url.username || url.password || url.search || url.hash || apiUrl.includes("?") || apiUrl.includes("#")) throw new Error("Invalid GitHub registry endpoint");
  return { apiUrl: url.toString(), apiKey };
}
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/).refine(v => v !== "." && v !== "..");
const record = z.object({ id: z.string().uuid(), owner: name, name, instructions: z.string().max(10000), createdAt: z.string().max(64).datetime({ offset: true }), updatedAt: z.string().max(64).datetime({ offset: true }) }).strict();
export type RegisteredRepository = z.infer<typeof record>;
export const guidancePolicy = "Radar는 live 등록 권한만 확인합니다. 저장소 지침 소비는 비활성화되어 있습니다.";
export function redactRegistry(text: string, config: RegistryConfig) {
  for (const value of [config.apiKey, encodeURIComponent(config.apiKey), Buffer.from(config.apiKey).toString("base64"), JSON.stringify(config.apiKey).slice(1, -1)]) text = text.split(value).join("[REDACTED]");
  return text;
}
export async function fetchRegistry(config: RegistryConfig, owner: string, signal = executionSignal(), fetcher: typeof fetch = fetch): Promise<RegisteredRepository[]> {
  // Validate again at the HTTP boundary; never follow a redirect with the internal key.
  registryConfig(config.apiUrl, config.apiKey);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("GitHub registry unavailable"));
    combined.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), config.requestTimeoutMs ?? 10000);
  });
  const work = async () => {
    combined.throwIfAborted();
    const response = await fetcher(config.apiUrl, { method: "GET", redirect: "error", signal: combined, headers: { "X-API-Key": config.apiKey, Accept: "application/json" } });
    if (!response.ok || response.redirected || !response.body) throw new Error("registry unavailable");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 64 * 1024 * 1024)) throw new Error("registry too large");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      while (true) {
        combined.throwIfAborted();
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > 64 * 1024 * 1024) throw new Error("registry too large");
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    const catalog = z.object({ repositories: z.array(record).max(1000) }).strict().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))).repositories;
    const ids = new Set<string>(), names = new Set<string>();
    for (const repo of catalog) {
      const key = repo.name.toLowerCase();
      if (repo.owner.toLowerCase() !== owner.toLowerCase() || ids.has(repo.id.toLowerCase()) || names.has(key)) throw new Error("invalid registry scope");
      ids.add(repo.id.toLowerCase()); names.add(key);
      const { instructions, ...metadata } = repo;
      if (redactRegistry(JSON.stringify(metadata), config) !== JSON.stringify(metadata)) throw new Error("secret in registry metadata");
      // Keep the live registration authority, discard guidance before any consumer sees it.
      repo.instructions = "";
    }
    return catalog;
  };
  try { return await Promise.race([trackExecution(work()), deadline]); }
  catch { throw new Error("GitHub 등록 저장소를 확인할 수 없습니다. Radar 설정을 확인하거나 잠시 후 다시 시도하세요."); }
  finally { clearTimeout(timer); controller.abort(); combined.removeEventListener("abort", onAbort); }
}
export async function authorizeRepository(config: RegistryConfig, owner: string, repo: string, signal?: AbortSignal) {
  const catalog = await fetchRegistry(config, owner, signal);
  const registered = catalog.find(r => r.name.toLowerCase() === repo.toLowerCase());
  if (!registered) throw new Error("Radar에 현재 등록된 저장소만 탐색할 수 있습니다.");
  return { repository: registered, policy: guidancePolicy };
}
