import type { ProjectKnowledge } from "../types.js";
import { soongptWebKnowledge } from "./soongpt-web.js";
import { soongptBackendKnowledge } from "./soongpt-backend.js";

const githubKnowledge: ProjectKnowledge[] = [
  soongptWebKnowledge,
  soongptBackendKnowledge,
];

export function getGitHubKnowledge(repoName: string): string | null {
  const entry = githubKnowledge.find((k) => k.key === repoName);
  return entry?.instructions ?? null;
}

export function getAllGitHubKnowledge(): Map<string, string> {
  const map = new Map<string, string>();
  for (const k of githubKnowledge) {
    map.set(k.key, k.instructions);
  }
  return map;
}
