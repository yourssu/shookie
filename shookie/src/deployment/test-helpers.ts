import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const mocksDir = path.join(repoRoot, "shookie/src/deployment/mocks");

export function readRepoFile(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

export const deployWorkflow = (): string => readRepoFile(".github/workflows/deploy.yml");

/** Text of one top-level job (`  <name>:` at two-space indent) in the workflow. */
export function jobText(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) throw new Error(`job ${name} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i]!) && lines[i] !== `  ${name}:`) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The `script: |` block of the appleboy/ssh-action step, de-indented exactly like the action runs it. */
export function deployScript(workflow = deployWorkflow()): string {
  const lines = workflow.split("\n");
  const head = lines.findIndex((line) => /^\s+script: \|$/.test(line));
  if (head < 0) throw new Error("ssh-action script block not found");
  const headIndent = lines[head]!.match(/^\s*/)![0].length;
  const block: string[] = [];
  for (let i = head + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() !== "" && line.match(/^\s*/)![0].length <= headIndent) break;
    block.push(line);
  }
  const indent = block.find((line) => line.trim() !== "")!.match(/^\s*/)![0].length;
  return block.map((line) => line.slice(indent)).join("\n");
}

export function executable(source: string, dest: string): void {
  copyFileSync(path.join(mocksDir, source), dest);
  chmodSync(dest, 0o755);
}

export interface RunResult {
  status: number | null;
  output: string;
}

export interface CommandResult extends RunResult {
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
}

export interface CommandOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/** POSIX fixture children must be spawned detached so the whole process group can be stopped. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Await pipe closure and reap the child; escalate even if its shell exits before descendants. */
export async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  const closed = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => child.once("close", () => resolve()));
  killGroup(child, "SIGTERM");
  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  killGroup(child, "SIGKILL");
  await closed;
}

const activeCommands = new Map<ChildProcess, () => Promise<void>>();

/** Call before removing fixture directories, including when Vitest times a test out. */
export async function cleanupCommands(): Promise<void> {
  await Promise.all([...activeCommands.values()].map((stop) => stop()));
}

/** Async, bounded fixture execution. Infrastructure failures reject, never masquerade as script failures. */
export function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  const { timeoutMs = 15_000, maxOutputBytes = 1024 * 1024, ...spawnOptions } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    return Promise.reject(new Error("timeoutMs and maxOutputBytes must be positive bounded numbers"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let stopping: Promise<void> | undefined;
    const fail = (message: string) => {
      if (failure) return;
      failure = new Error(message);
      stopping = stopChild(child);
    };
    let markFinished!: () => void;
    const finished = new Promise<void>((done) => { markFinished = done; });
    activeCommands.set(child, async () => {
      fail(`${command} fixture interrupted by teardown`);
      await finished;
    });
    const timer = setTimeout(() => fail(`${command} fixture timed out after ${timeoutMs}ms`), timeoutMs);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      const remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining) chunks.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxOutputBytes) fail(`${command} fixture exceeded ${maxOutputBytes} output bytes`);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => { failure ??= error; });
    child.once("close", async (status, signal) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      try {
        await stopping;
        if (failure) reject(new Error(`${failure.message}\nstdout:\n${out}\nstderr:\n${err}`));
        else resolve({ status, signal, stdout: out, stderr: err, output: out + err });
      } catch (error) {
        reject(error);
      } finally {
        activeCommands.delete(child);
        markFinished();
      }
    });
  });
}

export function runBash(scriptPath: string, env: Record<string, string>, cwd?: string): Promise<CommandResult> {
  return runCommand("bash", [scriptPath], { env, cwd });
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync };
