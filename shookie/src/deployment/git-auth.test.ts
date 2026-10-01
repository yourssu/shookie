import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deployScript,
  executable,
  existsSync,
  makeTempDir,
  mkdirSync,
  mocksDir,
  readFileSync,
  readdirSync,
  rmSync,
  runBash,
  writeFileSync,
  type RunResult,
} from "./test-helpers.js";
import path from "node:path";

/**
 * The production host runs Git 2.25, which ignores GIT_CONFIG_COUNT/KEY/VALUE (2.31+). These tests run the
 * real deploy script with a real `git` against a local HTTP git server that requires Basic auth. The `git`
 * on PATH is a wrapper that drops GIT_CONFIG_COUNT, emulating a Git that ignores it, so the script must
 * authenticate clone and fetch through a mechanism old Git supports (GIT_ASKPASS).
 * GIT_BIN can point at another git (e.g. a real 2.25 inside ubuntu:20.04, see docs/deployment.md).
 */
const token = "p@ss:w/rd$'\"&;# `x` \\end";
const realGit = process.env.GIT_BIN ?? spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

describe("deploy script git authentication", () => {
  let sandbox: string;
  let state: string;
  let server: ChildProcess;
  let bare: string;
  let work: string;
  let port: number;
  let checkout: string;

  function git(dir: string, ...args: string[]): string {
    const result = spawnSync(realGit, ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  }

  beforeEach(async () => {
    sandbox = makeTempDir("shookie-git-auth-");
    state = path.join(sandbox, "state");
    mkdirSync(state, { recursive: true });
    const projects = path.join(sandbox, "projects");
    bare = path.join(projects, "yourssu/shookie.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "--bare", "-b", "main");
    work = path.join(sandbox, "work");
    mkdirSync(work, { recursive: true });
    git(work, "init", "-b", "main");
    writeFileSync(path.join(work, "README"), "one\n");
    git(work, "add", "README");
    git(work, "commit", "-m", "one");
    git(work, "push", bare, "main");

    const tokenFile = path.join(sandbox, "token");
    writeFileSync(tokenFile, token);
    const portFile = path.join(sandbox, "port");
    server = spawn("python3", [path.join(mocksDir, "git-auth-server.py"), projects, "x-access-token", tokenFile, portFile], {
      stdio: "ignore",
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(portFile) || readFileSync(portFile, "utf8").trim() === "") {
      if (Date.now() > deadline || server.exitCode !== null) throw new Error("auth server did not start");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    port = Number(readFileSync(portFile, "utf8").trim());

    // Test transport only: route https://github.com/ to the local server. Contains no credentials.
    const home = path.join(sandbox, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, ".gitconfig"), `[url "http://127.0.0.1:${port}/"]\n\tinsteadOf = https://github.com/\n`);
    checkout = path.join(home, "shookie");

    const bin = path.join(sandbox, "bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["docker", "sleep", "flock"]) executable(name, path.join(bin, name));
    const wrapper = path.join(bin, "git");
    writeFileSync(wrapper, `#!/usr/bin/env bash\nunset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  });

  afterEach(() => {
    server.kill("SIGKILL");
    rmSync(sandbox, { recursive: true, force: true });
  });

  function deploy(deploySha: string, gitToken = token): RunResult {
    const script = path.join(sandbox, "deploy.sh");
    writeFileSync(script, deployScript().replaceAll("/home/ubuntu", path.join(sandbox, "home")));
    return runBash(script, {
      PATH: `${path.join(sandbox, "bin")}:${process.env.PATH ?? ""}`,
      HOME: path.join(sandbox, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      MOCK_STATE: state,
      GIT_TOKEN: gitToken,
      GHCR_TOKEN: "mock",
      GHCR_USER: "mock",
      REPO_SLUG: "yourssu/shookie",
      DEPLOY_SHA: deploySha,
      IMAGE_PREFIX: "ghcr.io/yourssu/shookie",
      IMAGE_TAG: "sha-0123456789ab",
    });
  }

  const dockerLog = () => (existsSync(path.join(state, "log")) ? readFileSync(path.join(state, "log"), "utf8") : "");
  const askpassLeftovers = () => readdirSync(path.join(sandbox, "home")).filter((f) => f.startsWith(".shookie-git-askpass."));

  function expectNoTokenLeft(result: RunResult) {
    const fragments = [token, "p@ss", "w/rd"];
    const candidates = [readFileSync(path.join(sandbox, "home/.gitconfig"), "utf8"), result.output];
    if (existsSync(checkout)) {
      candidates.push(readFileSync(path.join(checkout, ".git/config"), "utf8"));
      candidates.push(git(checkout, "config", "--get", "remote.origin.url"));
    }
    for (const text of candidates) for (const fragment of fragments) expect(text).not.toContain(fragment);
    expect(askpassLeftovers()).toEqual([]);
    expect(readFileSync(path.join(sandbox, "home/.gitconfig"), "utf8")).not.toContain("x-access-token");
  }

  it("fixture server really requires authentication", () => {
    const result = spawnSync(realGit, ["ls-remote", `http://127.0.0.1:${port}/yourssu/shookie.git`], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    expect(result.status).not.toBe(0);
  });

  it("clone path authenticates without GIT_CONFIG_COUNT and leaves no credentials", () => {
    const sha = git(work, "rev-parse", "HEAD");
    const result = deploy(sha);
    expect(result.status, result.output).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(sha);
    expect(git(checkout, "config", "--get", "remote.origin.url")).toBe("https://github.com/yourssu/shookie.git");
    expect(dockerLog()).toContain("compose up");
    expectNoTokenLeft(result);
  });

  it("fetch path authenticates and picks up a newer commit", () => {
    const firstSha = git(work, "rev-parse", "HEAD");
    // Pre-existing checkout of the first commit with an unauthenticated origin URL, like the server.
    git(sandbox, "clone", bare, checkout);
    git(checkout, "remote", "set-url", "origin", "https://github.com/yourssu/shookie.git");
    writeFileSync(path.join(work, "README"), "two\n");
    git(work, "commit", "-am", "two");
    git(work, "push", bare, "main");
    const newSha = git(work, "rev-parse", "HEAD");
    expect(newSha).not.toBe(firstSha);

    const result = deploy(newSha);
    expect(result.status, result.output).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(newSha);
    expectNoTokenLeft(result);
  });

  it("a stale token-bearing url rewrite from the old workflow is removed before authenticating", () => {
    const sha = git(work, "rev-parse", "HEAD");
    const gitconfig = path.join(sandbox, "home/.gitconfig");
    writeFileSync(
      gitconfig,
      `${readFileSync(gitconfig, "utf8")}[url "https://x-access-token:stale-expired-token@github.com/"]\n\tinsteadOf = https://github.com/\n`,
    );
    const result = deploy(sha);
    expect(result.status, result.output).toBe(0);
    expect(readFileSync(gitconfig, "utf8")).not.toContain("stale-expired-token");
    expect(readFileSync(gitconfig, "utf8")).toContain(`http://127.0.0.1:${port}/`);
  });

  it("rejected credentials abort clone before any docker pull or compose up", () => {
    const result = deploy(git(work, "rev-parse", "HEAD"), "wrong-token");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("git clone failed");
    for (const word of ["pull", "compose up", "login"]) expect(dockerLog()).not.toContain(word);
    expect(result.output).not.toContain("wrong-token");
    expect(askpassLeftovers()).toEqual([]);
  });

  it("rejected credentials abort fetch before any docker pull or compose up", () => {
    git(sandbox, "clone", bare, checkout);
    git(checkout, "remote", "set-url", "origin", "https://github.com/yourssu/shookie.git");
    const result = deploy(git(work, "rev-parse", "HEAD"), "wrong-token");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("git fetch failed");
    for (const word of ["pull", "compose up", "login"]) expect(dockerLog()).not.toContain(word);
    expect(askpassLeftovers()).toEqual([]);
  });

  it("script does not rely on Git 2.31 config env or put the token on a command line", () => {
    const script = deployScript()
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    for (const forbidden of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY", "GIT_CONFIG_VALUE", "insteadOf", "git -c url.", "x-access-token@", "extraheader", "$GIT_TOKEN@"]) {
      expect(script).not.toContain(forbidden);
    }
    for (const required of ["GIT_ASKPASS", "GIT_TERMINAL_PROMPT=0", "credential.helper="]) expect(script).toContain(required);
  });
});
