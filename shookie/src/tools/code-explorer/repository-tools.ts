import { createTool } from "@mastra/core/tools";
import { executionSignal } from "../../cancellation/execution-context.js";
import { z } from "zod";
import { RepositorySnapshots, repositoryName, repositoryRef, repositoryPath, snapshotIdSchema, type SnapshotConfig } from "./repository-snapshots.js";
const snapshot = z.object({ snapshotId: snapshotIdSchema });
const cursor = z.object({ fileIndex: z.number().int().min(0).max(100_000), line: z.number().int().min(1).max(1_000_001) }).strict();
const failure = { error: "신뢰된 요청 정보·저장소 범위·snapshot 소유권·입력·용량을 확인하세요. 읽기 전용 저장소 탐색에 실패했습니다. 기존 작업은 삭제하지 않았습니다." };
export function createRepositoryTools(config: SnapshotConfig) {
  const manager = new RepositorySnapshots(config);
  return {
    repo_clone: createTool({
      id: "repo-clone", description: "설정된 GitHub owner/repo를 bare shallow clone하여 현재 사용자/스레드 전용 commit 고정 snapshotId를 반환합니다. ref는 브랜치/태그명만 허용하며 SHA/revision 표현식·URL·명령은 받지 않습니다. 스크립트 실행·checkout·수정·원격 쓰기는 하지 않습니다.",
      inputSchema: z.object({ repo: repositoryName, ref: repositoryRef.optional() }).strict(),
      execute: async (input, context) => {
        try { return await manager.clone(input, context?.requestContext, executionSignal(context?.abortSignal)); } catch { return failure; }
      },
    }),
    repo_list_files: createTool({
      id: "repo-list-files", description: "현재 사용자/스레드 소유 snapshot의 commit 고정 파일 목록과 mode/blob SHA를 조회합니다. next offset으로 이어서 조회합니다. symlink/gitlink는 읽거나 따라가지 않습니다.",
      inputSchema: snapshot.extend({ offset: z.number().int().min(0).max(100_000).default(0) }).strict(),
      execute: async (input, context) => {
        try { return await manager.list(input.snapshotId, context?.requestContext, input.offset); } catch { return failure; }
      },
    }),
    repo_read_file: createTool({
      id: "repo-read-file", description: "소유 snapshot의 안전한 상대 path의 일반 UTF-8 파일을 줄 단위로 읽습니다. next startLine으로 이어서 조회하고 missing/binary/large/large_line/unsupported 상태를 빈 파일과 구별하세요.",
      inputSchema: snapshot.extend({ path: repositoryPath, startLine: z.number().int().min(1).max(1_000_001).default(1) }).strict(),
      execute: async (input, context) => {
        try { return await manager.read(input.snapshotId, context?.requestContext, input.path, input.startLine, executionSignal(context?.abortSignal)); } catch { return failure; }
      },
    }),
    repo_search: createTool({
      id: "repo-search", description: "소유 snapshot의 일반 UTF-8 파일에서 literal 문자열을 검색합니다(정규식/명령 아님). next cursor로 이어서 조회합니다. skipped와 complete/truncated를 확인하세요. 큰 파일·바이너리·symlink·gitlink는 검색하지 않습니다.",
      inputSchema: snapshot.extend({ literal: z.string().min(1).max(200).refine(v => !/[\x00-\x1f\x7f]/.test(v)), cursor: cursor.optional() }).strict(),
      execute: async (input, context) => {
        try { return await manager.search(input.snapshotId, context?.requestContext, input.literal, input.cursor, executionSignal(context?.abortSignal)); } catch { return failure; }
      },
    }),
  };
}
