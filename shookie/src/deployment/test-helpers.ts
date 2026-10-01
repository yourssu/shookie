import { spawnSync } from "node:child_process";
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

export function runBash(scriptPath: string, env: Record<string, string>, cwd?: string): RunResult {
  const result = spawnSync("bash", [scriptPath], {
    env,
    cwd,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync };
