import { DEFAULT_ENQUEUE_DEADLINES, enqueueSlackMessageRelay } from "database";
import type { SlackMessageRelayConfig } from "../../config.js";
import { createRelayCapture, type RelayCapture } from "./capture.js";
import { RelayDrainer } from "./drain.js";

export interface MessageRelayRuntime {
  capture: RelayCapture;
  drainer: RelayDrainer;
  /** Stop in this order: Socket Mode app, then close() — in-flight commits finish, drain stops, no writer remains. */
  close(): Promise<void>;
}

export function createMessageRelay(config: SlackMessageRelayConfig): MessageRelayRuntime {
  const capture = createRelayCapture(
    { appId: config.appId, teamId: config.teamId },
    (metadata) => enqueueSlackMessageRelay(metadata, DEFAULT_ENQUEUE_DEADLINES),
  );
  const drainer = new RelayDrainer({ apiUrl: config.apiUrl, apiKey: config.apiKey });
  return {
    capture,
    drainer,
    async close() {
      await capture.close();
      await drainer.stop();
    },
  };
}

export { RelayCaptureError } from "./capture.js";
