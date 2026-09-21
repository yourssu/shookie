import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { App } from "@slack/bolt";
import {
  backfillPublicChannels,
  buildPermalink,
  registerChannelAutoJoin,
  relayToAll,
  routeTeam,
} from "./reaction-relay.js";
import { logger } from "../logger.js";

type MockPostMessage = ReturnType<typeof vi.fn>;
type MockGetPermalink = ReturnType<typeof vi.fn>;
type MockConversationsList = ReturnType<typeof vi.fn>;
type MockConversationsJoin = ReturnType<typeof vi.fn>;

function createMockClient(opts: {
  getPermalink?: MockGetPermalink;
  postMessage?: MockPostMessage;
  conversationsList?: MockConversationsList;
  conversationsJoin?: MockConversationsJoin;
}): App["client"] {
  return {
    chat: {
      getPermalink: opts.getPermalink ?? vi.fn(),
      postMessage: opts.postMessage ?? vi.fn(),
    },
    conversations: {
      list: opts.conversationsList ?? vi.fn(),
      join: opts.conversationsJoin ?? vi.fn(),
    },
  } as unknown as App["client"];
}

describe("routeTeam", () => {
  it("팀 이모지를 teamKey로 매핑한다", () => {
    expect(routeTeam("pm_go")).toBe("pm");
    expect(routeTeam("design_go")).toBe("design");
    expect(routeTeam("android_go")).toBe("android");
    expect(routeTeam("backend_go")).toBe("backend");
    expect(routeTeam("frontend_go")).toBe("frontend");
    expect(routeTeam("back_go")).toBe("backend");
    expect(routeTeam("front_go")).toBe("frontend");
    expect(routeTeam("ios_go")).toBe("ios");
    expect(routeTeam("hr_go")).toBe("hr");
    expect(routeTeam("legal_go")).toBe("legal");
    expect(routeTeam("marketing_go")).toBe("marketing");
    expect(routeTeam("all_go")).toBe("all");
    expect(routeTeam("general_go")).toBe("general");
  });

  it("릴레이 대상이 아닌 리액션은 null을 반환한다", () => {
    expect(routeTeam("thumbsup")).toBeNull();
    expect(routeTeam("")).toBeNull();
    expect(routeTeam("unknown_go")).toBeNull();
    expect(routeTeam("pm")).toBeNull();
    expect(routeTeam("_go")).toBeNull();
  });
});

describe("buildPermalink", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("chat.getPermalink가 실패하면 null 반환 + warn 로깅", async () => {
    const getPermalink = vi.fn().mockRejectedValue(new Error("not_found"));
    const client = createMockClient({ getPermalink });

    const result = await buildPermalink(client, "C123", "1234567890.123456");

    expect(result).toBeNull();
    expect(getPermalink).toHaveBeenCalledWith({
      channel: "C123",
      message_ts: "1234567890.123456",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "chat.getPermalink 실패",
      expect.objectContaining({ channel: "C123", error: "not_found" }),
    );
  });

  it("permalink 필드가 없으면 null 반환 + warn 로깅", async () => {
    const getPermalink = vi.fn().mockResolvedValue({ ok: true });
    const client = createMockClient({ getPermalink });

    const result = await buildPermalink(client, "C123", "1234567890.123456");

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      "permalink null — 스킵",
      expect.objectContaining({ channel: "C123" }),
    );
  });

  it("permalink가 있으면 문자열 반환", async () => {
    const permalink = "https://yourssu.slack.com/archives/C123/p1234567890123456";
    const getPermalink = vi.fn().mockResolvedValue({ permalink });
    const client = createMockClient({ getPermalink });

    const result = await buildPermalink(client, "C123", "1234567890.123456");

    expect(result).toBe(permalink);
  });
});

