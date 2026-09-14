import { describe, expect, it, vi } from "vitest";
import { RadarMentionGroupsClient, RadarMentionGroupsError } from "./radar-client.js";

const responseBody = {
  revision: 12,
  groups: [
    {
      id: "61b37086-28f7-44fd-9683-e1d8821cd51f",
      handle: "backend",
      aliases: ["be"],
      memberUserIds: ["U0123456789"],
    },
  ],
};

function jsonResponse(body = responseBody): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ETag: `"mention-groups-${body.revision}"` },
  });
}

function client(
  fetcher: ReturnType<typeof vi.fn>,
  now: () => number = () => 0,
): RadarMentionGroupsClient {
  return new RadarMentionGroupsClient({
    apiUrl: "https://radar.example.com/internal/v1/mention-groups",
    apiKey: "internal-api-key-value",
    cacheTtlMs: 1_000,
    requestTimeoutMs: 5_000,
    fetcher,
    now,
  });
}

describe("RadarMentionGroupsClient", () => {
  it("실제 내부 API 헤더와 revision/ETag 계약으로 활성 그룹을 캐시한다", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse());
    const radar = client(fetcher);

    const first = await radar.getCatalog();
    const second = await radar.getCatalog();

    expect(first.revision).toBe(12);
    expect(first.byHandle.get("be")?.handle).toBe("backend");
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({
      Accept: "application/json",
      "X-Radar-Internal-Key": "internal-api-key-value",
    });
  });

  it("TTL 뒤 If-None-Match로 재검증하고 304이면 같은 catalog를 연장한다", async () => {
    let time = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"mention-groups-12"' } }),
      );
    const radar = client(fetcher, () => time);

    const first = await radar.getCatalog();
    time = 1_001;
    const second = await radar.getCatalog();

    expect(second).toBe(first);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"mention-groups-12"',
    });
  });

  it("중간 프록시가 동일 revision ETag를 weak 형식으로 바꿔도 허용한다", async () => {
    let time = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { ETag: 'W/"mention-groups-12"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: { ETag: 'W/"mention-groups-12"' },
        }),
      );
    const radar = client(fetcher, () => time);

    const first = await radar.getCatalog();
    time = 1_001;
    const second = await radar.getCatalog();

    expect(first.etag).toBe('"mention-groups-12"');
    expect(second).toBe(first);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"mention-groups-12"',
    });
  });

  it("weak ETag라도 body revision과 다르면 거부한다", async () => {
    const radar = client(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { ETag: 'W/"mention-groups-13"' },
        }),
      ),
    );

    await expect(radar.getCatalog()).rejects.toMatchObject({ code: "invalid_etag" });
  });

  it("동시 cache miss를 하나의 Radar 요청으로 합친다", async () => {
    let resolveResponse: ((value: Response) => void) | undefined;
    const fetcher = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveResponse = resolve;
      }),
    );
    const radar = client(fetcher);

    const first = radar.getCatalog();
    const second = radar.getCatalog();
    resolveResponse?.(jsonResponse());

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("만료 뒤 장애에는 제거된 멤버가 있는 stale cache로 진행하지 않는다", async () => {
    let time = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockRejectedValueOnce(new Error("secret-bearing network failure"));
    const radar = client(fetcher, () => time);
    await radar.getCatalog();
    time = 1_001;

    await expect(radar.getCatalog()).rejects.toMatchObject({ code: "network_error" });
  });

  it("만료 뒤 빈 catalog와 다른 ID의 handle·별칭 재사용을 순서대로 반영한다", async () => {
    let time = 0;
    const recreated = {
      id: "f0d30ac5-892e-4d98-af10-63878ef17856",
      handle: "backend",
      aliases: ["be"],
      memberUserIds: ["U444"],
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(jsonResponse({ revision: 13, groups: [] }))
      .mockResolvedValueOnce(jsonResponse({ revision: 14, groups: [recreated] }));
    const radar = client(fetcher, () => time);

    const beforeDeletion = await radar.getCatalog();
    time = 1_001;
    const empty = await radar.getCatalog();
    time = 2_002;
    const afterReuse = await radar.getCatalog();

    expect(beforeDeletion.byHandle.get("be")?.memberUserIds).toEqual(["U0123456789"]);
    expect(empty.groups).toEqual([]);
    expect(empty.byHandle.has("backend")).toBe(false);
    expect(afterReuse.byHandle.get("backend")).toMatchObject(recreated);
    expect(afterReuse.byHandle.get("be")?.memberUserIds).toEqual(["U444"]);
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"mention-groups-12"',
    });
    expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({
      "If-None-Match": '"mention-groups-13"',
    });
  });

  it("schema, ETag, revision rollback과 동일 revision 변조를 거부한다", async () => {
    let time = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...responseBody, revision: 11 }), {
          status: 200,
          headers: { ETag: '"mention-groups-11"' },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ...responseBody,
          groups: [{ ...responseBody.groups[0]!, aliases: ["server"] }],
        }),
      );
    const radar = client(fetcher, () => time);
    await radar.getCatalog();

    time = 1_001;
    await expect(radar.getCatalog()).rejects.toMatchObject({ code: "revision_rollback" });
    time = 2_002;
    await expect(radar.getCatalog()).rejects.toMatchObject({
      code: "revision_content_mismatch",
    });

    const malformed = client(
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ revision: 1, groups: [{ token: "xoxp-secret" }] }), {
          status: 200,
          headers: { ETag: '"mention-groups-1"' },
        }),
      ),
    );
    await expect(malformed.getCatalog()).rejects.toBeInstanceOf(RadarMentionGroupsError);
  });

  it("응답 header 뒤 body가 멈춰도 request timeout으로 중단한다", async () => {
    const fetcher = vi.fn().mockImplementation((_url: unknown, init: RequestInit) =>
      Promise.resolve({
        status: 200,
        headers: new Headers({ ETag: '"mention-groups-1"' }),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      } as Response),
    );
    const radar = new RadarMentionGroupsClient({
      apiUrl: "https://radar.example.com/internal/v1/mention-groups",
      apiKey: "internal-api-key-value",
      cacheTtlMs: 1_000,
      requestTimeoutMs: 5,
      fetcher,
    });

    await expect(radar.getCatalog()).rejects.toMatchObject({ code: "timeout" });
  });
});
