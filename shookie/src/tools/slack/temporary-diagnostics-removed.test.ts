import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../../", import.meta.url));
const names = ["slack_action_token_diagnostic", "slack_search_response_diagnostic", "slack_read_response_diagnostic"];
function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? productionFiles(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("temporary Slack diagnostic removal", () => {
  it("has no production reference to the three temporary emit names or removed modules", () => {
    for (const path of productionFiles(src)) {
      const source = readFileSync(path, "utf8");
      // Exact retired module basenames; a distinct bounded cross-channel observer is not a reintroduction.
      for (const name of [...names, "/action-token-diagnostics.js\"", "/search-diagnostics.js\"", "/read-diagnostics.js\"", "disposeDiagnostics"]) {
        expect(source, path).not.toContain(name);
      }
    }
    for (const name of ["action-token-diagnostics", "search-diagnostics", "read-diagnostics"]) {
      expect(existsSync(join(src, "tools/slack", `${name}.ts`))).toBe(false);
    }
  });
});
