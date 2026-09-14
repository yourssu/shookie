import { describe, expect, it } from "vitest";
import {
  buildMentionGroupIndex,
  createMentionReplacementPlan,
  findMentionHandleOccurrences,
} from "./parser.js";
import type { ActiveMentionGroup, MentionGroupCatalog } from "./types.js";

const backend: ActiveMentionGroup = {
  id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
  handle: "backend",
  aliases: ["be", "server-team"],
  memberUserIds: ["U111", "U222"],
};

function catalog(groups: ActiveMentionGroup[]): MentionGroupCatalog {
  return {
    revision: 1,
    etag: '"mention-groups-1"',
    groups,
    byHandle: buildMentionGroupIndex(groups),
  };
}

describe("mention group parser", () => {
  it("명확한 경계의 handle과 별칭을 대소문자와 무관하게 찾는다", () => {
    expect(findMentionHandleOccurrences("(@Backend), @be! / @server-team")).toMatchObject([
      { handle: "backend", raw: "@Backend" },
      { handle: "be", raw: "@be" },
      { handle: "server-team", raw: "@server-team" },
    ]);
    expect(findMentionHandleOccurrences("한글@backend foo@backend @backend_more")).toMatchObject([
      { handle: "backend_more", raw: "@backend_more" },
    ]);
  });

  it("코드, Slack entity, 링크, URL, 이메일 안의 handle은 무시한다", () => {
    const text = [
      "`@backend`",
      "```ts\n@backend\n```",
      "<@backend>",
      "<https://example.com/@backend|@backend>",
      "https://example.com/@backend",
      "owner@backend.example",
      "@backend",
    ].join(" ");

    expect(findMentionHandleOccurrences(text)).toMatchObject([
      { handle: "backend", raw: "@backend" },
    ]);
  });

  it("부분 중복 그룹마다 전체 멤버를 순서대로 치환하고 로그용 합집합만 중복 제거한다", () => {
    const platform: ActiveMentionGroup = {
      id: "4d92a1d8-52f4-46b0-b389-3284cff8a688",
      handle: "platform",
      aliases: ["infra"],
      memberUserIds: ["U222", "U333"],
    };

    const result = createMentionReplacementPlan(
      "검토: @be, @platform 그리고 @backend",
      catalog([backend, platform]),
    );

    expect(result.text).toBe(
      "검토: `@be`(<@U111> <@U222>), `@platform`(<@U222> <@U333>) 그리고 " +
        "`@backend`(<@U111> <@U222>)",
    );
    expect(result.memberUserIds).toEqual(["U111", "U222", "U333"]);
    expect(result.groupHandles).toEqual(["backend", "platform"]);
    expect(result.matchedOccurrenceCount).toBe(3);
  });

  it.each([
    {
      name: "완전 중복",
      groups: [
        backend,
        {
          id: "4d92a1d8-52f4-46b0-b389-3284cff8a688",
          handle: "platform",
          aliases: [],
          memberUserIds: ["U111", "U222"],
        },
      ],
      text: "@backend @platform",
      expected:
        "`@backend`(<@U111> <@U222>) `@platform`(<@U111> <@U222>)",
      memberUserIds: ["U111", "U222"],
    },
    {
      name: "역순 부분 중복과 줄바꿈",
      groups: [
        backend,
        {
          id: "4d92a1d8-52f4-46b0-b389-3284cff8a688",
          handle: "platform",
          aliases: [],
          memberUserIds: ["U222", "U333"],
        },
      ],
      text: "@platform\n@backend",
      expected:
        "`@platform`(<@U222> <@U333>)\n`@backend`(<@U111> <@U222>)",
      memberUserIds: ["U222", "U333", "U111"],
    },
  ])("$name에서도 각 occurrence를 독립적으로 펼친다", ({ groups, text, expected, memberUserIds }) => {
    const result = createMentionReplacementPlan(text, catalog(groups));

    expect(result.text).toBe(expected);
    expect(result.memberUserIds).toEqual(memberUserIds);
  });

  it("primary·alias·같은 그룹 반복 occurrence를 모두 전체 멤버로 펼친다", () => {
    const result = createMentionReplacementPlan(
      "@backend @be @backend",
      catalog([backend]),
    );

    expect(result.text).toBe(
      "`@backend`(<@U111> <@U222>) `@be`(<@U111> <@U222>) " +
        "`@backend`(<@U111> <@U222>)",
    );
    expect(result.groupHandles).toEqual(["backend"]);
    expect(result.memberUserIds).toEqual(["U111", "U222"]);
    expect(result.matchedOccurrenceCount).toBe(3);
  });

  it("catalog에 그룹 내부 중복 ID가 들어와도 첫 순서로 한 번만 펼친다", () => {
    const defensiveGroup: ActiveMentionGroup = {
      ...backend,
      memberUserIds: ["U222", "U111", "U222", "U111"],
    };

    const result = createMentionReplacementPlan("@backend", catalog([defensiveGroup]));

    expect(result.text).toBe("`@backend`(<@U222> <@U111>)");
    expect(result.memberUserIds).toEqual(["U222", "U111"]);
  });

  it("알 수 없거나 멤버가 없는 활성 그룹은 원문에 남긴다", () => {
    const empty: ActiveMentionGroup = {
      id: "bdf1f060-2827-42a5-818c-3205279c6c8f",
      handle: "empty",
      aliases: [],
      memberUserIds: [],
    };

    const result = createMentionReplacementPlan(
      "@unknown @empty @backend",
      catalog([empty, backend]),
    );

    expect(result.text).toBe("@unknown @empty `@backend`(<@U111> <@U222>)");
    expect(result.unknownHandles).toEqual(["unknown"]);
    expect(result.emptyGroupHandles).toEqual(["empty"]);
  });

  it("대문자로 입력해도 소문자 그룹을 호출하고 라벨도 소문자로 정규화한다", () => {
    const result = createMentionReplacementPlan("확인 @Backend", catalog([backend]));

    expect(result.text).toBe("확인 `@backend`(<@U111> <@U222>)");
  });

  it("영구 삭제된 handle과 별칭은 원문에 남기고 새 ID로 재사용하면 새 멤버만 치환한다", () => {
    const original = "호출 @backend @be";
    const beforeDeletion = createMentionReplacementPlan(original, catalog([backend]));
    const afterDeletion = createMentionReplacementPlan(original, catalog([]));
    const recreated: ActiveMentionGroup = {
      id: "f0d30ac5-892e-4d98-af10-63878ef17856",
      handle: "backend",
      aliases: ["be"],
      memberUserIds: ["U444"],
    };
    const afterReuse = createMentionReplacementPlan(original, catalog([recreated]));

    expect(beforeDeletion.text).toContain("<@U111> <@U222>");
    expect(afterDeletion).toMatchObject({
      text: original,
      changed: false,
      unknownHandles: ["backend", "be"],
    });
    expect(afterReuse.text).toBe("호출 `@backend`(<@U444>) `@be`(<@U444>)");
    expect(afterReuse.memberUserIds).toEqual(["U444"]);
  });
});
