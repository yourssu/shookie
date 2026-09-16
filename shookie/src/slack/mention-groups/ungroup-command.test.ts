import { describe, expect, it, vi } from "vitest";
import { handleUngroupMentionGroupCommand } from "./ungroup-command.js";

describe("Slack /ungroup command", () => {
  it("permanently deletes a group and responds privately with the result", async () => {
    const client = { deletePermanently: vi.fn().mockResolvedValue(undefined) };
    const responder = { respond: vi.fn().mockResolvedValue(undefined) };

    await handleUngroupMentionGroupCommand(
      { text: "backend", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(client.deletePermanently).toHaveBeenCalledWith(
      { handle: "backend" },
      expect.stringMatching(/^shookie-ungroup-T123-/u),
    );
    expect(responder.respond).toHaveBeenCalledWith({
      response_type: "ephemeral",
      text: expect.stringContaining("영구 삭제했습니다"),
    });
  });

  it("returns usage without calling Radar for invalid input", async () => {
    const client = { deletePermanently: vi.fn() };
    const responder = { respond: vi.fn().mockResolvedValue(undefined) };

    await handleUngroupMentionGroupCommand(
      { text: "backend extra", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(client.deletePermanently).not.toHaveBeenCalled();
    expect(responder.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("사용법") }),
    );
  });
});
