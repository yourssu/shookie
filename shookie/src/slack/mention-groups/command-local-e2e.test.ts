import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { handleAddMentionGroupCommand } from "./add-command.js";
import { RadarMentionGroupCommandClient } from "./command-client.js";

const INTERNAL_KEY = "local-command-write-key-0123456789";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("/group local experiment", () => {
  it("runs the Slack command parser, real HTTP client, and Radar write contract together", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      if (
        request.method !== "POST" ||
        request.url !== "/internal/v1/mention-groups" ||
        request.headers["x-radar-internal-key"] !== INTERNAL_KEY
      ) {
        response.writeHead(401).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
        handle: body.handle,
        displayName: body.displayName,
        memberUserIds: body.memberUserIds,
        revision: 1,
      }));
    });
    server.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const address = server.address() as AddressInfo;

    const client = new RadarMentionGroupCommandClient({
      apiUrl: `http://127.0.0.1:${address.port}/internal/v1/mention-groups`,
      apiKey: INTERNAL_KEY,
    });
    const responder = { respond: async (value: { response_type: "ephemeral"; text: string }) => value };

    await handleAddMentionGroupCommand(
      { text: "platform <@U111> <@U222>", user_id: "U900", team_id: "T123" },
      client,
      responder,
    );

    expect(requests).toEqual([
      expect.objectContaining({
        actorUserId: "U900",
        handle: "platform",
        displayName: "Platform",
        memberUserIds: ["U111", "U222"],
      }),
    ]);
  });
});
