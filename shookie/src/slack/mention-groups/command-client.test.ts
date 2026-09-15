import { describe, expect, it, vi } from "vitest";
import { RadarMentionGroupCommandClient } from "./command-client.js";

describe("RadarMentionGroupCommandClient", () => {
  it("posts the Slack actor and selected members to the internal write endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
          handle: "backend",
          displayName: "Backend",
          memberUserIds: ["U111"],
          revision: 1,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    const client = new RadarMentionGroupCommandClient({
      apiUrl: "http://localhost:8080/internal/v1/mention-groups",
      apiKey: "local-write-key-0123456789",
      fetcher,
    });

    await expect(
      client.create(
        { handle: "backend", displayName: "Backend", memberUserIds: ["U111"] },
        "U900",
        "request-1",
      ),
    ).resolves.toMatchObject({ handle: "backend", revision: 1 });
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8080/internal/v1/mention-groups",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Radar-Internal-Key": "local-write-key-0123456789",
          "X-Request-Id": "request-1",
        }),
      }),
    );
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      actorUserId: "U900",
      handle: "backend",
      memberUserIds: ["U111"],
    });
  });
});
