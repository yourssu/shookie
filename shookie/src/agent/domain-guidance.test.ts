import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createDomainGuidanceTool, loadDomainGuidance, guidanceByteLimit } from "./domain-guidance.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));
afterEach(() => { vi.restoreAllMocks(); });
describe("trusted fixed guidance assets", () => {
  it("loads only versioned code-owned assets and rejects resource discovery", () => {
    for (const domain of ["github", "posthog"]) expect(loadDomainGuidance(domain)).toMatchObject({ status: "success", domain, version: "1" });
    for (const domain of ["../github", "constructor", "__proto__", "https://evil/", "/tmp/AGENTS.md", "radar", "GITHUB", null])
      expect(loadDomainGuidance(domain)).toEqual({ status: "error", error: "unsupported_domain" });
    expect(loadDomainGuidance("github", "2")).toEqual({ status: "error", error: "unsupported_version" });
  });
  it("fails safely for missing, empty, invalid UTF8 and oversized files with bounded reads", () => {
    vi.spyOn(fs, "openSync").mockImplementation(() => { throw new Error("private/path"); });
    expect(loadDomainGuidance("github")).toEqual({ status: "error", error: "guidance_unavailable" });
    vi.restoreAllMocks();
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff]), Buffer.from("한".repeat(guidanceByteLimit))]) {
      let position = 0;
      vi.spyOn(fs, "readSync").mockImplementation(((_fd: unknown, output: Buffer, offset: number, length: number) => {
        expect(length).toBeLessThanOrEqual(guidanceByteLimit + 1);
        const count = Math.min(length, bytes.length - position);
        bytes.copy(output, offset, position, position + count); position += count; return count;
      }) as typeof fs.readSync);
      expect(loadDomainGuidance("github")).toEqual({ status: "error", error: "guidance_unavailable" });
      expect(position).toBeLessThanOrEqual(guidanceByteLimit + 1);
      vi.restoreAllMocks();
    }
  });
  it("advertises deterministic available domains only and disallows extra input", async () => {
    const tool = createDomainGuidanceTool(["posthog", "github", "posthog"]);
    expect(tool.description).toContain("github, posthog");
    expect(await tool.inputSchema!["~standard"].validate({ domain: "github", version: "1", path: "/tmp" })).toHaveProperty("issues");
    expect(await createDomainGuidanceTool([]).execute!({ domain: "github", version: "1" }, {} as never)).toMatchObject({ error: "domain_unavailable" });
  });
  it("build artifact loads outside cwd; Docker copies sources/scripts and runs asset-verifying build", () => {
    const script = `const {loadDomainGuidance}=await import(${JSON.stringify(new URL("../../dist/agent/domain-guidance.js", import.meta.url).href)}); for(const d of ['github','posthog']) if(loadDomainGuidance(d).status!=='success') process.exit(1)`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: "/tmp", timeout: 5000 });
    const docker = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    expect(docker).toContain("COPY shookie/ shookie/");
    expect(docker).toContain("RUN yarn workspace shookie build");
    const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts.build).toContain("node scripts/copy-guidance.mjs");
  });
});
