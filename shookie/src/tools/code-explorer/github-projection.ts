import type { ReadInput } from "./github-read.js";

type Row = Record<string, any>;
// Never copy objects from upstream: optional evidence is typed and explicitly selected.
function pick(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.filter(key => row[key] === null || ["string", "number", "boolean"].includes(typeof row[key])).map(key => [key, row[key]]));
}
const dates = ["created_at", "updated_at", "closed_at"];
const identity = ["number", "title", "state", "html_url", ...dates];
export function projectGithub(input: ReadInput, raw: any): { data: any; truncated: boolean } {
  let truncated = false;
  const text = (value: string, bytes: number) => {
    if (Buffer.byteLength(value) <= bytes) return value;
    truncated = true;
    let output = ""; let size = 0;
    for (const char of value) { const n = Buffer.byteLength(char); if (size + n > bytes) break; output += char; size += n; }
    return output;
  };
  const bounded = (row: Row, key: string, bytes: number) => {
    if (typeof row[key] === "string") { const original = row[key]; row[key] = text(original, bytes); if (original !== row[key]) row[`${key}Truncated`] = true; }
    return row;
  };
  const repository = (row: Row) => bounded(pick(row, ["name", "full_name", "html_url", "description", "private", "archived", "default_branch", "language", ...dates, "pushed_at"]), "description", 2048);
  const entry = (row: Row, detail: boolean) => {
    const out = bounded(pick(row, [...identity, ...(input.operation.startsWith("pull_request") ? ["merged_at"] : [])]), "title", 1024);
    // GitHub's issues endpoint also returns PRs; retain the discriminator.
    if (["issues", "issue"].includes(input.operation) && row.pull_request && typeof row.pull_request === "object") {
      out.pull_request = pick(row.pull_request, ["html_url", "merged_at"]);
    }
    if (detail) {
      Object.assign(out, pick(row, ["body", "draft", "comments", "locked", ...(input.operation === "pull_request" ? ["merged", "merge_commit_sha", "mergeable", "mergeable_state", "commits", "additions", "deletions", "changed_files", "review_comments"] : [])]));
      bounded(out, "body", 8192);
      if (input.operation === "pull_request") for (const key of ["base", "head"]) {
        if (row[key] && typeof row[key] === "object") {
          out[key] = pick(row[key], ["label", "ref", "sha"]);
          if (row[key].repo && typeof row[key].repo === "object") out[key].repo = pick(row[key].repo, ["full_name", "html_url"]);
        }
      }
    }
    return out;
  };
  let data: any;
  switch (input.operation) {
    case "repositories": data = raw.map(repository); break;
    case "repository": data = repository(raw); break;
    case "pull_requests": case "issues": data = raw.map((row: Row) => entry(row, false)); break;
    case "pull_request": case "issue": data = entry(raw, true); break;
    case "history": data = raw.map((row: Row) => {
      const out = pick(row, ["sha", "html_url"]);
      out.subject = text(row.commit.message.split(/\r?\n/, 1)[0], 1024);
      const date = row.commit.committer?.date ?? row.commit.author?.date;
      if (typeof date === "string") out.date = date;
      return out;
    }); break;
    case "tree": data = { ...pick(raw, ["sha", "truncated"]), tree: raw.tree.map((row: Row) => pick(row, ["path", "mode", "type", "sha", "size"])) }; break;
    case "file": data = pick(raw, ["type", "encoding", "content", "size", "sha", "path", "html_url"]); break;
  }
  return { data, truncated };
}

// Budget serialized, redacted UTF-8 JSON; keep JSON structure and disclose actual omissions.
export function budgetGithub(data: any, serialize: (data: any) => string, maxBytes: number) {
  let text = serialize(data);
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const envelope: Row = { incomplete: true, reason: "model_output_byte_limit", data };
  if (Array.isArray(data)) {
    envelope.data = [...data]; envelope.omittedItems = 0;
    do { envelope.data.pop(); envelope.omittedItems++; text = serialize(envelope); } while (Buffer.byteLength(text) > maxBytes && envelope.data.length);
  } else if (Array.isArray(data.tree)) {
    envelope.data = { ...data, tree: [...data.tree] }; envelope.omittedItems = 0;
    do { envelope.data.tree.pop(); envelope.omittedItems++; text = serialize(envelope); } while (Buffer.byteLength(text) > maxBytes && envelope.data.tree.length);
  } else {
    envelope.data = pick(data, ["sha", "path", "size", "type", "encoding", "number", "state"]);
    envelope.omittedFields = Object.keys(data).filter(key => !(key in envelope.data));
    text = serialize(envelope);
  }
  if (Buffer.byteLength(text) > maxBytes) text = serialize({ incomplete: true, reason: "model_output_byte_limit", omittedAll: true });
  return { text, truncated: true };
}
