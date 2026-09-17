import { describe, expect, it } from "vitest";
import {
  ADD_MENTION_GROUP_USAGE,
  parseAddMentionGroupCommand,
  parseUngroupMentionGroupCommand,
  UNGROUP_MENTION_GROUP_USAGE,
} from "./command-parser.js";

describe("/group parser", () => {
  it("accepts a group with one Slack member mention", () => {
    expect(parseAddMentionGroupCommand("backend <@U111|alice>")).toEqual({
      ok: true,
      command: {
        handle: "backend",
        displayName: "Backend",
        memberUserIds: ["U111"],
      },
    });
  });

  it("parses Slack mentions, derives a display name, and de-duplicates members", () => {
    expect(
      parseAddMentionGroupCommand("backend-team <@U111|alice> <@U222> <@U111|alice>"),
    ).toEqual({
      ok: true,
      command: {
        handle: "backend-team",
        displayName: "Backend Team",
        memberUserIds: ["U111", "U222"],
      },
    });
  });

  it("rejects arbitrary member text and missing members", () => {
    expect(parseAddMentionGroupCommand("backend alice")).toMatchObject({
      ok: false,
      message: expect.stringContaining(ADD_MENTION_GROUP_USAGE),
    });
    expect(parseAddMentionGroupCommand("help")).toMatchObject({
      ok: false,
      message: expect.stringContaining(ADD_MENTION_GROUP_USAGE),
    });
  });
});

describe("/ungroup parser", () => {
  it("parses one handle and normalizes its case", () => {
    expect(parseUngroupMentionGroupCommand(" Backend ")).toEqual({
      ok: true,
      command: { handle: "backend" },
    });
  });

  it("rejects missing or extra arguments", () => {
    expect(parseUngroupMentionGroupCommand("")).toEqual({
      ok: false,
      message: UNGROUP_MENTION_GROUP_USAGE,
    });
    expect(parseUngroupMentionGroupCommand("backend extra")).toEqual({
      ok: false,
      message: UNGROUP_MENTION_GROUP_USAGE,
    });
  });
});
