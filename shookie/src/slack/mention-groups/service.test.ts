import { describe, expect, it, vi } from "vitest";
import { SlackUserOAuthRequiredError } from "../user-oauth/token-service.js";
import { MentionEventDeduper } from "./event-deduper.js";
import type { MentionMessageEvent } from "./event.js";
import { buildMentionGroupIndex } from "./parser.js";
import { RadarMentionGroupsError } from "./radar-client.js";
import { MentionGroupReplacementService } from "./service.js";
import type { MentionSlackGateway } from "./slack-gateway.js";
import type { ActiveMentionGroup, MentionGroupCatalog } from "./types.js";

const groups: ActiveMentionGroup[] = [
  {
    id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
    handle: "backend",
    aliases: ["be"],
    memberUserIds: ["U111", "U222"],
  },
  {
    id: "4d92a1d8-52f4-46b0-b389-3284cff8a688",
    handle: "platform",
    aliases: ["infra"],
    memberUserIds: ["U222", "U333"],
  },
];
const catalog: MentionGroupCatalog = {
  revision: 12,
  etag: '"mention-groups-12"',
  groups,
  byHandle: buildMentionGroupIndex(groups),
};
const event: MentionMessageEvent = {
  eventId: "Ev123",
  teamId: "T123",
  userId: "U999",
  channelId: "C123",
  messageTs: "123.456",
  text: "검토 부탁해요 @backend @platform",
};

function dependencies(overrides: {
  getCatalog?: ReturnType<typeof vi.fn>;
  getAccessToken?: ReturnType<typeof vi.fn>;
  createAuthorizationUrl?: ReturnType<typeof vi.fn>;
  invalidateAccessToken?: ReturnType<typeof vi.fn>;
  updateMessage?: ReturnType<typeof vi.fn>;
  postEphemeral?: ReturnType<typeof vi.fn>;
  loadMessage?: ReturnType<typeof vi.fn>;
} = {}) {
  const radar = {
    getCatalog: overrides.getCatalog ?? vi.fn().mockResolvedValue(catalog),
  };
  const oauth = {
    getAccessToken: overrides.getAccessToken ?? vi.fn().mockResolvedValue("xoxp-author"),
    createAuthorizationUrl:
      overrides.createAuthorizationUrl ?? vi.fn().mockResolvedValue("https://slack.example/oauth"),
    invalidateAccessToken:
      overrides.invalidateAccessToken ?? vi.fn().mockResolvedValue(true),
  };
  const slack: MentionSlackGateway = {
    updateMessage: overrides.updateMessage ?? vi.fn().mockResolvedValue(undefined),
    postEphemeral: overrides.postEphemeral ?? vi.fn().mockResolvedValue(undefined),
    loadMessage:
      overrides.loadMessage ??
      vi.fn().mockResolvedValue({
        messageTs: event.messageTs,
        userId: event.userId,
        text: event.text,
        edited: false,
      }),
  };
  return { radar, oauth, slack };
}

