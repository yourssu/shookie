import type { ProjectKnowledge } from "../types.js";
import { ssutimeKnowledge } from "./ssutime-prod.js";
import { soongptKnowledge } from "./soongpt-prod.js";

const posthogKnowledge: ProjectKnowledge[] = [
  ssutimeKnowledge,
  soongptKnowledge,
];

export function getPostHogKnowledge(projectName: string): string | null {
  const entry = posthogKnowledge.find((k) => k.key === projectName);
  return entry?.instructions ?? null;
}

export function getAllPostHogKnowledge(): Map<string, string> {
  const map = new Map<string, string>();
  for (const k of posthogKnowledge) {
    map.set(k.key, k.instructions);
  }
  return map;
}
