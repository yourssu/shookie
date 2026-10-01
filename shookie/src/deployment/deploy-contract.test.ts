import { describe, expect, it } from "vitest";
import { deployScript, deployWorkflow, jobText, readRepoFile } from "./test-helpers.js";

/** Guards the CI-built-image deployment: no server builds, pull before replace, arm64, immutable tags, shared DB. */
describe("deployment contract", () => {
  const workflow = deployWorkflow();
  const build = jobText(workflow, "build");
  const buildWithoutComments = build
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  const deploy = jobText(workflow, "deploy");
  const script = deployScript(workflow);
  const code = script
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

  it("EC2 never builds images or runs global cleanup", () => {
    for (const forbidden of [
      "docker compose build",
      "docker builder prune",
      "docker image prune",
      "docker system prune",
      "docker compose down",
      "docker volume",
      "docker network",
      "--build",
      "--force-recreate",
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    expect(code).toContain("docker compose up -d --no-build --no-deps bot");
    expect(code).toContain("COMPOSE_FILE=docker-compose.yml:docker-compose.deploy.yml");
    // Secrets only ever travel through action env + envs, never interpolated into shell text.
    expect(script).not.toContain("${{");
  });

  it("the shared PostgreSQL compose file is only ever inspected, never changed", () => {
    const dbCalls = code.split("\n").filter((line) => line.includes("docker-compose.db.yml"));
    expect(dbCalls.length).toBeGreaterThan(0);
    for (const line of dbCalls) {
      expect(line).toMatch(/docker compose -f docker-compose\.db\.yml (ps -q db|exec -T db pg_isready -U postgres -d shookie)/);
    }
    expect(code).toContain("DB_CONTAINER_ID_BEFORE");
    expect(code).toContain("DB_STARTED_AT_BEFORE");
    expect(code).toContain("check_db_unchanged");
  });

  it("images are built for linux/arm64 with immutable sha tags and no build secrets", () => {
    expect(build).toContain("docker/build-push-action@");
    expect(build).toContain("platforms: linux/arm64");
    expect(build).toContain("file: shookie/Dockerfile");
    expect(build).toContain("provenance: false");
    expect(build).toContain("tags: ${{ steps.meta.outputs.bot_image }}");
    expect(buildWithoutComments).not.toMatch(/build-args|secret-files|^\s+secrets:/m);
    expect(build).toContain('tag="sha-${GITHUB_SHA::12}"');
    expect(build).toContain('prefix="ghcr.io/${GITHUB_REPOSITORY,,}"');
    expect(workflow).not.toContain(":latest");
    expect(build).toContain("docker/setup-qemu-action@");
    expect(build).toContain("docker/setup-buildx-action@");
    expect(build).toContain('bash scripts/verify-image-arch.sh "$BOT_IMAGE" linux/arm64');
    expect(workflow).not.toContain("Platform:");
  });

  it("only main pushes images and deploys; pull requests only build", () => {
    expect(build).toContain("PUSH_IMAGES: ${{ github.event_name != 'pull_request' && github.ref == 'refs/heads/main' }}");
    expect(build).toContain("push: ${{ env.PUSH_IMAGES == 'true' }}");
    expect(build).toMatch(/Log in to GHCR\n\s+if: \$\{\{ env\.PUSH_IMAGES == 'true' \}\}/);
    expect(deploy).toContain("github.ref == 'refs/heads/main'");
    expect(deploy).toContain("github.event_name != 'pull_request'");
    expect(deploy).toContain("needs: build");
    expect(workflow).toMatch(/pull_request:\n\s+paths:/);
    expect(workflow).toMatch(/push:\n\s+branches: \[main\]/);
  });

  it("a running deployment is never cancelled while stale builds may be", () => {
    expect(deploy).toMatch(/concurrency:\n\s+group: deploy-ec2\n\s+cancel-in-progress: false/);
    expect(build).toMatch(/concurrency:\n\s+group: build-shookie-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/);
    expect(deploy).toContain("gh api \"repos/${GITHUB_REPOSITORY}/commits/main\"");
    expect(code).toContain("flock -n 9");
  });

  it("uses least-privilege token permissions", () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(build).toMatch(/permissions:\n\s+contents: read\n\s+packages: write/);
    expect(deploy).toMatch(/permissions:\n\s+contents: read\n\s+packages: read/);
    expect(deploy).not.toContain("packages: write");
  });

  it("supports manual rollback to an existing SHA image without rebuilding", () => {
    expect(workflow).toContain("rollback_sha:");
    expect(build).toContain("if: ${{ inputs.rollback_sha == '' }}");
    expect(deploy).toContain("^[0-9a-f]{12,40}$");
    expect(deploy).toContain("needs.build.result == 'skipped'");
  });

  it("every compose variable used by the bot is delivered by the deploy workflow", () => {
    const compose = readRepoFile("docker-compose.yml");
    const botSection = compose.slice(compose.indexOf("  bot:"));
    const names = [...botSection.matchAll(/\$\{([A-Z0-9_]+)(?:[:?-][^}]*)?\}/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    for (const name of new Set(names)) {
      expect(script, `${name} is not exported by the deploy script`).toMatch(new RegExp(`^export ${name}=`, "m"));
      if (name !== "LLM_BASE_URL" && name !== "LLM_MODEL" && name !== "LOG_LEVEL") {
        expect(workflow, `${name} is not passed through the ssh-action envs`).toContain(`DEPLOY_${name}`);
      }
    }
    // The workflow must not deliver variables the compose file does not know about.
    for (const [, name] of script.matchAll(/^export ([A-Z0-9_]+)="\$\{DEPLOY_/gm)) {
      expect(names, `${name} is exported but unused by compose`).toContain(name);
    }
    // Every DEPLOY_ value in env is listed in envs and vice versa.
    const envNames = [...deploy.matchAll(/^ {10}(DEPLOY_[A-Z0-9_]+):/gm)].map((m) => m[1]!);
    const envsLine = deploy.match(/^ {10}envs: (.*)$/m)![1]!.split(",");
    for (const name of envNames) expect(envsLine, name).toContain(name);
    for (const name of envsLine.filter((n) => n.startsWith("DEPLOY_"))) expect(envNames, name).toContain(name);
  });

  it("preserves the previous fixed runtime values", () => {
    for (const line of [
      "export LLM_BASE_URL=https://api.deepseek.com",
      "export LLM_MODEL=deepseek-flash",
      "export THREAD_WORKSPACE_BASE_PATH=/tmp/shookie-workspaces",
      "export THREAD_WORKSPACE_MAX_GB=5",
      "export LOG_LEVEL=debug",
    ]) {
      expect(script).toContain(line);
    }
  });

  it("the deploy override requires the CI image reference and never pulls or builds on the host", () => {
    const override = readRepoFile("docker-compose.deploy.yml");
    expect(override).toContain("${SHOOKIE_BOT_IMAGE:?");
    expect(override.match(/pull_policy: never/g)).toHaveLength(1);
    expect(override).not.toContain("db:");
    expect(override).not.toMatch(/^\s+build:/m);
    // Local development keeps building from source.
    const compose = readRepoFile("docker-compose.yml");
    expect(compose).toMatch(/bot:\n\s+image: shookie-bot:local\n\s+build:\n\s+context: \./);
    expect(compose).toContain("name: shookie_default\n    external: true");
  });

  it("the local compose files keep the shared DB lifecycle separate", () => {
    const db = readRepoFile("docker-compose.db.yml");
    expect(db).toContain("pgdata:/var/lib/postgresql/data");
    expect(db).toContain("name: shookie_pgdata");
    expect(readRepoFile("docker-compose.yml")).not.toMatch(/^ {2}db:/m);
  });
});
