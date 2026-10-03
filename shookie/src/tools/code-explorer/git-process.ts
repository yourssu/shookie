import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

// No inherited credentials, proxy, loader, Git config, or shell environment.
export function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home,
    LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "https", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0", GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "8",
    GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "core.hooksPath", GIT_CONFIG_VALUE_1: "/dev/null",
    GIT_CONFIG_KEY_2: "http.followRedirects", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "http.proxy", GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: "protocol.allow", GIT_CONFIG_VALUE_4: "never",
    GIT_CONFIG_KEY_5: "protocol.https.allow", GIT_CONFIG_VALUE_5: "always",
    GIT_CONFIG_KEY_6: "core.attributesFile", GIT_CONFIG_VALUE_6: "/dev/null",
    GIT_CONFIG_KEY_7: "http.sslVerify", GIT_CONFIG_VALUE_7: "true",
  };
}

export async function diskBytes(path: string, limit = Number.MAX_SAFE_INTEGER): Promise<number> {
  let count = 0;
  async function visit(dir: string): Promise<number> {
    if (++count > 100_000) throw new Error("storage entry limit");
    const stat = await lstat(dir);
    if (stat.isSymbolicLink()) throw new Error("storage symlink");
    let size = stat.size;
    if (stat.isDirectory()) {
      for (const name of await readdir(dir)) {
        size += await visit(join(dir, name));
        if (size > limit) break;
      }
    }
    return size;
  }
  return visit(path);
}

export interface ProcessOptions {
  env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number;
  signal?: AbortSignal; monitor?: () => Promise<void>;
}
// Internal seam for fixture tests only. Never receives model-supplied commands.
export function runBoundedProcess(executable: string, args: string[], options: ProcessOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("cancelled")); return; }
    const child = spawn(executable, args, { env: options.env, cwd: options.env.HOME,
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let failure = false, bytes = 0, checking = false;
    const chunks: Buffer[] = [];
    const kill = () => {
      if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ } }
    };
    const fail = () => { failure = true; kill(); };
    const timer = setTimeout(fail, options.timeoutMs);
    const interval = options.monitor ? setInterval(async () => {
      if (checking) return;
      checking = true;
      try { await options.monitor!(); } catch { fail(); }
      finally { checking = false; }
    }, 100) : undefined;
    options.signal?.addEventListener("abort", fail, { once: true });
    const collect = (data: Buffer, stdout: boolean) => {
      bytes += data.length;
      if (bytes > options.maxOutputBytes) fail();
      else if (stdout) chunks.push(data);
      // stderr is counted, but never stored, logged, or propagated.
    };
    child.stdout.on("data", data => collect(data, true));
    child.stderr.on("data", data => collect(data, false));
    child.on("error", fail);
    child.on("close", code => {
      clearTimeout(timer); clearInterval(interval);
      options.signal?.removeEventListener("abort", fail); kill();
      if (failure || code !== 0) reject(new Error("controlled subprocess failed"));
      else resolve(Buffer.concat(chunks));
    });
  });
}
