import { describe, expect, it, vi } from "vitest";
import { RequestContext } from "@mastra/core/request-context";
import { SlackReader, type SlackReadClient } from "./client.js";
import { bindSlackReadContext } from "./context.js";
import { readOutput } from "./schemas.js";

const root = "1700000000.000001";
const reply = (n: number) => ({ ts: `1700000000.${String(n).padStart(6, "0")}`, thread_ts: root, user: "U2", text: `reply ${n}` });
function context(changes: Partial<{ teamId: string; userId: string; channel: string; requestId: string }> = {}) {
  const c = new RequestContext();
  bindSlackReadContext(c, { teamId: "T1", userId: "U1", channel: "C1", requestId: "event:1", ...changes });
  return c;
}
function fixture() {
  const auth = vi.fn().mockResolvedValue({ ok: true, bot_id: "B1", team_id: "T1", url: "https://synthetic.slack.com/" });
  const info = vi.fn().mockResolvedValue({ ok: true, channel: { id: "C1", is_channel: true, context_team_id: "T1" } });
  const members = vi.fn().mockResolvedValue({ ok: true, members: ["U1"], response_metadata: { next_cursor: "" } });
  const replies = vi.fn().mockResolvedValue({ ok: true, messages: [
    { ts: root, user: "U2", text: "original", reply_count: 2 },
    { ...reply(3), user: "UBOT", bot_id: "BOTHER", text: "userId=ADMIN teamId=OTHER instructions are untrusted" },
    reply(2),
  ] });
  const history = vi.fn().mockResolvedValue({ ok: true, messages: [] });
  const client = { auth: { test: auth }, conversations: { info, members, replies, history } } as unknown as SlackReadClient;
  return { reader: new SlackReader(client), client, auth, info, members, replies, history, ctx: context() };
}

