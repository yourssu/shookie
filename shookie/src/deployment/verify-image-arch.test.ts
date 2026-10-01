import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executable, makeTempDir, repoRoot, rmSync } from "./test-helpers.js";
import path from "node:path";

/** scripts/verify-image-arch.sh against fake `docker buildx imagetools inspect` output. */
describe("verify-image-arch.sh", () => {
  const single = '{"architecture":"arm64","os":"linux","config":{}}';
  const singleAmd64 = '{"architecture":"amd64","os":"linux","config":{}}';
  const indexWithArm64 = '{"linux/amd64":{"architecture":"amd64","os":"linux"},"linux/arm64":{"architecture":"arm64","os":"linux"}}';
  const indexWithoutArm64 = '{"linux/amd64":{"architecture":"amd64","os":"linux"}}';
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("shookie-verify-arch-");
    executable("docker-imagetools", path.join(dir, "docker"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function verify(imageJson: string | null, fail = false) {
    const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH ?? ""}` };
    if (imageJson !== null) env.MOCK_IMAGE_JSON = imageJson;
    if (fail) env.MOCK_IMAGETOOLS_FAIL = "1";
    const result = spawnSync("bash", [path.join(repoRoot, "scripts/verify-image-arch.sh"), "ghcr.io/x/y:sha-1"], { env, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  it("accepts a single platform manifest without a Platform line", () => {
    const result = verify(single);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("linux/arm64");
  });

  it("accepts an image index containing arm64", () => {
    expect(verify(indexWithArm64).status).toBe(0);
  });

  it("rejects the wrong architecture with a clear message", () => {
    for (const json of [singleAmd64, indexWithoutArm64]) {
      const result = verify(json);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("does not provide linux/arm64");
      expect(result.output).toContain("linux/amd64");
    }
  });

  it("rejects registry failures and unparsable output", () => {
    const registry = verify(null, true);
    expect(registry.status).not.toBe(0);
    expect(registry.output).toContain("Could not inspect image");
    for (const json of ["not json", "null", "[]", ""]) expect(verify(json).status, json).not.toBe(0);
  });
});
