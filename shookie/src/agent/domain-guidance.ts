import { openSync, readSync, closeSync } from "node:fs";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** Code-owned manifest: never resolve a model-supplied resource, cwd or repository AGENTS. */
const guidanceManifest = Object.freeze({
  github: { version: "1", url: new URL("./guidance/github.v1.md", import.meta.url) },
  posthog: { version: "1", url: new URL("./guidance/posthog.v1.md", import.meta.url) },
} as const);
export type GuidanceDomain = keyof typeof guidanceManifest;
export const guidanceByteLimit = 8192;
export function loadDomainGuidance(domain: unknown, version: unknown = "1") {
  if (domain !== "github" && domain !== "posthog") return { status: "error" as const, error: "unsupported_domain" };
  const entry = guidanceManifest[domain];
  if (version !== entry.version) return { status: "error" as const, error: "unsupported_version" };
  try {
    // Fixed assets only. Bound allocation/read even if a deployment asset is unexpectedly large.
    const fd = openSync(entry.url, "r");
    const buffer = Buffer.alloc(guidanceByteLimit + 1);
    let size = 0;
    try {
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
    } finally { closeSync(fd); }
    if (size > guidanceByteLimit) throw new Error("oversize");
    const instructions = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    if (!instructions.trim()) throw new Error("empty");
    return { status: "success" as const, domain, version: entry.version, instructions };
  } catch {
    return { status: "error" as const, error: "guidance_unavailable" };
  }
}
export function createDomainGuidanceTool(domains: GuidanceDomain[]) {
  const available = [...new Set(domains)].sort();
  return createTool({
    id: "load-domain-guidance",
    description: `코드 소유 읽기 전용 운영 지침 v1. 공통 안전 정책/도구 권한을 확장하지 않습니다. 사용 가능: ${available.join(", ") || "없음"}`,
    inputSchema: z.object({ domain: z.enum(["github", "posthog"]), version: z.literal("1") }).strict(),
    execute: async ({ domain, version }) => available.includes(domain)
      ? loadDomainGuidance(domain, version) : { status: "error" as const, error: "domain_unavailable" },
  });
}