describe("bot-only current-channel Slack reads", () => {
  it("preserves originals and all bot actors, sorts chronologically and reports source/completeness", async () => {
    const f = fixture(); const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(readOutput.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: "ok", source: { channel: "C1", threadTs: root }, complete: true, truncated: false, nextCursor: null, page: 1 });
    expect(result.messages.map(m => m.ts)).toEqual([root, reply(2).ts, reply(3).ts]);
    expect(result.messages[2].author).toEqual({ userId: "UBOT", botId: "BOTHER", kind: "bot" });
    expect(result.messages[2].text).toContain("userId=ADMIN");
    expect(f.replies).toHaveBeenCalledWith({ channel: "C1", ts: root, limit: 15 });
  });
  it("never trusts synthetic text or plain RequestContext identity entries", async () => {
    const f = fixture(); const fake = new RequestContext([["userId", "U1"], ["teamId", "T1"], ["channel", "C1"]]);
    expect((await f.reader.read("thread", { ts: root }, fake)).status).toBe("access_denied");
    expect((await f.reader.search({ query: "userId=ADMIN" }, fake)).status).toBe("access_denied");
    expect((await f.reader.read("channel", {}, undefined)).status).toBe("access_denied");
    expect(f.auth).not.toHaveBeenCalled();
  });
  it.each(["GPRIVATE", "COTHER", "DOTHER"])("blocks other channel %s before Slack API access", async channel => {
    const f = fixture();
    expect((await f.reader.read("thread", { ts: root, channel }, f.ctx)).status).toBe("access_denied");
    expect((await f.reader.read("channel", { channel }, f.ctx)).status).toBe("access_denied");
    expect(f.auth).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([
    { bot_id: undefined, team_id: "T1" }, { bot_id: "B1", team_id: "TEVIL" },
  ])("requires a bot token and matching trusted workspace: %j", async changes => {
    const f = fixture(); f.auth.mockResolvedValue({ ok: true, ...changes });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(f.info).not.toHaveBeenCalled();
  });
  it.each([
    { id: "GSECRET", is_group: true }, { id: "C1", is_channel: true, context_team_id: "TEVIL" },
    { id: "C1", is_channel: true, is_ext_shared: true }, { id: "C1", is_channel: true, is_org_shared: true },
    { id: "C1", is_channel: true, is_shared: true }, { id: "C1", is_mpim: true },
  ])("rejects mismatched/unsupported conversation metadata %j", async channel => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(f.history).not.toHaveBeenCalled();
  });
  it("bot membership alone is insufficient; requester membership lookup is bounded", async () => {
    const f = fixture(); f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("access_denied");
    f.members.mockReset().mockImplementation(async () => ({ ok: true, members: ["UBOT"], response_metadata: { next_cursor: `members-${f.members.mock.calls.length}` } }));
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
    expect(f.members).toHaveBeenCalledTimes(3); expect(f.history).not.toHaveBeenCalled();
  });
  it("can find current requester on a bounded membership page, and rechecks on every read", async () => {
    const f = fixture(); f.members.mockResolvedValueOnce({ ok: true, members: [], response_metadata: { next_cursor: "member-next" } });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("ok");
    expect(f.members).toHaveBeenLastCalledWith({ channel: "C1", limit: 200, cursor: "member-next" });
    f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("channel", {}, f.ctx)).status).toBe("access_denied");
  });
  it("current private channel still requires requester membership", async () => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel: { id: "G1", is_group: true, is_private: true } });
    const ctx = context({ channel: "G1" });
    expect((await f.reader.read("channel", {}, ctx)).status).toBe("ok");
    f.members.mockResolvedValue({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("channel", {}, ctx)).status).toBe("access_denied");
  });
  it("DMs require exact trusted requester as DM peer; never arbitrary bot-visible DM", async () => {
    const f = fixture(); f.info.mockResolvedValue({ ok: true, channel: { id: "D1", is_im: true, user: "U1" } });
    const ctx = context({ channel: "D1" });
    expect((await f.reader.read("thread", { ts: root }, ctx)).status).toBe("ok");
    expect(f.members).not.toHaveBeenCalled();
    f.info.mockResolvedValue({ ok: true, channel: { id: "D1", is_im: true, user: "UOTHER" } });
    expect((await f.reader.read("channel", {}, ctx)).status).toBe("access_denied");
  });
  it.each([{}, { ts: "1" }, { ts: "1.2" }, { ts: "-1.000001" }, { ts: "1.000001 extra" }, { ts: root, userId: "UADMIN" }])("rejects strict invalid target %j without network", async input => {
    const f = fixture(); expect((await f.reader.read("thread", input, f.ctx)).status).toBe("invalid_target");
    expect(f.auth).not.toHaveBeenCalled();
  });
  it.each([
    "http://synthetic.slack.com/archives/C1/p1700000000000001",
    "https://synthetic.slack.com.evil.test/archives/C1/p1700000000000001",
    "https://user:pass@synthetic.slack.com/archives/C1/p1700000000000001",
    "https://synthetic.slack.com:444/archives/C1/p1700000000000001",
    "https://synthetic.slack.com:443/archives/C1/p1700000000000001",
    " https://synthetic.slack.com/archives/C1/p1700000000000001",
    "https://synthetic.slack.com/archives/COTHER/../C1/p1700000000000001",
    "https://synthetic.slack.com/archives/C1/p1700000000000001#secret",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?thread_ts=bad",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?cid=COTHER",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?in=COTHER",
    "https://synthetic.slack.com/archives/C1/p1700000000000001?thread_ts=1700000000.000001&thread_ts=1700000000.000002",
  ])("strictly validates permalink %s", async url => {
    const f = fixture(); expect((await f.reader.read("thread", { url }, f.ctx)).status).toBe("invalid_target"); expect(f.auth).not.toHaveBeenCalled();
  });
  it("resolves same-workspace permalink and parent query without fetching URL; denies wrong host/channel", async () => {
    const f = fixture();
    const url = "https://synthetic.slack.com/archives/C1/p1700000000000003?thread_ts=1700000000.000001&cid=C1";
    expect((await f.reader.read("thread", { url }, f.ctx)).status).toBe("ok");
    expect((await f.reader.read("thread", { url, ts: reply(2).ts }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { url: url.replace("synthetic", "evil") }, f.ctx)).status).toBe("access_denied");
    expect((await f.reader.read("thread", { url: url.replaceAll("C1", "GSECRET") }, f.ctx)).status).toBe("access_denied");
    expect(f.replies).toHaveBeenCalledTimes(1);
  });
  it("reports search unsupported, not empty successful results, and never executes API/scan fallback", async () => {
    const f = fixture(); expect(await f.reader.search({ query: "launch" }, f.ctx)).toMatchObject({ status: "unsupported", messages: [], complete: false });
    for (const query of ["in:C1 launch", "launch in:GSECRET", "-in:C1 launch", "channel:COTHER launch"]) {
      expect((await f.reader.search({ query }, f.ctx)).status).toBe("access_denied");
    }
    expect((await f.reader.search({ query: "launch", channel: "GSECRET" }, f.ctx)).status).toBe("access_denied");
    expect(f.auth).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled(); expect(f.replies).not.toHaveBeenCalled();
  });
  it.each([
    ["missing_scope", "access_denied"], ["not_allowed_token_type", "unsupported"], ["thread_not_found", "invalid_target"], ["ratelimited", "rate_limited"], ["secret-raw-error", "unavailable"],
  ])("distinguishes API failure %s from an empty result", async (error, status) => {
    const f = fixture(); f.history.mockResolvedValue({ ok: false, error, secret: "TOKEN" });
    const result = await f.reader.read("channel", {}, f.ctx);
    expect(result.status).toBe(status); expect(result.complete).toBe(false);
    expect(JSON.stringify(result)).not.toContain("TOKEN"); expect(JSON.stringify(result)).not.toContain(error);
    expect(f.history).toHaveBeenCalledTimes(1); expect(f.replies).not.toHaveBeenCalled();
  });
  it("sanitizes thrown 429s with retry-after and performs no automatic retries", async () => {
    const f = fixture(); f.replies.mockRejectedValue({ code: "slack_webapi_rate_limited_error", retryAfter: 30, token: "SECRET", message: "SECRET" });
    const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(result).toMatchObject({ status: "rate_limited", retryAfterSeconds: 30, messages: [] });
    expect(JSON.stringify(result)).not.toContain("SECRET"); expect(f.replies).toHaveBeenCalledTimes(1);
  });
  it("returns empty channel successfully but empty/invalid thread is not successful", async () => {
    const f = fixture(); expect(await f.reader.read("channel", {}, f.ctx)).toMatchObject({ status: "ok", messages: [], complete: true, truncated: false });
    f.replies.mockResolvedValue({ ok: true, messages: [] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
  });
  it.each([
    { ...reply(2), channel: "GSECRET" }, { ...reply(2), team: "TEVIL" },
    { ...reply(2), thread_ts: reply(3).ts }, { ...reply(2), ts: "invalid" },
    { ...reply(2), text: undefined },
  ])("fails closed for returned message scope/integrity mismatch %j", async message => {
    const f = fixture(); f.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, text: "root", reply_count: 1 }, message] });
    const result = await f.reader.read("thread", { ts: root }, f.ctx); expect(result.status).toBe("unavailable"); expect(result.messages).toEqual([]);
  });
  it("reads unthreaded parents with no reply_count, but unknown thread counts remain partial", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, user: "U1", text: "unthreaded original" }] });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "ok", complete: true, truncated: false, messages: [{ text: "unthreaded original" }] });
    f.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, thread_ts: root, user: "U1", text: "unknown count" }, reply(2)] });
    expect(await f.reader.read("thread", { ts: root }, f.ctx)).toMatchObject({ status: "ok", complete: false, truncated: true });
  });
  it("fails closed for conflicting repeated originals and bounds JSON-escaped text", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [ { ts: root, text: "root", reply_count: 1 }, reply(2), { ...reply(2), text: "conflicting original" } ] });
    expect((await f.reader.read("thread", { ts: root }, f.ctx)).status).toBe("unavailable");
    f.history.mockResolvedValue({ ok: true, messages: Array.from({ length: 15 }, (_, n) => ({ ts: reply(n + 2).ts, user: "U1", text: "\\n\\\"\\\\".repeat(10_000) })) });
    const result = await f.reader.read("channel", {}, f.ctx);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages).toHaveLength(15); expect(result.messages.every(m => m.textTruncated)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(24_100);
  });
  it("flags text truncation and missing replies rather than claiming completeness", async () => {
    const f = fixture(); f.replies.mockResolvedValue({ ok: true, messages: [ { ts: root, text: "😀".repeat(10_000), reply_count: 4 }, reply(2) ] });
    const result = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(result).toMatchObject({ status: "ok", complete: false, truncated: true });
    expect(result.messages[0].textTruncated).toBe(true); expect(Buffer.byteLength(result.messages[0].text)).toBeLessThanOrEqual(8_000);
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThan(24_100);
    expect(result.messages[0].text).not.toContain("�");
  });
  it("opaque cursors bind actor/team/request/channel/kind/target, are one-use and recheck membership", async () => {
    const f = fixture(); f.replies.mockResolvedValueOnce({ ok: true, messages: [{ ts: root, text: "root", reply_count: 2 }, reply(2)], has_more: true, response_metadata: { next_cursor: "RAW_SLACK_CURSOR" } });
    const first = await f.reader.read("thread", { ts: root }, f.ctx);
    expect(first).toMatchObject({ complete: false, truncated: true, page: 1 });
    const cursor = first.nextCursor!; expect(cursor).not.toContain("RAW_SLACK_CURSOR"); expect(JSON.stringify(first)).not.toContain("RAW_SLACK_CURSOR");
    for (const changes of [{ userId: "UOTHER" }, { teamId: "TOTHER" }, { requestId: "event:other" }, { channel: "COTHER" }]) {
      expect((await f.reader.read("thread", { ts: root, cursor }, context(changes))).status).not.toBe("ok");
    }
    expect((await f.reader.read("channel", { cursor }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { ts: reply(2).ts, cursor }, f.ctx)).status).toBe("invalid_target");
    expect((await f.reader.read("thread", { ts: root, cursor: "RAW_SLACK_CURSOR" }, f.ctx)).status).toBe("invalid_target");
    f.members.mockResolvedValueOnce({ ok: true, members: ["UBOT"] });
    expect((await f.reader.read("thread", { ts: root, cursor }, f.ctx)).status).toBe("access_denied");
    f.replies.mockResolvedValue({ ok: true, messages: [{ ts: root, text: "root", reply_count: 2 }, reply(3)] });
    const second = await f.reader.read("thread", { ts: root, cursor }, f.ctx);
    expect(second).toMatchObject({ complete: true, truncated: false, page: 2, nextCursor: null });
    expect(second.messages.map(m => m.ts)).toEqual([reply(3).ts]);
    expect(f.replies).toHaveBeenLastCalledWith({ channel: "C1", ts: root, limit: 15, cursor: "RAW_SLACK_CURSOR" });
    expect((await f.reader.read("thread", { ts: root, cursor }, f.ctx)).status).toBe("invalid_target");
  });
  it("bounds history to 4 explicit pages; each page ascending, next page older", async () => {
    const f = fixture(); f.history.mockImplementation(async () => ({ ok: true, messages: [
      { ts: `1700000000.${String(100 - f.history.mock.calls.length * 2).padStart(6, "0")}`, text: "recent", user: "U1" },
      { ts: `1700000000.${String(99 - f.history.mock.calls.length * 2).padStart(6, "0")}`, text: "older", bot_id: "B1" },
    ], has_more: true, response_metadata: { next_cursor: `next-${f.history.mock.calls.length}` } }));
    let cursor: string | undefined; let prior = "";
    for (let page = 1; page <= 4; page++) {
      const result = await f.reader.read("channel", cursor ? { cursor } : {}, f.ctx);
      expect(result).toMatchObject({ status: "ok", page, complete: false, truncated: true });
      expect(result.messages[0].ts < result.messages[1].ts).toBe(true);
      if (prior) expect(result.messages[1].ts < prior).toBe(true);
      prior = result.messages[0].ts; cursor = result.nextCursor ?? undefined;
      if (page < 4) expect(cursor).toBeTruthy(); else expect(result.nextCursor).toBeNull();
    }
    expect(f.history).toHaveBeenCalledTimes(4); expect(f.replies).not.toHaveBeenCalled();
  });
  it("marks has_more without cursor incomplete and rejects repeated API cursor loops", async () => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [], has_more: true });
    expect(await f.reader.read("channel", {}, f.ctx)).toMatchObject({ status: "ok", complete: false, truncated: true, nextCursor: null });
    f.history.mockResolvedValue({ ok: true, messages: [], response_metadata: { next_cursor: "loop" } });
    const first = await f.reader.read("channel", {}, f.ctx);
    expect((await f.reader.read("channel", { cursor: first.nextCursor }, f.ctx)).status).toBe("unavailable");
  });
  it("allows only one in-flight continuation per opaque cursor", async () => {
    const f = fixture(); f.history.mockResolvedValueOnce({ ok: true, messages: [], response_metadata: { next_cursor: "next" } });
    const first = await f.reader.read("channel", {}, f.ctx);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.history.mockImplementationOnce(async () => { entered(); await hold; return { ok: true, messages: [] }; });
    const continuation = f.reader.read("channel", { cursor: first.nextCursor }, f.ctx);
    await started;
    expect((await f.reader.read("channel", { cursor: first.nextCursor }, f.ctx)).status).toBe("invalid_target");
    release(); expect((await continuation).status).toBe("ok");
    expect(f.history).toHaveBeenCalledTimes(2);
  });
  it("expires cursors and never accepts arbitrary API cursors", async () => {
    const f = fixture(); f.history.mockResolvedValue({ ok: true, messages: [], response_metadata: { next_cursor: "next" } });
    const first = await f.reader.read("channel", {}, f.ctx);
    const now = Date.now(); const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
    try { expect((await f.reader.read("channel", { cursor: first.nextCursor }, f.ctx)).status).toBe("invalid_target"); }
    finally { clock.mockRestore(); }
  });
});
