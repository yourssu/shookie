import { describe, expect, it, vi } from "vitest";
import { handleAddMentionGroupCommand } from "./add-command.js";

describe("Slack /group command", () => {
  it("creates a group and responds privately with the result", async () => {
    const client = {
      create: vi.fn().mockResolvedValue({
        id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
        handle: "backend",
        displayName: "Backend",
        memberUserIds: ["U111", "U222"],
        revision: 1,
      }),
    };
    const responder = { respond: vi.fn().mockResolvedValue(undefined) };

    await handleAddMentionGroupCommand(
      { text: "backend <@U111> <@U222>", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "backend", memberUserIds: ["U111", "U222"] }),
      "U900",
      expect.stringMatching(/^shookie-add-group-T123-/u),
    );
    expect(responder.respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: expect.stringContaining("그룹을 만들었습니다"),
    });
  });

  it("returns usage without calling Radar for invalid input", async () => {
    const client = { create: vi.fn() };
    const responder = { respond: vi.fn().mockResolvedValue(undefined) };

    await handleAddMentionGroupCommand(
      { text: "backend", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(client.create).not.toHaveBeenCalled();
    expect(responder.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("사용법") }),
    );
  });
});
