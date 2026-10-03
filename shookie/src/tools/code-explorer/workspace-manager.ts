import { mkdir, readdir, lstat, realpath } from "fs/promises";
import { resolve, relative, isAbsolute, join } from "path";

interface Context { get(key: string): unknown }
export function trustedActor(context?: Context) {
  const channel = context?.get("channel"), threadTs = context?.get("threadTs"), userId = context?.get("userId"), requestId = context?.get("requestId"), teamId = context?.get("teamId");
  if (typeof channel !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(channel) ||
      typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(userId) ||
      typeof threadTs !== "string" || !/^\d{1,20}\.\d{1,20}$/.test(threadTs) ||
      typeof requestId !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId) ||
      (teamId !== undefined && (typeof teamId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(teamId)))) {
    throw new Error("신뢰된 요청 정보가 필요합니다.");
  }
  return { channel, threadTs, userId, teamId, requestId };
}
export function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

// No leases exist for legacy workspaces. Never delete them or their local edits.
async function totalSize(dir: string): Promise<number> {
  const s = await lstat(dir);
  if (s.isSymbolicLink()) throw new Error("워크스페이스 심볼릭 링크는 허용되지 않습니다.");
  if (!s.isDirectory()) return s.size;
  let size = 0;
  for (const entry of await readdir(dir)) size += await totalSize(join(dir, entry));
  return size;
}
export async function ensureThreadCapacity(basePath: string, maxGb: number): Promise<void> {
  if (!Number.isFinite(maxGb) || maxGb <= 0) throw new Error("워크스페이스 용량 설정을 확인하세요.");
  await mkdir(basePath, { recursive: true });
  if (await totalSize(basePath) >= maxGb * 1024 ** 3) {
    throw new Error("워크스페이스 용량이 부족합니다. 기존 작업은 삭제하지 않았습니다. 관리자에게 보존 후 정리를 요청하세요.");
  }
}

// Reserved for a future isolated coding lifecycle; not exposed as an agent tool.
export async function validateThreadPath(basePath: string, context: Context, target: string): Promise<string> {
  const actor = trustedActor(context);
  const base = await realpath(basePath);
  const thread = resolve(base, "actors", actor.teamId ?? "no-team", actor.userId, actor.channel, actor.threadTs);
  // Reject symlinks even when their current target happens to be inside the base.
  let current = base;
  for (const component of relative(base, thread).split("/")) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("심볼릭 링크는 허용되지 않습니다.");
  }
  const root = await realpath(thread);
  const actual = await realpath(resolve(root, target));
  if (!within(base, root) || !within(root, actual) || !(await lstat(actual)).isDirectory()) throw new Error("현재 사용자/스레드 경로만 허용됩니다.");
  return actual;
}
