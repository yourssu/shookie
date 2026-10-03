import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), clientQuery: vi.fn(), release: vi.fn(), connect: vi.fn(), end: vi.fn(),
}));
vi.mock("pg", () => ({ default: { Pool: class {
  query = mocks.query;
  connect = mocks.connect;
  end = mocks.end;
} } }));
import { closePool, conversationRepository } from "database";

const event = { requestId: "synthetic-event", sessionId: "synthetic-session", channel: "C1", threadTs: "1.0", userId: "U1" };

describe("PostgreSQL conversation repository (mocked queries only)", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://synthetic:synthetic@invalid.example/synthetic");
    vi.clearAllMocks();
    mocks.query.mockReset();
    mocks.clientQuery.mockReset();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });
  afterEach(async () => { await closePool(); vi.unstubAllEnvs(); });

  it("claims atomically without leasing or reclaiming in-flight events", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    expect(await conversationRepository.claim(event)).toBe(true);
    expect(await conversationRepository.claim(event)).toBe(false);
    const [sql, args] = mocks.query.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (request_id) DO NOTHING");
    expect(args).toEqual(["synthetic-event", "synthetic-session", "C1", "1.0", "U1", null, null]);
  });

  it("reads bounded turns in chronological order", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ user_content: "user", assistant_content: "assistant" }] });
    expect(await conversationRepository.recent("session", 15)).toEqual([{ userContent: "user", assistantContent: "assistant" }]);
    expect(mocks.query.mock.calls[0][0]).toContain("ORDER BY id DESC LIMIT $2");
    expect(mocks.query.mock.calls[0][0]).toContain("recent ORDER BY id");
    expect(mocks.query.mock.calls[0][1]).toEqual(["session", 15]);
  });

  it("commits both dialogue roles and completion together", async () => {
    mocks.clientQuery.mockResolvedValue({ rowCount: 1 });
    await conversationRepository.complete(event, { userContent: "u", assistantContent: "a" });
    expect(mocks.clientQuery.mock.calls.map(call => call[0])).toEqual([
      "BEGIN", expect.stringContaining("UPDATE conversation_events"), expect.stringContaining("INSERT INTO conversation_turns"), "COMMIT",
    ]);
    expect(mocks.clientQuery.mock.calls[2][1]).toEqual([event.requestId, event.sessionId, "u", "a"]);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back completion if the turn insert fails and propagates errors", async () => {
    mocks.clientQuery.mockResolvedValueOnce({}).mockResolvedValueOnce({ rowCount: 1 })
      .mockRejectedValueOnce(new Error("synthetic DB write failure")).mockResolvedValueOnce({});
    await expect(conversationRepository.complete(event, { userContent: "u", assistantContent: "a" })).rejects.toThrow("synthetic DB write failure");
    expect(mocks.clientQuery).toHaveBeenLastCalledWith("ROLLBACK");
    expect(mocks.release).toHaveBeenCalledTimes(1);
    mocks.query.mockRejectedValueOnce(new Error("unavailable"));
    await expect(conversationRepository.recent("session", 15)).rejects.toThrow("unavailable");
  });

  it("does not rewrite completed history when marking a delivery failure", async () => {
    mocks.query.mockResolvedValueOnce({});
    await conversationRepository.fail("completed");
    expect(mocks.query.mock.calls[0][0]).toContain("AND status = 'processing'");
  });
});
