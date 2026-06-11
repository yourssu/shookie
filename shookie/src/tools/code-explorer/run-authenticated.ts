import { spawn } from "child_process";
import { realpath } from "fs/promises";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getInstallationToken } from "./github-app-auth.js";

const MAX_OUTPUT_BYTES = 32 * 1024;

const ALLOWED_ENV_KEYS = new Set(["PATH", "HOME"]);

function buildEnv(gitHubToken: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0", GH_TOKEN: gitHubToken };
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function execCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let truncated = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      if (!truncated) {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          chunks.push(Buffer.from("\n... [출력이 32KB 제한을 초과하여 잘렸습니다]"));
        } else {
          chunks.push(chunk);
        }
      }
    });

    const stderrChunks: Buffer[] = [];
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    proc.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(chunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
      });
    });

    proc.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, exitCode: 1 });
    });
  });
}

export function createRunAuthenticatedTool(
  appId: string,
  privateKey: string,
  installationId: string,
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
    }),
    execute: async (input) => {
      const token = await getInstallationToken(appId, privateKey, installationId);
      const env = buildEnv(token);

      const cwd = input.cwd ?? ".";
      const resolvedCwd = await realpath(cwd.startsWith("/")
        ? cwd
        : `${workspaceBasePath}/${cwd}`);
      const resolvedBase = await realpath(workspaceBasePath);

      if (!resolvedCwd.startsWith(resolvedBase)) {
        return {
          stdout: "",
          stderr: "오류: 워크스페이스 외부 경로에서는 명령을 실행할 수 없습니다.",
          exitCode: 1,
        };
      }

      return execCommand(input.command, input.args, resolvedCwd, env);
    },
  });
}