describe("relayToAll", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("일부 채널 실패 시 warn 로깅 + 나머지 채널은 정상 전송", async () => {
    const postMessage = vi.fn()
      .mockRejectedValueOnce(new Error("channel_not_found"))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const client = createMockClient({ postMessage });

    await relayToAll(client, "https://permalink.example");

    expect(postMessage).toHaveBeenCalledTimes(9);
    expect(warnSpy).toHaveBeenCalledWith(
      "relay failed",
      expect.objectContaining({ team: "pm", error: "channel_not_found" }),
    );
    expect(infoSpy).toHaveBeenCalledWith(
      "relay sent",
      expect.objectContaining({ team: "design" }),
    );
  });
});

describe("public channel membership", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("기존 공개 채널을 페이지별로 조회하고 미가입 채널에 참여한다", async () => {
    const conversationsList = vi.fn()
      .mockResolvedValueOnce({
        channels: [
          { id: "C_ALREADY", name: "already", is_member: true },
          { id: "C_FIRST", name: "first", is_member: false },
        ],
        response_metadata: { next_cursor: "next-page" },
      })
      .mockResolvedValueOnce({
        channels: [{ id: "C_SECOND", name: "second", is_member: false }],
        response_metadata: { next_cursor: "" },
      });
    const conversationsJoin = vi.fn().mockResolvedValue({ ok: true });
    const client = createMockClient({ conversationsList, conversationsJoin });

    const result = await backfillPublicChannels(client);

    expect(result).toEqual({ listed: 3, alreadyJoined: 1, joined: 2, failed: 0 });
    expect(conversationsList).toHaveBeenNthCalledWith(1, {
      cursor: undefined,
      exclude_archived: true,
      limit: 200,
      types: "public_channel",
    });
    expect(conversationsList).toHaveBeenNthCalledWith(2, {
      cursor: "next-page",
      exclude_archived: true,
      limit: 200,
      types: "public_channel",
    });
    expect(conversationsJoin).toHaveBeenCalledTimes(2);
    expect(conversationsJoin).toHaveBeenNthCalledWith(1, { channel: "C_FIRST" });
    expect(conversationsJoin).toHaveBeenNthCalledWith(2, { channel: "C_SECOND" });
  });

  it("한 채널 참여에 실패해도 다음 채널을 계속 처리한다", async () => {
    const conversationsList = vi.fn().mockResolvedValue({
      channels: [
        { id: "C_FAILED", name: "failed", is_member: false },
        { id: "C_OK", name: "ok", is_member: false },
      ],
      response_metadata: { next_cursor: "" },
    });
    const conversationsJoin = vi.fn()
      .mockRejectedValueOnce(new Error("restricted_action"))
      .mockResolvedValueOnce({ ok: true });
    const client = createMockClient({ conversationsList, conversationsJoin });

    const result = await backfillPublicChannels(client);

    expect(result).toEqual({ listed: 2, alreadyJoined: 0, joined: 1, failed: 1 });
    expect(conversationsJoin).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "공개 채널 자동 참여 실패",
      expect.objectContaining({ channelId: "C_FAILED", error: "restricted_action" }),
    );
  });

  it("새 공개 채널 생성 이벤트가 오면 자동으로 참여한다", async () => {
    const eventRegistration = vi.fn();
    const conversationsJoin = vi.fn().mockResolvedValue({ ok: true });
    const client = createMockClient({ conversationsJoin });

    registerChannelAutoJoin({ event: eventRegistration } as unknown as App);

    expect(eventRegistration).toHaveBeenCalledWith("channel_created", expect.any(Function));
    const handler = eventRegistration.mock.calls[0]?.[1] as
      | ((payload: unknown) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();

    await handler?.({
      event: { channel: { id: "C_NEW", name: "new-channel", is_private: false } },
      client,
    });

    expect(conversationsJoin).toHaveBeenCalledWith({ channel: "C_NEW" });
  });

  it("백필 대상에서 비공개 채널을 조회하지 않는다", async () => {
    const conversationsList = vi.fn().mockResolvedValue({ channels: [], response_metadata: {} });
    const client = createMockClient({ conversationsList });

    await backfillPublicChannels(client);

    expect(conversationsList).toHaveBeenCalledWith(expect.objectContaining({ types: "public_channel" }));
  });
});
