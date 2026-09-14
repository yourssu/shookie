import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SlackUserOAuthRequiredError } from "../user-oauth/token-service.js";
import { extractMentionMessageEvent, type MentionMessageEvent } from "./event.js";
import { RadarMentionGroupsClient } from "./radar-client.js";
import {
  MentionGroupReplacementService,
  type MentionGroupOAuthProvider,
} from "./service.js";
import type {
  MentionSlackGateway,
  SlackEphemeralMessage,
  SlackMessageLookup,
  SlackMessageSnapshot,
  SlackMessageUpdate,
} from "./slack-gateway.js";
import type { ActiveMentionGroup } from "./types.js";

const INTERNAL_KEY = "local-e2e-internal-key-0123456789";
const RADAR_MENTION_GROUPS_MANAGEMENT_LINK =
  "<https://radar.yourssu.com/mention-groups|멘션 그룹 만들기·관리하기>";

interface StoredMessage {
  channelId: string;
  messageTs: string;
  userId: string;
  text: string;
  threadTs?: string;
  edited: boolean;
}

class InMemoryOAuth implements MentionGroupOAuthProvider {
  readonly authorizationRequests: Array<{
    teamId: string;
    userId: string;
    context?: Record<string, unknown>;
  }> = [];
  private readonly tokens = new Map<string, string>();

  setToken(teamId: string, userId: string, token: string): void {
    this.tokens.set(`${teamId}:${userId}`, token);
  }

  hasToken(teamId: string, userId: string): boolean {
    return this.tokens.has(`${teamId}:${userId}`);
  }

  async getAccessToken(teamId: string, userId: string): Promise<string> {
    const token = this.tokens.get(`${teamId}:${userId}`);
    if (!token) throw new SlackUserOAuthRequiredError("missing");
    return token;
  }

  async createAuthorizationUrl(request: {
    teamId: string;
    userId: string;
    context?: Record<string, unknown>;
  }): Promise<string | null> {
    if (this.hasToken(request.teamId, request.userId)) return null;
    this.authorizationRequests.push(request);
    return "https://slack.example.test/oauth/authorize";
  }

  async invalidateAccessToken(
    teamId: string,
    userId: string,
    expectedAccessToken: string,
  ): Promise<boolean> {
    const key = `${teamId}:${userId}`;
    if (this.tokens.get(key) !== expectedAccessToken) return false;
    this.tokens.delete(key);
    return true;
  }
}

class InMemorySlack implements MentionSlackGateway {
  readonly messages = new Map<string, StoredMessage>();
  readonly updates: SlackMessageUpdate[] = [];
  readonly ephemerals: SlackEphemeralMessage[] = [];
  private nextUpdateErrorCode: string | null = null;

  putMessage(message: Omit<StoredMessage, "edited">): void {
    this.messages.set(this.key(message), { ...message, edited: false });
  }

  failNextUpdateWith(code: string): void {
    this.nextUpdateErrorCode = code;
  }

  async updateMessage(input: SlackMessageUpdate): Promise<void> {
    if (this.nextUpdateErrorCode) {
      const code = this.nextUpdateErrorCode;
      this.nextUpdateErrorCode = null;
      throw Object.assign(new Error("simulated Slack platform error"), {
        data: { error: code },
      });
    }

    const message = this.messages.get(this.key(input));
    if (!message) throw new Error("message_not_found");
    message.text = input.text;
    message.edited = true;
    this.updates.push(input);
  }

  async postEphemeral(input: SlackEphemeralMessage): Promise<void> {
    this.ephemerals.push(input);
  }

  async loadMessage(input: SlackMessageLookup): Promise<SlackMessageSnapshot | null> {
    const message = this.messages.get(this.key(input));
    if (!message) return null;
    return {
      messageTs: message.messageTs,
      userId: message.userId,
      text: message.text,
      edited: message.edited,
    };
  }

  private key(input: { channelId: string; messageTs: string }): string {
    return `${input.channelId}:${input.messageTs}`;
  }
}

interface RadarRequestRecord {
  internalKey: string | undefined;
  ifNoneMatch: string | undefined;
}