describe("MentionGroupReplacementService", () => {
  it("작성자 User Token의 chat.update 경로로 같은 채널/ts 원문을 치환한다", async () => {
    const deps = dependencies();
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent(event);

    expect(deps.slack.updateMessage).toHaveBeenCalledWith({
      accessToken: "xoxp-author",
      channelId: "C123",
      messageTs: "123.456",
      text:
        "검토 부탁해요 `@backend`(<@U111> <@U222>) " +
        "`@platform`(<@U222> <@U333>)",
    });
    expect(deps.slack.updateMessage).toHaveBeenCalledTimes(1);
    expect(deps.oauth.createAuthorizationUrl).not.toHaveBeenCalled();
  });

  it("Slack 재전송은 event/message 키로 한 번만 처리한다", async () => {
    const deps = dependencies();
    const service = new MentionGroupReplacementService(
      deps.radar,
      deps.oauth,
      deps.slack,
      new MentionEventDeduper(),
    );

    await service.handleEvent(event);
    await service.handleEvent(event);

    expect(deps.slack.updateMessage).toHaveBeenCalledTimes(1);
    expect(deps.slack.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text:
          "검토 부탁해요 `@backend`(<@U111> <@U222>) " +
          "`@platform`(<@U222> <@U333>)",
      }),
    );
  });

  it("반복된 중복 그룹 치환 결과가 4,000자를 넘으면 원문을 보존한다", async () => {
    const deps = dependencies();
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);
    const repeatedGroups = "@backend @platform ".repeat(200).trim();

    await service.handleEvent({ ...event, text: repeatedGroups });

    expect(deps.slack.updateMessage).not.toHaveBeenCalled();
    expect(deps.oauth.getAccessToken).not.toHaveBeenCalled();
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("원문을 그대로") }),
    );
  });

  it("미인증 작성자에게만 일회성 인증 링크를 보내고 콜백 뒤 원문을 다시 조회한다", async () => {
    const getAccessToken = vi
      .fn()
      .mockRejectedValueOnce(new SlackUserOAuthRequiredError("missing"))
      .mockResolvedValueOnce("xoxp-author");
    const deps = dependencies({ getAccessToken });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent({ ...event, threadTs: "100.000" });
    expect(deps.oauth.createAuthorizationUrl).toHaveBeenCalledWith({
      teamId: "T123",
      userId: "U999",
      context: {
        channelId: "C123",
        messageTs: "123.456",
        threadTs: "100.000",
        eventId: "Ev123",
      },
    });
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "U999", threadTs: "100.000" }),
    );

    await service.resumeAfterAuthorization({
      teamId: "T123",
      userId: "U999",
      context: {
        channelId: "C123",
        messageTs: "123.456",
        threadTs: "100.000",
        eventId: "Ev123",
      },
    });
    expect(deps.slack.loadMessage).toHaveBeenCalledWith({
      channelId: "C123",
      messageTs: "123.456",
      threadTs: "100.000",
    });
    expect(deps.slack.updateMessage).toHaveBeenCalledTimes(1);
  });

  it("OAuth 대기 중 삭제·재생성된 그룹은 콜백 시점 catalog의 새 멤버로 처리한다", async () => {
    const recreatedGroups: ActiveMentionGroup[] = [
      {
        id: "f0d30ac5-892e-4d98-af10-63878ef17856",
        handle: "backend",
        aliases: ["be"],
        memberUserIds: ["U444"],
      },
    ];
    const recreatedCatalog: MentionGroupCatalog = {
      revision: 13,
      etag: '"mention-groups-13"',
      groups: recreatedGroups,
      byHandle: buildMentionGroupIndex(recreatedGroups),
    };
    const getCatalog = vi
      .fn()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValueOnce(recreatedCatalog);
    const getAccessToken = vi
      .fn()
      .mockRejectedValueOnce(new SlackUserOAuthRequiredError("missing"))
      .mockResolvedValueOnce("xoxp-author");
    const deps = dependencies({ getCatalog, getAccessToken });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent(event);
    await service.resumeAfterAuthorization({
      teamId: "T123",
      userId: "U999",
      context: { channelId: "C123", messageTs: "123.456", eventId: "Ev123" },
    });

    expect(getCatalog).toHaveBeenCalledTimes(2);
    expect(deps.slack.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("`@backend`(<@U444>)"),
      }),
    );
    expect(deps.slack.updateMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("U111") }),
    );
  });

  it("OAuth 대기 중 작성자가 수정했거나 메시지 주체가 바뀌면 덮어쓰지 않는다", async () => {
    const deps = dependencies({
      loadMessage: vi.fn().mockResolvedValue({
        messageTs: event.messageTs,
        userId: event.userId,
        text: event.text,
        edited: true,
      }),
    });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.resumeAfterAuthorization({
      teamId: "T123",
      userId: "U999",
      context: { channelId: "C123", messageTs: "123.456" },
    });

    expect(deps.slack.updateMessage).not.toHaveBeenCalled();
  });

  it("알 수 없거나 비활성 그룹은 원문에 남기고 사용자 전용 안내만 보낸다", async () => {
    const deps = dependencies();
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent({ ...event, text: "@unknown" });

    expect(deps.oauth.getAccessToken).not.toHaveBeenCalled();
    expect(deps.slack.updateMessage).not.toHaveBeenCalled();
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("알 수 없거나 비활성화") }),
    );
  });

  it("Radar 장애에는 stale 멤버를 사용하지 않고 원문을 보존한다", async () => {
    const deps = dependencies({
      getCatalog: vi.fn().mockRejectedValue(new RadarMentionGroupsError("http_503")),
    });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent(event);

    expect(deps.slack.updateMessage).not.toHaveBeenCalled();
    expect(deps.slack.postEphemeral).toHaveBeenCalled();
  });

  it("chat.update의 terminal auth 오류는 실패 토큰만 폐기하고 재인증 후 재처리한다", async () => {
    const updateError = Object.assign(new Error("platform error"), {
      data: { error: "token_revoked" },
    });
    const deps = dependencies({
      updateMessage: vi.fn().mockRejectedValue(updateError),
    });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent(event);

    expect(deps.oauth.invalidateAccessToken).toHaveBeenCalledWith(
      "T123",
      "U999",
      "xoxp-author",
    );
    expect(deps.oauth.createAuthorizationUrl).toHaveBeenCalled();
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Slack 인증하기") }),
    );
  });

  it("terminal auth 오류와 동시에 새 토큰이 저장되면 재인증 대신 새 버전으로 한 번 재시도한다", async () => {
    const updateError = Object.assign(new Error("platform error"), {
      data: { error: "token_revoked" },
    });
    const updateMessage = vi
      .fn()
      .mockRejectedValueOnce(updateError)
      .mockResolvedValueOnce(undefined);
    const deps = dependencies({
      updateMessage,
      getAccessToken: vi
        .fn()
        .mockResolvedValueOnce("xoxp-stale")
        .mockResolvedValueOnce("xoxp-new"),
      invalidateAccessToken: vi.fn().mockResolvedValue(false),
      createAuthorizationUrl: vi.fn().mockResolvedValue(null),
    });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent(event);

    expect(updateMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ accessToken: "xoxp-new" }),
    );
    expect(deps.slack.postEphemeral).not.toHaveBeenCalled();
  });

  it("편집 권한 부족은 재인증 루프 없이 원문을 보존한다", async () => {
    const updateError = Object.assign(new Error("platform error"), {
      data: { error: "cant_update_message" },
    });
    const deps = dependencies({ updateMessage: vi.fn().mockRejectedValue(updateError) });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent(event);

    expect(deps.oauth.invalidateAccessToken).not.toHaveBeenCalled();
    expect(deps.oauth.createAuthorizationUrl).not.toHaveBeenCalled();
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("편집 정책") }),
    );
  });
});
