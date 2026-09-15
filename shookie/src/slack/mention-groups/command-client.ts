import { z } from "zod";
import type { AddMentionGroupCommand } from "./command-parser.js";

const createdGroupSchema = z.object({
  id: z.string().uuid(),
  handle: z.string(),
  displayName: z.string(),
  memberUserIds: z.array(z.string()),
  revision: z.number().int().positive(),
});

export type CreatedMentionGroup = z.infer<typeof createdGroupSchema>;

export class RadarMentionGroupCommandError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Radar mention group command failed: ${code}`);
    this.name = "RadarMentionGroupCommandError";
  }
}

export interface RadarMentionGroupCommandClientOptions {
  apiUrl: string;
  apiKey: string;
  fetcher?: typeof fetch;
}

export class RadarMentionGroupCommandClient {
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: RadarMentionGroupCommandClientOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async create(
    command: AddMentionGroupCommand,
    actorUserId: string,
    requestId?: string,
  ): Promise<CreatedMentionGroup> {
    const response = await this.fetcher(this.options.apiUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Radar-Internal-Key": this.options.apiKey,
        ...(requestId ? { "X-Request-Id": requestId } : {}),
      },
      body: JSON.stringify({
        actorUserId,
        handle: command.handle,
        displayName: command.displayName,
        description: "Created from Slack /group",
        aliases: [],
        memberUserIds: command.memberUserIds,
      }),
      redirect: "error",
    });

    if (!response.ok) {
      throw new RadarMentionGroupCommandError(
        response.status,
        await readErrorCode(response),
      );
    }

    const raw = await response.json().catch(() => null);
    const parsed = createdGroupSchema.safeParse(raw);
    if (!parsed.success) {
      throw new RadarMentionGroupCommandError(response.status, "invalid_schema");
    }
    return parsed.data;
  }
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { errorCode?: unknown };
    return typeof body.errorCode === "string" ? body.errorCode : `http_${response.status}`;
  } catch {
    return `http_${response.status}`;
  }
}
