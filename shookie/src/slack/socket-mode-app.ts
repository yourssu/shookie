import { App, SocketModeReceiver, defaultProcessEventErrorHandler, type AppOptions } from "@slack/bolt";
import { ConsoleLogger, LogLevel } from "@slack/logger";
import type { WebClientOptions } from "@slack/web-api";

import { RelayCaptureError, wrapProcessEvent, type RelayCapture } from "./message-relay/capture.js";

type Options = Pick<AppOptions, "token" | "customRoutes"> & {
  appToken: string;
  installerOptions?: { port: number };
  /** Optional durable capture that runs at the receiver boundary, BEFORE Bolt acknowledges the event. */
  messageRelay?: Pick<RelayCapture, "capture">;
};

/** One standard Socket Mode receiver/client with Bolt's default logger and retry semantics. */
export function createSocketModeApp({ token, appToken, customRoutes, installerOptions, messageRelay }: Options) {
  // Reproduce Bolt 4.7.2's default INFO ConsoleLogger and shared WebClient options.
  // App's own client is built BEFORE the implicit receiver adds Socket Mode's reconnect retries.
  const boltLogger = new ConsoleLogger();
  boltLogger.setName("bolt-app");
  boltLogger.setLevel(LogLevel.INFO);
  const clientOptions: WebClientOptions = { logger: boltLogger };
  const receiverClientOptions: WebClientOptions = { ...clientOptions };
  const receiver = new SocketModeReceiver({
    appToken,
    customRoutes,
    installerOptions: { clientOptions: receiverClientOptions, ...installerOptions },
    ...(messageRelay
      ? {
          // Bolt's default handler never ACKs a thrown error, but make the fail-closed rule explicit:
          // an unpersisted capturable event must stay un-acknowledged so Slack redelivers it.
          processEventErrorHandler: async (args: Parameters<typeof defaultProcessEventErrorHandler>[0]) => {
            if (args.error instanceof RelayCaptureError) return false;
            return defaultProcessEventErrorHandler(args);
          },
        }
      : {}),
  });
  if (messageRelay) {
    // The receiver's own single `slack_event` listener calls `this.app.processEvent(event)`; Bolt's App.processEvent
    // ACKs Events API requests BEFORE global middleware (ignoreSelf) and listeners. Wrapping the receiver's app facade
    // persists metadata first without a second listener, a second connection, or any Bolt option change.
    const init = receiver.init.bind(receiver);
    receiver.init = (boltApp) => {
      const facade = { processEvent: wrapProcessEvent(boltApp.processEvent.bind(boltApp), messageRelay) };
      init(facade as unknown as App);
    };
  }
  const app = new App({ token, appToken, socketMode: true, receiver, logger: boltLogger, clientOptions });
  // Preserve the implicit receiver's shared-options mutation for subsequent Bolt clients,
  // without changing the retry defaults of app.client created above.
  Object.assign(clientOptions, receiverClientOptions);
  return { app, receiver };
}
