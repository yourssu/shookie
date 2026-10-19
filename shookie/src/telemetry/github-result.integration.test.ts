import { expect, it } from "vitest";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { readGithub } from "../tools/code-explorer/github-read.js";
import { ExecutionScope, executionStorage, executionTools } from "../cancellation/execution-context.js";
import { RequestMetrics, type MetricRecord } from "./metrics.js";

it.each([false, true])("latest GitHub projection data:string is measured independently of unknown envelope; detail=%s", async detail => {
  const pr = { number: 1, title: "PRIVATE_한😀", state: "closed", html_url: "https://github.com/synthetic/allowed/pull/1", created_at: "2026-01-01T00:00:00Z", body: "한😀".repeat(10_000), user: { email: "PRIVATE_USER@example.invalid" } };
  const output = await readGithub({ owner: "synthetic", gitHubToken: "synthetic-secret", repositories: ["allowed"] },
    detail ? { operation: "pull_request", repo: "allowed", number: 1 } : { operation: "pull_requests", repo: "allowed", perPage: 3 },
    async () => Response.json(detail ? pr : [pr, { ...pr, number: 2 }, { ...pr, number: 3 }]));
  expect(typeof output.data).toBe("string");
  expect(output.truncated).toBe(detail);
  const records: MetricRecord[] = [];
  const scope = new ExecutionScope(); scope.metrics = new RequestMetrics(0, () => 1, record => records.push(record));
  const tool = executionTools({ github_read: createTool({ id: "github_read", description: "synthetic", inputSchema: z.object({}), execute: async () => output }) });
  try {
    expect(await executionStorage.run(scope, () => tool.github_read.execute!({}, {} as never))).toBe(output);
    await scope.drain();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "tool", tool: "github_read", status: "success", totalResultBytes: null, totalResultBytesStatus: "unknown",
      dataJsonBytes: Buffer.byteLength(JSON.stringify(output.data)), dataJsonBytesStatus: "exact", textJsonBytes: null, contentJsonBytes: null, truncated: detail });
    // The scope is one JSON-encoded string value, not raw string bytes or envelope bytes.
    expect(records[0].dataJsonBytes).toBeGreaterThan(Buffer.byteLength(output.data));
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE|https|synthetic-secret|allowed|body|email/);
  } finally { scope.control.finish(); }
});