interface RadarHarness {
  apiUrl: string;
  requests: RadarRequestRecord[];
  setCatalog(revision: number, groups: ActiveMentionGroup[]): void;
  failNextRequestWith(status: number): void;
  close(): Promise<void>;
}

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("mention group local contract E2E", () => {
  it("실제 HTTP Radar 계약으로 채널·스레드·복수 그룹과 revision 갱신을 처리한다", async () => {
    const backend = group(
      "61b37086-28f7-44fd-9683-e1d8821cd51f",
      "backend",
      ["be"],
      ["U111", "U222"],
    );
    const platform = group(
      "4d92a1d8-52f4-46b0-b389-3284cff8a688",
      "platform",
      ["infra"],
      ["U222", "U333"],
    );
    const radarServer = await startRadarServer(1, [backend, platform]);
    let now = 0;
    const radar = new RadarMentionGroupsClient({
      apiUrl: radarServer.apiUrl,
      apiKey: INTERNAL_KEY,
      cacheTtlMs: 10,
      requestTimeoutMs: 1_000,
      now: () => now,
    });
    const oauth = new InMemoryOAuth();
    const slack = new InMemorySlack();
    const service = new MentionGroupReplacementService(radar, oauth, slack);

    oauth.setToken("T123", "U900", "xoxp-channel-author");
    slack.putMessage({
      channelId: "C123",
      messageTs: "100.001",
      userId: "U900",
      text: "배포 @be + @platform + @disabled",
    });
    await service.handleEvent(
      event({
        eventId: "EvChannel",
        channelId: "C123",
        messageTs: "100.001",
        userId: "U900",
        text: "배포 @be + @platform + @disabled",
        channelType: "channel",
      }),
    );

    expect(slack.messages.get("C123:100.001")).toMatchObject({
      userId: "U900",
      text:
        "배포 `@be`(<@U111> <@U222>) + " +
        "`@platform`(<@U222> <@U333>) + @disabled",
    });
    expect(slack.updates[0]).toMatchObject({
      accessToken: "xoxp-channel-author",
      channelId: "C123",
      messageTs: "100.001",
    });
    expect(slack.ephemerals[0]?.text).toContain("알 수 없거나 비활성화된");
    expect(slack.ephemerals[0]?.text).toContain(RADAR_MENTION_GROUPS_MANAGEMENT_LINK);

    oauth.setToken("T123", "U901", "xoxp-thread-author");
    slack.putMessage({
      channelId: "G123",
      messageTs: "101.002",
      threadTs: "101.000",
      userId: "U901",
      text: "스레드 @backend",
    });
    await service.handleEvent(
      event({
        eventId: "EvThread",
        channelId: "G123",
        messageTs: "101.002",
        threadTs: "101.000",
        userId: "U901",
        text: "스레드 @backend",
        channelType: "group",
      }),
    );
    expect(slack.messages.get("G123:101.002")).toMatchObject({
      userId: "U901",
      text: "스레드 `@backend`(<@U111> <@U222>)",
    });
    expect(slack.updates[1]).toMatchObject({
      accessToken: "xoxp-thread-author",
      threadTs: "101.000",
    });

    radarServer.setCatalog(2, [
      group(
        "61b37086-28f7-44fd-9683-e1d8821cd51f",
        "backend",
        ["be"],
        ["U444"],
      ),
      platform,
    ]);
    now = 11;
    slack.putMessage({
      channelId: "C123",
      messageTs: "102.003",
      userId: "U900",
      text: "변경 @be",
    });
    await service.handleEvent(
      event({
        eventId: "EvRevision",
        channelId: "C123",
        messageTs: "102.003",
        userId: "U900",
        text: "변경 @be",
        channelType: "channel",
      }),
    );

    expect(slack.messages.get("C123:102.003")?.text).toBe("변경 `@be`(<@U444>)");
    expect(radarServer.requests).toEqual([
      { internalKey: INTERNAL_KEY, ifNoneMatch: undefined },
      { internalKey: INTERNAL_KEY, ifNoneMatch: '"mention-groups-1"' },
    ]);
  });

  it("미인증과 폐기 토큰은 원문을 보존한 뒤 재인증 콜백으로 다시 처리한다", async () => {
    const radarServer = await startRadarServer(1, [
      group(
        "61b37086-28f7-44fd-9683-e1d8821cd51f",
        "backend",
        ["be"],
        ["U111"],
      ),
    ]);
    const radar = new RadarMentionGroupsClient({
      apiUrl: radarServer.apiUrl,
      apiKey: INTERNAL_KEY,
      cacheTtlMs: 30_000,
      requestTimeoutMs: 1_000,
    });
    const oauth = new InMemoryOAuth();
    const slack = new InMemorySlack();
    const service = new MentionGroupReplacementService(radar, oauth, slack);

    slack.putMessage({
      channelId: "G123",
      messageTs: "200.002",
      threadTs: "200.000",
      userId: "U902",
      text: "최초 인증 @be",
    });
    const unauthorized = event({
      eventId: "EvUnauthorized",
      channelId: "G123",
      messageTs: "200.002",
      threadTs: "200.000",
      userId: "U902",
      text: "최초 인증 @be",
      channelType: "group",
    });
    await service.handleEvent(unauthorized);

    expect(slack.messages.get("G123:200.002")?.text).toBe("최초 인증 @be");
    expect(slack.ephemerals.at(-1)?.text).toContain("Slack 인증하기");
    expect(slack.ephemerals.at(-1)?.text).toContain(RADAR_MENTION_GROUPS_MANAGEMENT_LINK);
    expect(oauth.authorizationRequests.at(-1)?.context).toMatchObject({
      channelId: "G123",
      messageTs: "200.002",
      threadTs: "200.000",
    });

    oauth.setToken("T123", "U902", "xoxp-first-grant");
    await service.resumeAfterAuthorization({
      teamId: "T123",
      userId: "U902",
      context: {
        channelId: "G123",
        messageTs: "200.002",
        threadTs: "200.000",
        eventId: "EvUnauthorized",
      },
    });
    expect(slack.messages.get("G123:200.002")).toMatchObject({
      userId: "U902",
      text: "최초 인증 `@be`(<@U111>)",
    });

    slack.putMessage({
      channelId: "C123",
      messageTs: "201.003",
      userId: "U902",
      text: "폐기 복구 @backend",
    });
    slack.failNextUpdateWith("token_revoked");
    await service.handleEvent(
      event({
        eventId: "EvRevoked",
        channelId: "C123",
        messageTs: "201.003",
        userId: "U902",
        text: "폐기 복구 @backend",
        channelType: "channel",
      }),
    );

    expect(oauth.hasToken("T123", "U902")).toBe(false);
    expect(slack.messages.get("C123:201.003")?.text).toBe("폐기 복구 @backend");
    expect(slack.ephemerals.at(-1)?.text).toContain("Slack 인증하기");
    expect(slack.ephemerals.at(-1)?.text).toContain(RADAR_MENTION_GROUPS_MANAGEMENT_LINK);

    oauth.setToken("T123", "U902", "xoxp-reauthorized");
    await service.resumeAfterAuthorization({
      teamId: "T123",
      userId: "U902",
      context: {
        channelId: "C123",
        messageTs: "201.003",
        eventId: "EvRevoked",
      },
    });
    expect(slack.messages.get("C123:201.003")).toMatchObject({
      userId: "U902",
      text: "폐기 복구 `@backend`(<@U111>)",
    });
    expect(slack.updates.at(-1)?.accessToken).toBe("xoxp-reauthorized");
  });

  it("실제 HTTP 캐시 경로에서 영구 삭제·빈 catalog·handle 재사용과 재검증 실패를 처리한다", async () => {
    const deleted = group(
      "61b37086-28f7-44fd-9683-e1d8821cd51f",
      "backend",
      ["be"],
      ["U111"],
    );
    const recreated = group(
      "f0d30ac5-892e-4d98-af10-63878ef17856",
      "backend",
      ["be"],
      ["U444", "U555"],
    );
    const radarServer = await startRadarServer(1, [deleted]);
    let now = 0;
    const radar = new RadarMentionGroupsClient({
      apiUrl: radarServer.apiUrl,
      apiKey: INTERNAL_KEY,
      cacheTtlMs: 10,
      requestTimeoutMs: 1_000,
      now: () => now,
    });
    const oauth = new InMemoryOAuth();
    const slack = new InMemorySlack();
    const service = new MentionGroupReplacementService(radar, oauth, slack);
    oauth.setToken("T123", "U900", "xoxp-author");

    slack.putMessage({
      channelId: "C123",
      messageTs: "300.001",
      userId: "U900",
      text: "삭제 전 @be",
    });
    await service.handleEvent(
      event({
        eventId: "EvBeforeDelete",
        channelId: "C123",
        messageTs: "300.001",
        userId: "U900",
        text: "삭제 전 @be",
        channelType: "channel",
      }),
    );
    expect(slack.messages.get("C123:300.001")?.text).toBe("삭제 전 `@be`(<@U111>)");

    radarServer.setCatalog(2, []);
    now = 11;
    slack.putMessage({
      channelId: "C123",
      messageTs: "301.001",
      userId: "U900",
      text: "삭제 후 @backend @be",
    });
    await service.handleEvent(
      event({
        eventId: "EvEmptyCatalog",
        channelId: "C123",
        messageTs: "301.001",
        userId: "U900",
        text: "삭제 후 @backend @be",
        channelType: "channel",
      }),
    );

    expect(slack.messages.get("C123:301.001")?.text).toBe("삭제 후 @backend @be");
    expect(slack.messages.get("C123:300.001")?.text).toBe("삭제 전 `@be`(<@U111>)");
    expect(slack.updates).toHaveLength(1);
    expect(slack.ephemerals.at(-1)?.text).toContain("@backend, @be");
    expect(slack.ephemerals.at(-1)?.text).toContain(RADAR_MENTION_GROUPS_MANAGEMENT_LINK);

    radarServer.setCatalog(3, [recreated]);
    now = 22;
    slack.putMessage({
      channelId: "C123",
      messageTs: "302.001",
      userId: "U900",
      text: "재사용 @backend @be",
    });
    await service.handleEvent(
      event({
        eventId: "EvHandleReuse",
        channelId: "C123",
        messageTs: "302.001",
        userId: "U900",
        text: "재사용 @backend @be",
        channelType: "channel",
      }),
    );

    expect(slack.messages.get("C123:302.001")?.text).toBe(
      "재사용 `@backend`(<@U444> <@U555>) `@be`(<@U444> <@U555>)",
    );
    expect(slack.messages.get("C123:302.001")?.text).not.toContain("U111");

    radarServer.failNextRequestWith(503);
    now = 33;
    slack.putMessage({
      channelId: "C123",
      messageTs: "303.001",
      userId: "U900",
      text: "재검증 실패 @be",
    });
    await service.handleEvent(
      event({
        eventId: "EvRefreshFailure",
        channelId: "C123",
        messageTs: "303.001",
        userId: "U900",
        text: "재검증 실패 @be",
        channelType: "channel",
      }),
    );

    expect(slack.messages.get("C123:303.001")?.text).toBe("재검증 실패 @be");
    expect(slack.updates).toHaveLength(2);
    expect(radarServer.requests).toEqual([
      { internalKey: INTERNAL_KEY, ifNoneMatch: undefined },
      { internalKey: INTERNAL_KEY, ifNoneMatch: '"mention-groups-1"' },
      { internalKey: INTERNAL_KEY, ifNoneMatch: '"mention-groups-2"' },
      { internalKey: INTERNAL_KEY, ifNoneMatch: '"mention-groups-3"' },
    ]);
  });

  it("OAuth 대기 중 삭제·재생성되면 TTL 후 갱신 catalog의 새 멤버만 사용한다", async () => {
    const radarServer = await startRadarServer(7, [
      group(
        "61b37086-28f7-44fd-9683-e1d8821cd51f",
        "backend",
        ["be"],
        ["U111"],
      ),
    ]);
    let now = 0;
    const radar = new RadarMentionGroupsClient({
      apiUrl: radarServer.apiUrl,
      apiKey: INTERNAL_KEY,
      cacheTtlMs: 10,
      requestTimeoutMs: 1_000,
      now: () => now,
    });
    const oauth = new InMemoryOAuth();
    const slack = new InMemorySlack();
    const service = new MentionGroupReplacementService(radar, oauth, slack);
    slack.putMessage({
      channelId: "G123",
      messageTs: "400.001",
      threadTs: "400.000",
      userId: "U902",
      text: "OAuth 대기 @be",
    });

    await service.handleEvent(
      event({
        eventId: "EvOAuthDelete",
        channelId: "G123",
        messageTs: "400.001",
        threadTs: "400.000",
        userId: "U902",
        text: "OAuth 대기 @be",
        channelType: "group",
      }),
    );
    expect(slack.messages.get("G123:400.001")?.text).toBe("OAuth 대기 @be");

    radarServer.setCatalog(8, [
      group(
        "f0d30ac5-892e-4d98-af10-63878ef17856",
        "backend",
        ["be"],
        ["U777"],
      ),
    ]);
    now = 11;
    oauth.setToken("T123", "U902", "xoxp-after-delete");
    await service.resumeAfterAuthorization({
      teamId: "T123",
      userId: "U902",
      context: {
        channelId: "G123",
        messageTs: "400.001",
        threadTs: "400.000",
        eventId: "EvOAuthDelete",
      },
    });

    expect(slack.messages.get("G123:400.001")?.text).toBe("OAuth 대기 `@be`(<@U777>)");
    expect(slack.messages.get("G123:400.001")?.text).not.toContain("U111");
    expect(radarServer.requests).toEqual([
      { internalKey: INTERNAL_KEY, ifNoneMatch: undefined },
      { internalKey: INTERNAL_KEY, ifNoneMatch: '"mention-groups-7"' },
    ]);
  });
});

