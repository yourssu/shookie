import { spawn } from "child_process";
import { realpath } from "fs/promises";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const MAX_OUTPUT_BYTES = 32 * 1024;

const ALLOWED_COMMANDS = new Set(["git", "gh"]);

const ALLOWED_ENV_KEYS = new Set(["PATH", "HOME"]);

function buildEnv(gitHubToken: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GH_TOKEN: gitHubToken };
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const GIT_PROGRESS_RE = /^((remote:\s*)?(Counting|Compressing|Enumerating|Receiving|Resolving|Delta|done\.))|\s*\d+%|[\s=*]+$/m;

function stripProgressLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !GIT_PROGRESS_RE.test(line))
    .join("\n")
    .trim();
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

function execCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    const halfBudget = Math.floor(MAX_OUTPUT_BYTES / 2);
    const head: Buffer[] = [];
    let headBytes = 0;
    const tail: Buffer[] = [];
    let tailBytes = 0;
    let truncated = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      if (!truncated) {
        if (headBytes + chunk.length <= halfBudget) {
          head.push(chunk);
          headBytes += chunk.length;
        } else if (headBytes < halfBudget) {
          const slice = chunk.subarray(0, halfBudget - headBytes);
          head.push(slice);
          headBytes += slice.length;
          truncated = true;
        } else {
          truncated = true;
        }
      }
      // Always accumulate tail (ring buffer)
      tail.push(chunk);
      tailBytes += chunk.length;
      while (tailBytes > halfBudget && tail.length > 1) {
        const removed = tail.shift()!;
        tailBytes -= removed.length;
      }
    });

    const stderrChunks: Buffer[] = [];
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("close", (code) => {
      let stdout: string;
      if (!truncated) {
        stdout = Buffer.concat(head).toString("utf-8");
      } else {
        const headPart = Buffer.concat(head).toString("utf-8");
        const tailPart = Buffer.concat(tail).toString("utf-8");
        stdout = headPart + "\n\n... [출력이 32KB 제한을 초과하여 중간이 생략되었습니다] ...\n\n" + tailPart;
      }

      const isGitSuccess = code === 0;
      const rawStderr = Buffer.concat(stderrChunks).toString("utf-8");
      const stderr = isGitSuccess ? stripProgressLines(rawStderr) : rawStderr;

      resolve({ stdout, stderr, exitCode: code ?? 1, truncated });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, exitCode: 1, truncated: false });
    });
  });
}

export function createRunAuthenticatedTool(
  gitHubToken: string,
  workspaceBasePath: string,
) {
  return createTool({
    id: "run-authenticated",
    description:
      "GitHub 인증이 적용된 명령을 실행합니다. git clone, gh pr create 등 git/gh CLI 명령에 사용합니다. cwd는 반드시 현재 스레드 워크스페이스 내 경로여야 합니다.",
    inputSchema: z.object({
      command: z.string().describe("실행할 명령어 (예: git, gh)"),
      args: z.array(z.string()).describe("명령어 인수 목록"),
      cwd: z.string().optional().describe("실행 디렉토리 (워크스페이스 내 상대경로 또는 생략)"),
    }),
    outputSchema: z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number(),
      truncated: z.boolean(),
    }),
    execute: async (input) => {
      if (!ALLOWED_COMMANDS.has(input.command)) {
        return {
          stdout: "",
          stderr: `"${input.command}"은(는) 허용되지 않는 명령입니다. git 또는 gh만 사용 가능합니다.`,
          exitCode: 1,
          truncated: false,
        };
      }

      const env = buildEnv(gitHubToken);

      try {
        const cwd = input.cwd ?? ".";
        const resolvedBase = await realpath(workspaceBasePath);
        const resolvedCwd = await realpath(cwd.startsWith("/")
          ? cwd
          : `${resolvedBase}/${cwd}`);

        if (!resolvedCwd.startsWith(resolvedBase)) {
          return {
            stdout: "",
            stderr: "오류: 워크스페이스 외부 경로에서는 명령을 실행할 수 없습니다.",
            exitCode: 1,
            truncated: false,
          };
        }

        return execCommand(input.command, input.args, resolvedCwd, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : "경로 확인 중 오류가 발생했습니다.";
        return {
          stdout: "",
          stderr: `오류: 워크스페이스 경로를 확인할 수 없습니다. ensure_thread_workspace를 먼저 호출했는지 확인하세요. (${message})`,
          exitCode: 1,
          truncated: false,
        };
      }
    },
  });
}
