import { describe, expect, it, vi } from "vitest";
import { handleUngroupMentionGroupCommand } from "./ungroup-command.js";

describe("Slack /ungroup command", () => {
  it("deactivates a group and responds privately with the result", async () => {
    const client = {
      deactivate: vi.fn().mockResolvedValue({
        id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
        handle: "backend",
        displayName: "Backend",
        active: false,
        revision: 2,
      }),
    };
    const responder = { respond: vi.fn().mockResolvedValue(undefined) };

    await handleUngroupMentionGroupCommand(
      { text: "backend", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(client.deactivate).toHaveBeenCalledWith(
      { handle: "backend" },
      "U900",
      expect.stringMatching(/^shookie-ungroup-T123-/u),
    );
    expect(responder.respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: expect.stringContaining("그룹을 삭제했습니다"),
    });
  });

  it("returns usage without calling Radar for invalid input", async () => {
    const client = { deactivate: vi.fn() };
    const responder = { respond: vi.fn().mockResolvedValue(undefined) };

    await handleUngroupMentionGroupCommand(
      { text: "backend extra", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(client.deactivate).not.toHaveBeenCalled();
    expect(responder.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("사용법") }),
    );
  });
});
