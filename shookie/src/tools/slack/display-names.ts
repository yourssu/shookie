import { types } from "node:util";
import type { WebClient } from "@slack/web-api";

export type DisplayClient = Partial<Pick<WebClient, "users" | "bots" | "conversations">>;
// Read only own data properties. Accessors and proxies are not trusted metadata.
export function displayField(value: unknown, key: string): unknown {
  try { return value !== null && typeof value === "object" && !types.isProxy(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
  catch { return undefined; }
}
const field = displayField;
export function safeDisplayName(value: unknown, secret?: string): string | undefined {
  if (typeof value !== "string" || (secret && value.includes(secret))) return undefined;
  const name = value.trim();
  return name && name.length <= 80 && !/[<>@&\[\]`*_~\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : undefined;
}
/** Invocation-local display cache only. No grants, profiles or user OAuth credentials. */
export class SlackDisplayNames {
  private readonly cache = new Map<string, Promise<string | undefined>>();
  private readonly deadline = Date.now() + 750;
  private count = 0;
  constructor(private readonly client: DisplayClient, private readonly secret?: string) {}
  private lookup(key: string, load: () => Promise<unknown>, project: (raw: unknown) => unknown): Promise<string | undefined> {
    const prior = this.cache.get(key); if (prior) return prior;
    if (this.count >= 20 || Date.now() >= this.deadline) return Promise.resolve(undefined);
    this.count++;
    const result = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const raw = await Promise.race([load(), new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), Math.max(0, this.deadline - Date.now()));
        })]);
        if (field(raw, "ok") !== true || field(raw, "error")) return undefined;
        return safeDisplayName(project(raw), this.secret);
      } catch { return undefined; } finally { if (timer) clearTimeout(timer); }
    })();
    this.cache.set(key, result); return result;
  }
  async author(author: { userId: string | null; botId: string | null; kind: string }): Promise<string> {
    // A user-backed bot still uses users.info. bots.info is only for missing-user authors.
    let name: string | undefined;
    if (author.userId && /^[UW][A-Z0-9]{1,63}$/.test(author.userId)) {
      const user = author.userId;
      name = await this.lookup(`u:${user}`, async () => this.client.users?.info({ user }), raw => {
        const u = field(raw, "user"); if (field(u, "id") !== user) return undefined;
        const profile = field(u, "profile");
        return [field(profile, "display_name"), field(profile, "real_name"), field(u, "name")]
          .map(v => safeDisplayName(v, this.secret)).find(Boolean);
      });
    } else if (!author.userId && author.botId && /^B[A-Z0-9]{1,63}$/.test(author.botId)) {
      const bot = author.botId;
      name = await this.lookup(`b:${bot}`, async () => this.client.bots?.info({ bot }), raw => {
        const b = field(raw, "bot"); return field(b, "id") === bot ? field(b, "name") : undefined;
      });
    }
    return name ?? (author.kind === "shookie" ? "이 봇" : author.kind === "bot" || author.kind === "other_bot" ? "봇" : author.kind === "system" ? "시스템" : "참여자");
  }
  async channel(channel: string): Promise<string | undefined> {
    return this.lookup(`c:${channel}`, async () => this.client.conversations?.info({ channel }), raw => {
      const c = field(raw, "channel"); return field(c, "id") === channel ? field(c, "name") : undefined;
    });
  }
  // Sequential projection bounds concurrency to one, including channel lookup.
  async enrich(messages: { author: { userId: string | null; botId: string | null; kind: string; displayName?: string } }[]) {
    if (!this.client.users && !this.client.bots) return;
    for (const message of messages) message.author.displayName = await this.author(message.author);
  }
}
