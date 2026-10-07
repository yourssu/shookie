import type { SlackMessageRelayMetadata } from "database";
import { logger } from "../../logger.js";
import { extractRelayMessage, type RelayIdentity } from "./event.js";

/** Thrown when a capturable event could not be durably recorded. Callers MUST NOT acknowledge Slack. */
export class RelayCaptureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RelayCaptureError";
  }
}

/**
 * The envelope's team/app differs from the configured identity. Fail closed (no ACK, nothing outboxed) and loud
 * instead of silently ACKing a whole stream that would never reach Radar.
 */
export class RelayIdentityMismatchError extends RelayCaptureError {
  constructor(readonly reason: "team" | "app") {
    super(`Slack message relay identity mismatch (${reason})`);
    this.name = "RelayIdentityMismatchError";
  }
}

export type PersistRelayEvent = (metadata: SlackMessageRelayMetadata) => Promise<unknown>;

export interface RelayCapture {
  /** Persist (if capturable) before the caller hands the event to Bolt. Throws RelayCaptureError on failure. */
  capture(body: unknown): Promise<void>;
  /** Reject new captures and wait for in-flight commits (bounded by the enqueue deadline). */
  close(): Promise<void>;
}

const DEDUPE_LIMIT = 20_000;
const MISMATCH_LOG_INTERVAL_MS = 60_000;

export function createRelayCapture(
  identity: RelayIdentity,
  persist: PersistRelayEvent,
  now: () => number = Date.now,
): RelayCapture {
  // Process-local guard for Slack retries; recorded only AFTER a successful commit.
  const committed = new Set<string>();
  const inflight = new Set<Promise<unknown>>();
  let closed = false;
  let lastMismatchLog = -Infinity;
  let mismatches = 0;
  let lastInvalidLog = -Infinity;

  return {
    async capture(body) {
      const extraction = extractRelayMessage(body, identity);
      if (extraction.kind === "ignore") return;
      if (extraction.kind === "mismatch") {
        mismatches += 1;
        if (now() - lastMismatchLog >= MISMATCH_LOG_INTERVAL_MS) {
          lastMismatchLog = now();
          logger.error("Slack 메시지 릴레이 신원(app/team) 불일치 — 이벤트를 ACK하지 않고 차단함. RADAR_SLACK_RELAY_APP_ID/TEAM_ID 확인 필요", {
            reason: extraction.reason,
            blockedEvents: mismatches,
          });
        }
        throw new RelayIdentityMismatchError(extraction.reason);
      }
      if (extraction.kind === "invalid") {
        if (now() - lastInvalidLog >= MISMATCH_LOG_INTERVAL_MS) {
          lastInvalidLog = now();
          logger.error("Slack 메시지 릴레이 이벤트 형식이 올바르지 않아 캡처하지 않음", {
            reason: extraction.reason,
            eventId: extraction.eventId,
          });
        }
        return;
      }

      const { metadata } = extraction;
      if (closed) throw new RelayCaptureError("relay capture is closed");
      const key = `${metadata.teamId}:${metadata.appId}:${metadata.eventId}`;
      if (committed.has(key)) return;

      const pending = persist(metadata);
      inflight.add(pending);
      try {
        await pending;
      } catch (error) {
        // Metadata only: never log the envelope or exception details that could echo payload data.
        logger.error("Slack 메시지 릴레이 outbox 저장 실패 — ACK하지 않음", {
          eventId: metadata.eventId,
          channelId: metadata.channelId,
          ts: metadata.ts,
          errorName: error instanceof Error ? error.name : typeof error,
        });
        throw new RelayCaptureError("failed to persist Slack message relay event", { cause: error });
      } finally {
        inflight.delete(pending);
      }
      committed.add(key);
      if (committed.size > DEDUPE_LIMIT) {
        const oldest = committed.values().next().value as string | undefined;
        if (oldest) committed.delete(oldest);
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled([...inflight]);
    },
  };
}

/**
 * Minimal app facade handed to the receiver: capture first, then Bolt's own processEvent (which ACKs
 * for Events API requests, then runs ignoreSelf + listeners). Nothing about Bolt or the event is changed.
 */
export function wrapProcessEvent<E extends { body: unknown }>(
  processEvent: (event: E) => Promise<void>,
  relay: Pick<RelayCapture, "capture">,
): (event: E) => Promise<void> {
  return async (event) => {
    await relay.capture(event.body);
    return processEvent(event);
  };
}