function group(
  id: string,
  handle: string,
  aliases: string[],
  memberUserIds: string[],
): ActiveMentionGroup {
  return { id, handle, aliases, memberUserIds };
}

function event(input: {
  eventId: string;
  channelId: string;
  messageTs: string;
  userId: string;
  text: string;
  channelType: "channel" | "group";
  threadTs?: string;
}): MentionMessageEvent {
  const parsed = extractMentionMessageEvent(
    { team_id: "T123", event_id: input.eventId },
    {
      type: "message",
      team: "T123",
      user_team: "T123",
      channel: input.channelId,
      channel_type: input.channelType,
      user: input.userId,
      ts: input.messageTs,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    },
  );
  if (!parsed) throw new Error("test event did not satisfy the Slack event contract");
  return parsed;
}

async function startRadarServer(
  initialRevision: number,
  initialGroups: ActiveMentionGroup[],
): Promise<RadarHarness> {
  let revision = initialRevision;
  let groups = initialGroups;
  let nextFailureStatus: number | null = null;
  const requests: RadarRequestRecord[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "GET" || url.pathname !== "/internal/v1/mention-groups") {
      response.writeHead(404).end();
      return;
    }

    const internalKey = headerValue(request.headers["x-radar-internal-key"]);
    const ifNoneMatch = headerValue(request.headers["if-none-match"]);
    requests.push({ internalKey, ifNoneMatch });
    if (internalKey !== INTERNAL_KEY) {
      response.writeHead(401).end();
      return;
    }
    if (nextFailureStatus !== null) {
      const status = nextFailureStatus;
      nextFailureStatus = null;
      response.writeHead(status).end();
      return;
    }

    const etag = `"mention-groups-${revision}"`;
    if (ifNoneMatch === etag) {
      response.writeHead(304, { ETag: etag }).end();
      return;
    }
    response
      .writeHead(200, { "Content-Type": "application/json", ETag: etag })
      .end(JSON.stringify({ revision, groups }));
  });
  openServers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;

  return {
    apiUrl: `http://127.0.0.1:${address.port}/internal/v1/mention-groups`,
    requests,
    setCatalog(nextRevision, nextGroups) {
      revision = nextRevision;
      groups = nextGroups;
    },
    failNextRequestWith(status) {
      nextFailureStatus = status;
    },
    close: async () => {
      const index = openServers.indexOf(server);
      if (index >= 0) openServers.splice(index, 1);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
