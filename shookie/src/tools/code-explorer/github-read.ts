import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { trustedActor } from "./workspace-manager.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/).refine(v => v !== "." && v !== "..");
const ref = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).refine(v => !v.includes("..") && !v.includes("//"));
const path = z.string().max(1000).refine(v => !v.startsWith("/") && !v.includes("\\") && !/[\x00-\x1f\x7f]/.test(v) && v.split("/").every(p => p !== "." && p !== ".."));
export const readInput = z.object({
  operation: z.enum(["repositories", "repository", "tree", "file", "history", "pull_requests", "pull_request", "issues", "issue"]),
  repo: name.optional(), ref: ref.optional(), path: path.optional(),
  number: z.number().int().min(1).max(2147483647).optional(),
  page: z.number().int().min(1).max(100).default(1),
  perPage: z.number().int().min(1).max(30).default(20),
}).strict();
export type ReadInput = z.infer<typeof readInput>;
export interface ReadConfig { owner: string; gitHubToken: string; readOnlyToken?: string; repositories?: string[] }
const MAX_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
export const READ_TIMEOUT_MS = 10_000;

export function buildReadUrl(config: ReadConfig, input: ReadInput): URL {
  name.parse(config.owner);
  if (config.repositories) config.repositories.forEach(r => name.parse(r));
  const url = new URL("https://api.github.com");
  const owner = encodeURIComponent(config.owner);
  if (input.operation === "repositories") {
    if (input.repo || input.ref || input.path || input.number) throw new Error("invalid options");
    url.pathname = `/orgs/${owner}/repos`;
  } else {
    const repo = name.parse(input.repo);
    if (config.repositories && !config.repositories.some(r => r.toLowerCase() === repo.toLowerCase())) throw new Error("scope");
    const base = `/repos/${owner}/${encodeURIComponent(repo)}`;
    const op = input.operation;
    if (input.number && !["pull_request", "issue"].includes(op)) throw new Error("number");
    if (input.ref && !["tree", "file", "history"].includes(op)) throw new Error("ref");
    if (input.path !== undefined && !["file", "history"].includes(op)) throw new Error("path");
    switch (op) {
      case "repository": url.pathname = base; break;
      case "tree": url.pathname = `${base}/git/trees/${encodeURIComponent(ref.parse(input.ref))}`; break;
      case "file":
        if (!input.path) throw new Error("path required");
        url.pathname = `${base}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`;
        if (input.ref) url.searchParams.set("ref", input.ref);
        break;
      case "history":
        url.pathname = `${base}/commits`;
        if (input.ref) url.searchParams.set("sha", input.ref);
        if (input.path) url.searchParams.set("path", input.path);
        break;
      case "pull_requests": url.pathname = `${base}/pulls`; break;
      case "issues": url.pathname = `${base}/issues`; break;
      case "pull_request": case "issue":
        if (!input.number) throw new Error("number required");
        url.pathname = `${base}/${op === "issue" ? "issues" : "pulls"}/${input.number}`;
    }
  }
  if (["repositories", "history", "pull_requests", "issues"].includes(input.operation)) {
    url.searchParams.set("page", String(input.page)); url.searchParams.set("per_page", String(input.perPage));
  }
  return url;
}

export async function readGithub(config: ReadConfig, raw: unknown, fetcher: typeof fetch = fetch) {
  const input = readInput.parse(raw);
  const url = buildReadUrl(config, input);
  const token = config.readOnlyToken || config.gitHubToken;
  if (!token) throw new Error("credential required");
  for (const secret of [config.gitHubToken, config.readOnlyToken].filter(Boolean) as string[]) {
    if (url.toString().includes(secret) || url.toString().includes(encodeURIComponent(secret))) throw new Error("secret in source");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, READ_TIMEOUT_MS);
  });
  const work = async () => {
    const response = await fetcher(url, {
      method: "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!response.ok || response.redirected || !response.body) throw new Error("read failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { controller.abort(); throw new Error("response too large"); }
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    let data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (input.operation === "repositories" && config.repositories) {
      if (!Array.isArray(data)) throw new Error("invalid response");
      data = data.filter((r: { name?: string; owner?: { login?: string } }) => r.owner?.login?.toLowerCase() === config.owner.toLowerCase() && config.repositories!.some(n => n.toLowerCase() === r.name?.toLowerCase()));
    }
    // Only inline contents from the authenticated fixed-host response; never follow response URLs.
    if (input.operation === "file" && data.encoding === "base64" && typeof data.content === "string") {
      data.content = Buffer.from(data.content, "base64").toString("utf8"); data.encoding = "utf8";
    }
    let text = JSON.stringify(data);
    for (const secret of [config.gitHubToken, config.readOnlyToken].filter(Boolean) as string[]) {
      for (const representation of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64"), JSON.stringify(secret).slice(1, -1)]) text = text.split(representation).join("[REDACTED]");
    }
    const output = Buffer.from(text);
    return {
      data: output.subarray(0, MAX_OUTPUT_BYTES - 3).toString("utf8"), truncated: output.length > MAX_OUTPUT_BYTES - 3 || data.truncated === true,
      source: url.toString(), owner: config.owner, repo: input.repo ?? null,
      ref: input.ref ?? null, path: input.path ?? null, page: input.page,
      // Advisory only: we never parse/follow Link URLs with credentials.
      hasNextPage: /rel="next"/.test(response.headers.get("link") ?? ""),
      message: "GitHub 읽기 전용 조회입니다. 클론·파일 수정·push·PR 생성/병합/삭제는 현재 지원하지 않습니다.",
    };
  };
  try { return await Promise.race([work(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function createGithubReadTool(config: ReadConfig) {
  return createTool({
    id: "github-read",
    description: "설정된 조직/저장소의 목록·구조(tree)·파일·커밋 이력·PR·이슈를 읽기 전용으로 조회합니다. 명령 실행, 클론, 파일 수정, push, PR 생성/병합/삭제는 지원하지 않습니다. tree는 ref(브랜치 또는 commit SHA)가 필요합니다.",
    inputSchema: readInput,
    execute: async (input, context) => {
      try { trustedActor(context?.requestContext); return await readGithub(config, input); }
      catch { return { error: "신뢰된 요청 정보·저장소 범위·입력을 확인하거나 잠시 후 다시 시도하세요. 읽기 전용 조회에 실패했습니다. 원격 쓰기는 지원하지 않습니다." }; }
    },
  });
}
