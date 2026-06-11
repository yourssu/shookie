import { mkdir, rm, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

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
  }
}

export function createWorkspaceManagerTools(
  workspaceBasePath: string,
  workspaceMaxGb: number,
) {
  const ensureThreadWorkspace = createTool({
    id: "ensure-thread-workspace",
    description:
      "현재 스레드의 워크스페이스 디렉토리를 준비합니다. 리포지토리 클론 전에 반드시 호출해야 합니다.",
    inputSchema: z.object({
      channel: z.string(),
      threadTs: z.string(),
    }),
    outputSchema: z.object({
      path: z.string(),
      created: z.boolean(),
    }),
    execute: async (input) => {
      await mkdir(workspaceBasePath, { recursive: true });
      await evictOldWorkspaces(workspaceBasePath, workspaceMaxGb);

      const dir = threadDir(workspaceBasePath, input.channel, input.threadTs);
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
      "현재 스레드의 워크스페이스를 정리합니다. 작업 완료 후 호출합니다.",
    inputSchema: z.object({
      channel: z.string(),
      threadTs: z.string(),
    }),
    outputSchema: z.object({
      cleaned: z.boolean(),
    }),
    execute: async (input) => {
      const dir = threadDir(workspaceBasePath, input.channel, input.threadTs);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        return { cleaned: true };
      }
      return { cleaned: false };
    },
  });

  return { ensure_thread_workspace: ensureThreadWorkspace, finish_thread_workspace: finishThreadWorkspace };
}
