import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deployScript,
  executable,
  existsSync,
  makeTempDir,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  runBash,
  writeFileSync,
  type RunResult,
} from "./test-helpers.js";
import path from "node:path";

/**
 * Runs the real remote deploy script from the workflow against fake docker/git/flock/sleep binaries
 * (src/deployment/mocks) to verify success and failure flows end to end, including the shared
 * PostgreSQL checks. State of the fake host lives in <sandbox>/state.
 */
describe("EC2 deploy script (mock docker)", () => {
  let sandbox: string;
  let state: string;
  let script: string;
  let bin: string;

  const newImage = "ghcr.io/yourssu/shookie:sha-0123456789ab";
  const key = (name: string) => name.replace(/\//g, "__").replace(/:/g, "--");

  beforeEach(() => {
    sandbox = makeTempDir("shookie-deploy-");
    bin = path.join(sandbox, "bin");
    state = path.join(sandbox, "state");
    for (const dir of [bin, state, path.join(sandbox, "home/shookie")]) mkdirSync(dir, { recursive: true });
    for (const name of ["docker", "git", "sleep", "flock"]) executable(name, path.join(bin, name));
    script = path.join(sandbox, "deploy.sh");
    writeFileSync(script, deployScript().replaceAll("/home/ubuntu", path.join(sandbox, "home")));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function run(extra: Record<string, string> = {}): RunResult {
    return runBash(script, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: path.join(sandbox, "home"),
      MOCK_STATE: state,
      GIT_TOKEN: "mock",
      GHCR_TOKEN: "mock",
      GHCR_USER: "mock",
      REPO_SLUG: "yourssu/shookie",
      DEPLOY_SHA: "0123456789abcdef",
      IMAGE_PREFIX: "ghcr.io/yourssu/shookie",
      IMAGE_TAG: "sha-0123456789ab",
      ...extra,
    });
  }

  // --- state helpers -------------------------------------------------------------------------

  const read = (...parts: string[]): string | null => {
    const file = path.join(state, ...parts);
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  };
  const container = (imageId: string, ref = "shookie-bot") => {
    mkdirSync(path.join(state, "containers"), { recursive: true });
    mkdirSync(path.join(state, "refs"), { recursive: true });
    writeFileSync(path.join(state, "containers/bot"), `${imageId}\n`);
    writeFileSync(path.join(state, "refs/bot"), `${ref}\n`);
  };
  const tag = (name: string, imageId: string) => {
    mkdirSync(path.join(state, "tags"), { recursive: true });
    writeFileSync(path.join(state, "tags", key(name)), `${imageId}\n`);
  };
  const tagId = (name: string) => read("tags", key(name));
  const botImage = () => read("containers", "bot");
  const ups = (): string[] => (read("ups") ?? "").split("\n").filter(Boolean);
  const dockerLog = (): string => read("log") ?? "";
  const snapshotTags = (): string[] =>
    existsSync(path.join(state, "tags")) ? readdirSync(path.join(state, "tags")).filter((f) => f.startsWith("shookie-rollback__bot--")) : [];
  const pointer = () => {
    const file = path.join(sandbox, "home/.shookie-rollback-snapshot");
    return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
  };
  const healthyCurrentBot = (id = "sha256:oldbot") => container(id);

  /** Everything the deploy must never run, on any path. The shared DB compose is only inspected, never changed. */
  const expectNoForbiddenDockerCommands = () => {
    const log = dockerLog();
    expect(log).not.toMatch(/compose( -f \S+)* (down|build|stop|rm|restart|create|start|kill|pause)\b/);
    expect(log).not.toMatch(/(builder|image|system|volume|network|container) prune|volume (rm|create)|network (rm|create|connect|disconnect)/);
    expect(log).not.toMatch(/-f docker-compose\.db\.yml (up|down|restart|stop|rm|run|create)/);
    expect(log).not.toContain("--build");
    for (const line of log.split("\n").filter((l) => l.includes("compose") && l.includes(" up"))) {
      expect(line).toContain("--no-build");
      expect(line).toContain("--no-deps bot");
    }
  };

  // --- scenarios -----------------------------------------------------------------------------

  it("successful deploy pulls first, replaces only the bot, publishes a snapshot and prunes the older one", () => {
    healthyCurrentBot();
    tag("shookie-rollback/bot:s-old", "sha256:ancientbot");
    writeFileSync(path.join(sandbox, "home/.shookie-rollback-snapshot"), "s-old\n");
    // Retention follows the successful-deploy history (not image creation order): newest three distinct are
    // kept. Tags that never made it into the history (e.g. pulled by a failed deploy) and older ones are removed.
    for (const sha of ["000000000001", "000000000002", "000000000003", "000000000004", "0000000000ff"]) tag(`ghcr.io/yourssu/shookie:sha-${sha}`, `sha256:${sha}`);
    writeFileSync(
      path.join(sandbox, "home/.shookie-deploy-history"),
      ["000000000001", "000000000002", "000000000003", "000000000004"].map((sha) => `ghcr.io/yourssu/shookie:sha-${sha}\n`).join(""),
    );
    tag(newImage, "sha256:newbot");
    tag("ghcr.io/yourssu/radar-backend:sha-000000000001", "sha256:radar");
    tag("ghcr.io/yourssu/shookie-other:sha-000000000001", "sha256:other");

    const result = run();

    expect(result.status, result.output).toBe(0);
    const id = pointer()!;
    expect(id).not.toBe("s-old");
    expect(tagId(`shookie-rollback/bot:${id}`)).toBe("sha256:oldbot");
    expect(snapshotTags()).toHaveLength(1);
    expect(ups()).toEqual([`UP image=${newImage} args=up -d --no-build --no-deps bot`]);
    expect(botImage()).toBe("sha256:newbot");
    expect(read("db", "id")).toBe("cid-db");
    // Order: pull happened before the snapshot tag and before up.
    const log = dockerLog();
    expect(log.indexOf(`docker pull ${newImage}`)).toBeLessThan(log.indexOf("docker tag"));
    expect(log.indexOf("docker tag")).toBeLessThan(log.indexOf("compose up"));
    // Retention: keep newest 3 of this repository only.
    expect(tagId(newImage)).not.toBeNull();
    expect(tagId("ghcr.io/yourssu/shookie:sha-000000000004")).not.toBeNull();
    expect(tagId("ghcr.io/yourssu/shookie:sha-000000000003")).not.toBeNull();
    expect(tagId("ghcr.io/yourssu/shookie:sha-000000000002")).toBeNull();
    expect(tagId("ghcr.io/yourssu/shookie:sha-000000000001")).toBeNull();
    expect(tagId("ghcr.io/yourssu/shookie:sha-0000000000ff")).toBeNull();
    expect(readFileSync(path.join(sandbox, "home/.shookie-deploy-history"), "utf8").trim().split("\n").pop()).toBe(newImage);
    expect(tagId("ghcr.io/yourssu/radar-backend:sha-000000000001")).not.toBeNull();
    expect(tagId("ghcr.io/yourssu/shookie-other:sha-000000000001")).not.toBeNull();
    expect(readFileSync(path.join(sandbox, "home/.shookie-deploy-state"), "utf8")).toContain(`bot=${newImage}`);
    expectNoForbiddenDockerCommands();
  });

  it("uses only the compose override for the bot and keeps runtime configuration", () => {
    const result = run({ DEPLOY_SLACK_USER_OAUTH_PORT: "3000", DEPLOY_SLACK_BOT_TOKEN: "xoxb-1", DEPLOY_POSTGRES_PASSWORD: "pg" });
    expect(result.status, result.output).toBe(0);
    const env = read("up_env_1")!;
    expect(env).toContain("COMPOSE_FILE=docker-compose.yml:docker-compose.deploy.yml");
    expect(env).toContain(`SHOOKIE_BOT_IMAGE=${newImage}`);
    expect(env).toContain("LLM_BASE_URL=https://api.deepseek.com");
    expect(env).toContain("LLM_MODEL=deepseek-flash");
    expect(env).toContain("THREAD_WORKSPACE_BASE_PATH=/tmp/shookie-workspaces");
    expect(env).toContain("THREAD_WORKSPACE_MAX_GB=5");
    expect(env).toContain("LOG_LEVEL=debug");
    expect(env).toContain("SLACK_BOT_TOKEN=xoxb-1");
    expect(env).toContain("POSTGRES_PASSWORD=pg");
    expect(env).toContain("SLACK_USER_OAUTH_PORT=3000");
  });

  it("failed pull leaves the running bot, snapshots and DB untouched", () => {
    healthyCurrentBot();
    const result = run({ MOCK_PULL_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(ups()).toEqual([]);
    expect(pointer()).toBeNull();
    expect(snapshotTags()).toEqual([]);
    expect(botImage()).toBe("sha256:oldbot");
    expectNoForbiddenDockerCommands();
  });

  it("docker inspect failure aborts before replacement", () => {
    healthyCurrentBot();
    const result = run({ MOCK_INSPECT_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(ups()).toEqual([]);
    expect(botImage()).toBe("sha256:oldbot");
    expect(pointer()).toBeNull();
  });

  it("snapshot tag failure aborts before replacement and keeps the previous snapshot", () => {
    healthyCurrentBot();
    tag("shookie-rollback/bot:s-old", "sha256:ancientbot");
    writeFileSync(path.join(sandbox, "home/.shookie-rollback-snapshot"), "s-old\n");
    const result = run({ MOCK_TAG_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("could not tag the bot snapshot");
    expect(ups()).toEqual([]);
    expect(pointer()).toBe("s-old");
    expect(snapshotTags()).toEqual(["shookie-rollback__bot--s-old"]);
    expect(tagId("shookie-rollback/bot:s-old")).toBe("sha256:ancientbot");
  });

  it("unresolvable current image aborts before replacement", () => {
    // The container references an image id the daemon no longer knows (not a sha256:/id: pseudo id).
    container("dangling-unknown");
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("could not resolve the bot image");
    expect(ups()).toEqual([]);
    expect(pointer()).toBeNull();
  });

  it("failed replacement restores the bot from the snapshot and the deploy still fails", () => {
    healthyCurrentBot();
    const result = run({ MOCK_UP_FAIL_FIRST: "1" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Rolling back to rollback snapshot");
    expect(result.output).toContain("Rollback succeeded");
    const id = pointer()!;
    expect(ups()).toEqual([
      `UP image=${newImage} args=up -d --no-build --no-deps bot`,
      `UP image=shookie-rollback/bot:${id} args=up -d --no-build --no-deps bot`,
    ]);
    expect(botImage()).toBe("sha256:oldbot");
    expectNoForbiddenDockerCommands();
  });

  for (const [name, imageTag] of [
    ["never reports Socket Mode readiness", "sha-noready000000"],
    ["crash loops", "sha-crashloop0000"],
    ["restarts right after it reports ready", "sha-flap00000000"],
  ] as const) {
    it(`a new bot that ${name} is rolled back and the deploy fails`, () => {
      healthyCurrentBot();
      const result = run({ IMAGE_TAG: imageTag });
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("did not become ready");
      expect(result.output).toContain("Rollback succeeded");
      expect(botImage()).toBe("sha256:oldbot");
      expect(ups()).toHaveLength(2);
      expect(existsSync(path.join(sandbox, "home/.shookie-deploy-history"))).toBe(false);
      expectNoForbiddenDockerCommands();
    });
  }

  it("a rollback that does not become ready is reported and the deploy fails", () => {
    healthyCurrentBot("sha256:oldbot-noready");
    // Old snapshot image itself will not report ready either.
    const result = run({ IMAGE_TAG: "sha-noready000000" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Rollback did not become ready; manual intervention required");
  });

  it("first conversion from a locally built image preserves and restores it by image ID", () => {
    container("sha256:localbot", "shookie-bot");
    const result = run({ IMAGE_TAG: "sha-noready000000" });
    expect(result.status).not.toBe(0);
    const id = pointer()!;
    expect(tagId(`shookie-rollback/bot:${id}`)).toBe("sha256:localbot");
    expect(botImage()).toBe("sha256:localbot");
  });

  it("first ever deploy has no snapshot, and a failing first deploy has nothing to roll back to", () => {
    const ok = run();
    expect(ok.status, ok.output).toBe(0);
    expect(ok.output).toContain("first deploy");
    expect(pointer()).toBeNull();

    rmSync(state, { recursive: true, force: true });
    mkdirSync(state, { recursive: true });
    const failed = run({ IMAGE_TAG: "sha-noready000000" });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain("No rollback snapshot available");
    expect(ups()).toHaveLength(1);
  });

  it("an already crash-looping bot is replaced without a snapshot and stale snapshots are never used", () => {
    container("sha256:crashloopbot");
    tag("shookie-rollback/bot:s-old", "sha256:ancientbot");
    writeFileSync(path.join(sandbox, "home/.shookie-rollback-snapshot"), "s-old\n");

    const ok = run();
    expect(ok.status, ok.output).toBe(0);
    expect(ok.output).toContain("not running stably");
    expect(pointer()).toBe("s-old");
    expect(tagId("shookie-rollback/bot:s-old")).toBe("sha256:ancientbot");

    container("sha256:crashloopbot");
    rmSync(path.join(state, "ups"));
    const failed = run({ IMAGE_TAG: "sha-noready000000" });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain("No rollback snapshot available");
    expect(ups()).toHaveLength(1);
  });

  // --- shared PostgreSQL ------------------------------------------------------------------------

  it("aborts before pulling when the shared DB container is missing, unhealthy, or not accepting connections", () => {
    healthyCurrentBot();
    for (const [flag, message] of [
      ["MOCK_DB_MISSING", "not running"],
      ["MOCK_DB_UNHEALTHY", "not healthy"],
      ["MOCK_PG_FAIL", "no response"],
    ] as const) {
      rmSync(state, { recursive: true, force: true });
      mkdirSync(state, { recursive: true });
      healthyCurrentBot();
      const result = run({ [flag]: "1" });
      expect(result.status, flag).not.toBe(0);
      expect(result.output).toContain(message);
      expect(dockerLog(), flag).not.toContain("docker pull");
      expect(ups(), flag).toEqual([]);
    }
  });

  it("fails the deploy when the shared DB identity changes during the deploy and keeps the success record unwritten", () => {
    healthyCurrentBot();
    const result = run({ MOCK_DB_BOUNCE_ON_UP: "1" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Shared PostgreSQL identity or start time changed");
    expect(existsSync(path.join(sandbox, "home/.shookie-deploy-state"))).toBe(false);
    // The app deploy itself never touched the DB compose beyond ps/exec.
    expectNoForbiddenDockerCommands();
  });

  it("still checks the shared DB after a failed deploy and rollback", () => {
    healthyCurrentBot();
    const result = run({ IMAGE_TAG: "sha-noready000000", MOCK_DB_BOUNCE_ON_UP: "1" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Rollback succeeded");
    expect(result.output).toContain("Shared PostgreSQL identity or start time changed");
  });

  it("checks DB identity, health and pg_isready both before and after a successful deploy", () => {
    const result = run();
    expect(result.status, result.output).toBe(0);
    const log = dockerLog().split("\n");
    const execs = log.filter((l) => l.includes("-f docker-compose.db.yml exec -T db pg_isready -U postgres -d shookie"));
    expect(execs).toHaveLength(2);
    expect(log.findIndex((l) => l === execs[0])).toBeLessThan(log.findIndex((l) => l.includes("docker pull")));
    expect(log.findIndex((l) => l.includes("compose up"))).toBeLessThan(log.lastIndexOf(execs[1]!));
  });

  // --- host hygiene / secrets ---------------------------------------------------------------------

  it("refuses to run while another deploy holds the lock", () => {
    healthyCurrentBot();
    const result = run({ MOCK_FLOCK_BUSY: "1" });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Another deploy is already running");
    expect(dockerLog()).toBe("");
  });

  it("removes the temporary docker auth dir and git askpass helper, and logs in only into the temporary config", () => {
    const result = run();
    expect(result.status, result.output).toBe(0);
    const loginConfig = read("login_env")!.replace("docker-config=", "");
    expect(loginConfig).not.toBe("unset");
    expect(existsSync(loginConfig)).toBe(false);
    expect(read("pull_env")).toContain(`docker-config=${loginConfig}`);
    expect(readdirSync(path.join(sandbox, "home")).filter((f) => f.startsWith(".shookie-git-askpass."))).toEqual([]);
  });

  it("secret values with shell metacharacters reach compose literally and are never executed", () => {
    const canary = path.join(sandbox, "pwned");
    const hostile: Record<string, string> = {
      DEPLOY_POSTGRES_PASSWORD: `pa$$ w'o"rd; touch ${canary}-1 #`,
      DEPLOY_SLACK_BOT_TOKEN: `$(touch ${canary}-2)\`touch ${canary}-3\``,
      DEPLOY_SLACK_APP_TOKEN: `a b\\c \${HOME} $USER && touch ${canary}-4`,
      DEPLOY_LLM_API_KEY: `line1\nline2 'single' "double" |&;<>*?`,
      DEPLOY_GITHUB: `ghp_$x"y'z\``,
      DEPLOY_SHOOKIE_MENTION_GROUPS_API_KEY: `$(touch ${canary}-5)`,
    };
    const result = run(hostile);
    expect(result.status, result.output).toBe(0);
    const recorded = read("up_env_1")!;
    expect(recorded).toContain(`POSTGRES_PASSWORD=${hostile.DEPLOY_POSTGRES_PASSWORD}`);
    expect(recorded).toContain(`SLACK_BOT_TOKEN=${hostile.DEPLOY_SLACK_BOT_TOKEN}`);
    expect(recorded).toContain(`SLACK_APP_TOKEN=${hostile.DEPLOY_SLACK_APP_TOKEN}`);
    expect(recorded).toContain(`LLM_API_KEY=${hostile.DEPLOY_LLM_API_KEY}`);
    expect(recorded).toContain(`GITHUB=${hostile.DEPLOY_GITHUB}`);
    expect(recorded).toContain(`SHOOKIE_MENTION_GROUPS_API_KEY=${hostile.DEPLOY_SHOOKIE_MENTION_GROUPS_API_KEY}`);
    expect(readdirSync(sandbox).filter((f) => f.startsWith("pwned"))).toEqual([]);
    expect(result.output).not.toContain("pa$$ w'o");
  });

  it("matches the Korean readiness marker byte-wise even under the C locale", () => {
    const result = run({ LC_ALL: "C", LANG: "C" });
    expect(result.status, result.output).toBe(0);
  });

  it("script contains no direct secret interpolation", () => {
    expect(deployScript()).not.toContain("${{");
  });
});
