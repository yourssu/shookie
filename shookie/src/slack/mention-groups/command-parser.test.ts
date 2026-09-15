import { describe, expect, it } from "vitest";
import {
  ADD_MENTION_GROUP_USAGE,
  parseAddMentionGroupCommand,
} from "./command-parser.js";

describe("/add group parser", () => {
  it("parses Slack mentions, derives a display name, and de-duplicates members", () => {
    expect(
      parseAddMentionGroupCommand("group backend-team <@U111|alice> <@U222> <@U111|alice>"),
    ).toEqual({
      ok: true,
      command: {
        handle: "backend-team",
        displayName: "Backend Team",
        memberUserIds: ["U111", "U222"],
      },
    });
  });

  it("rejects arbitrary member text and missing group subcommands", () => {
    expect(parseAddMentionGroupCommand("group backend alice")).toMatchObject({
      ok: false,
      message: expect.stringContaining(ADD_MENTION_GROUP_USAGE),
    });
    expect(parseAddMentionGroupCommand("help")).toMatchObject({
      ok: false,
      message: expect.stringContaining(ADD_MENTION_GROUP_USAGE),
    });
  });
});
