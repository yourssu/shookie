import { mkdirSync, copyFileSync } from "node:fs";
const target = new URL("../dist/agent/guidance/", import.meta.url);
mkdirSync(target, { recursive: true });
for (const file of ["github.v1.md", "posthog.v1.md"]) {
  copyFileSync(new URL(`../src/agent/guidance/${file}`, import.meta.url), new URL(file, target));
}
const { loadDomainGuidance } = await import("../dist/agent/domain-guidance.js");
for (const domain of ["github", "posthog"]) {
  if (loadDomainGuidance(domain).status !== "success") throw new Error("Packaged guidance unavailable");
}
