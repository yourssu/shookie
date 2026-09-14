import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackUserOAuthRequiredError } from "../user-oauth/token-service.js";
import { MentionEventDeduper } from "./event-deduper.js";
import type { MentionMessageEvent } from "./event.js";
import { buildMentionGroupIndex, createMentionReplacementPlan } from "./parser.js";
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
const RADAR_MENTION_GROUPS_MANAGEMENT_URL =
  "https://radar.yourssu.com/mention-groups";
const RADAR_MENTION_GROUPS_MANAGEMENT_LINK =
  `<${RADAR_MENTION_GROUPS_MANAGEMENT_URL}|멘션 그룹 만들기·관리하기>`;
const RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE =
  `${RADAR_MENTION_GROUPS_MANAGEMENT_LINK} 페이지에서 새로운 그룹을 만들고 관리할 수 있습니다.`;

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

afterEach(() => {
  vi.restoreAllMocks();
});

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
    const pairCount = 100;
    const repeatedGroups = "@backend @platform ".repeat(pairCount).trim();
    const legacyGlobalDedupText = [
      "`@backend`(<@U111> <@U222>)",
      "`@platform`(<@U333>)",
      ...Array.from(
        { length: pairCount - 1 },
        () => ["`@backend`", "`@platform`"],
      ).flat(),
    ].join(" ");
    const expandedText = createMentionReplacementPlan(repeatedGroups, catalog).text;

    expect(legacyGlobalDedupText).toHaveLength(2_325);
    expect(legacyGlobalDedupText.length).toBeLessThanOrEqual(4_000);
    expect(expandedText).toHaveLength(5_699);
    expect(expandedText.length).toBeGreaterThan(4_000);

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
      {
        channelId: "C123",
        userId: "U999",
        threadTs: "100.000",
        text: [
          "이 메시지의 멘션 그룹을 치환하려면 작성자 Slack 인증이 필요합니다.",
          "<https://slack.example/oauth|Slack 인증하기>",
          RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE,
          "인증이 끝나면 이 메시지를 자동으로 다시 처리합니다.",
        ].join("\n"),
      },
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

  it("미해결 그룹과 OAuth가 함께 필요하면 각 사용자 전용 안내에 관리 링크를 포함한다", async () => {
    const deps = dependencies({
      getAccessToken: vi
        .fn()
        .mockRejectedValue(new SlackUserOAuthRequiredError("missing")),
    });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent({
      ...event,
      threadTs: "101.000",
      text: "@unknown @backend",
    });

    expect(deps.slack.postEphemeral).toHaveBeenCalledTimes(2);
    expect(deps.slack.postEphemeral).toHaveBeenNthCalledWith(1, {
      channelId: "C123",
      userId: "U999",
      threadTs: "101.000",
      text: expect.stringContaining(RADAR_MENTION_GROUPS_MANAGEMENT_LINK),
    });
    expect(deps.slack.postEphemeral).toHaveBeenNthCalledWith(2, {
      channelId: "C123",
      userId: "U999",
      threadTs: "101.000",
      text: expect.stringContaining(RADAR_MENTION_GROUPS_MANAGEMENT_LINK),
    });
    expect(deps.slack.postEphemeral).toHaveBeenNthCalledWith(2, {
      channelId: "C123",
      userId: "U999",
      threadTs: "101.000",
      text: expect.stringContaining("Slack 인증하기"),
    });
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
    expect(deps.slack.updateMessage).toHaveBeenCalledTimes(1);
    expect(deps.slack.updateMessage).toHaveBeenCalledWith({
      accessToken: "xoxp-author",
      channelId: "C123",
      messageTs: "123.456",
      text: "검토 부탁해요 `@backend`(<@U444>) @platform",
    });
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

  it("알 수 없거나 비활성 그룹은 원문 표기를 보존하고 두 문장으로 안내한다", async () => {
    const deps = dependencies();
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent({ ...event, text: "@group---ttt" });

    expect(deps.oauth.getAccessToken).not.toHaveBeenCalled();
    expect(deps.slack.updateMessage).not.toHaveBeenCalled();
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      {
        channelId: "C123",
        userId: "U999",
        text: [
          "알 수 없거나 비활성화된 멘션 그룹: @group---ttt",
          RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE,
        ].join("\n"),
      },
    );
  });

  it("알 수 없음·빈 그룹·활성 그룹 혼합 시 원문과 사용자 전용 안내를 보존한다", async () => {
    const emptyGroup: ActiveMentionGroup = {
      id: "7a7a9d4d-f42c-4d2c-932c-2c832f2f5df4",
      handle: "empty",
      aliases: [],
      memberUserIds: [],
    };
    const mixedGroups = [...groups, emptyGroup];
    const deps = dependencies({
      getCatalog: vi.fn().mockResolvedValue({
        revision: 13,
        etag: '"mention-groups-13"',
        groups: mixedGroups,
        byHandle: buildMentionGroupIndex(mixedGroups),
      }),
    });
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent({
      ...event,
      threadTs: "200.000",
      text: "@unknown @empty @backend",
    });

    expect(deps.slack.updateMessage).toHaveBeenCalledWith({
      accessToken: "xoxp-author",
      channelId: "C123",
      messageTs: "123.456",
      threadTs: "200.000",
      text: "@unknown @empty `@backend`(<@U111> <@U222>)",
    });
    expect(deps.slack.postEphemeral).toHaveBeenCalledWith({
      channelId: "C123",
      userId: "U999",
      threadTs: "200.000",
      text: [
        "알 수 없거나 비활성화된 멘션 그룹: @unknown",
        "활성 멤버가 없는 멘션 그룹: @empty",
        RADAR_MENTION_GROUPS_MANAGEMENT_GUIDANCE,
      ].join("\n"),
    });
  });

  it("멘션 그룹 관리 링크는 안내에만 포함하고 로그에는 기록하지 않는다", async () => {
    const logs: unknown[][] = [];
    for (const method of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logs.push(args);
      });
    }
    const deps = dependencies();
    const service = new MentionGroupReplacementService(deps.radar, deps.oauth, deps.slack);

    await service.handleEvent({ ...event, text: "@unknown" });

    expect(deps.slack.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(RADAR_MENTION_GROUPS_MANAGEMENT_LINK) }),
    );
    expect(JSON.stringify(logs)).not.toContain(RADAR_MENTION_GROUPS_MANAGEMENT_URL);
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
      expect.objectContaining({
        text: expect.stringContaining(RADAR_MENTION_GROUPS_MANAGEMENT_LINK),
      }),
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
