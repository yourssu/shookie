import { mkdir, rm, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { logger } from "../../logger.js";
import type { ToolExecutionContext } from "@mastra/core/tools";
import type { RequestContext } from "@mastra/core/request-context";

function threadDir(basePath: string, channel: string, threadTs: string): string {
  return resolve(basePath, `threads/${channel}_${threadTs}`);
}

async function getTotalSize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getTotalSize(fullPath);
    } else if (entry.isFile()) {
      const s = await stat(fullPath);
      total += s.size;
    }
  }
  return total;
}

async function evictOldWorkspaces(basePath: string, maxGb: number): Promise<void> {
  const threadsDir = resolve(basePath, "threads");
  if (!existsSync(threadsDir)) return;

  const maxBytes = maxGb * 1024 * 1024 * 1024;
  const currentSize = await getTotalSize(threadsDir);

  if (currentSize <= maxBytes) return;

  const entries = await readdir(threadsDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, path: join(threadsDir, e.name) }));

  const withAtime = await Promise.all(
    dirs.map(async (d) => {
      const s = await stat(d.path);
      return { ...d, atime: s.atimeMs };
    }),
  );

  withAtime.sort((a, b) => a.atime - b.atime);

  let freed = 0;
  const toFree = currentSize - maxBytes;
  for (const d of withAtime) {
    if (freed >= toFree) break;
    const dirSize = await getTotalSize(d.path);
    await rm(d.path, { recursive: true, force: true });
    freed += dirSize;
    logger.info(`워크스페이스 LRU 정리: ${d.name} (${(dirSize / 1024 / 1024).toFixed(1)}MB)`);
  }
}

export async function ensureThreadCapacity(
  basePath: string,
  maxGb: number,
): Promise<void> {
  await mkdir(basePath, { recursive: true });
  await evictOldWorkspaces(basePath, maxGb);
}

function getContextIds(context?: ToolExecutionContext): { channel: string; threadTs: string } {
  const channel = context?.requestContext?.get("channel") as string | undefined;
  const threadTs = context?.requestContext?.get("threadTs") as string | undefined;
  if (!channel || !threadTs) {
    throw new Error("requestContext에 channel/threadTs가 없습니다. ensure_thread_workspace는 스레드 컨텍스트에서만 사용할 수 있습니다.");
  }
  return { channel, threadTs };
}

export function createWorkspaceManagerTools(
  workspaceBasePath: string,
  workspaceMaxGb: number,
) {
  const ensureThreadWorkspace = createTool({
    id: "ensure-thread-workspace",
    description:
      "현재 스레드의 워크스페이스 디렉토리를 준비합니다. 리포지토리 클론 전에 반드시 호출해야 합니다. channel/threadTs는 자동으로 주입되므로 입력 인수는 필요 없습니다.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      path: z.string(),
      created: z.boolean(),
    }),
    execute: async (_input, context) => {
      const { channel, threadTs } = getContextIds(context);

      await mkdir(workspaceBasePath, { recursive: true });
      await evictOldWorkspaces(workspaceBasePath, workspaceMaxGb);

      const dir = threadDir(workspaceBasePath, channel, threadTs);
      const created = !existsSync(dir);
      if (created) {
        await mkdir(dir, { recursive: true });
      }
      return { path: dir, created };
    },
  });

  const finishThreadWorkspace = createTool({
    id: "finish-thread-workspace",
    description:
      "현재 스레드의 워크스페이스를 정리합니다. 작업 완료 후 호출합니다. channel/threadTs는 자동으로 주입됩니다.",
    inputSchema: z.object({}),
    outputSchema: z.object({
      cleaned: z.boolean(),
    }),
    execute: async (_input, context) => {
      const { channel, threadTs } = getContextIds(context);

      const dir = threadDir(workspaceBasePath, channel, threadTs);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        return { cleaned: true };
      }
      return { cleaned: false };
    },
  });

  return { ensure_thread_workspace: ensureThreadWorkspace, finish_thread_workspace: finishThreadWorkspace };
}
