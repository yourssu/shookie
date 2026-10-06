import { App, SocketModeReceiver, type AppOptions } from "@slack/bolt";
import { ConsoleLogger, LogLevel } from "@slack/logger";
import type { WebClientOptions } from "@slack/web-api";
import { logSlackSocketTokenBoundary } from "../tools/slack/action-token-diagnostics.js";

type Options = Pick<AppOptions, "token" | "customRoutes"> & { appToken: string; installerOptions?: { port: number } };

/** One standard receiver/client. Only supported client events and extractor are observed. */
export function createSocketModeApp({ token, appToken, customRoutes, installerOptions }: Options) {
  // Reproduce Bolt 4.7.2's default INFO ConsoleLogger and shared WebClient options.
  // App's own client is built BEFORE the implicit receiver adds Socket Mode's reconnect retries.
  const boltLogger = new ConsoleLogger();
  boltLogger.setName("bolt-app");
  boltLogger.setLevel(LogLevel.INFO);
  const clientOptions: WebClientOptions = { logger: boltLogger };
  const receiverClientOptions: WebClientOptions = { ...clientOptions };
  let diagnosticsEnabled = true;
  const receiver = new SocketModeReceiver({
    appToken,
    customRoutes,
    installerOptions: { clientOptions: receiverClientOptions, ...installerOptions },
    customPropertiesExtractor: (args: unknown) => {
      if (diagnosticsEnabled) logSlackSocketTokenBoundary("socket_receiver", args);
      return {}; // Preserve the default extractor's empty custom properties.
    },
  });
  // Type-specific public events precede slack_event in SocketModeClient 2.0.7.
  // Do not prepend/reorder the receiver's slack_event listener or call ack/processEvent.
  const observe = (args: unknown) => logSlackSocketTokenBoundary("socket_sdk", args);
  receiver.client.on("app_mention", observe);
  receiver.client.on("message", observe);
  const disposeDiagnostics = () => {
    diagnosticsEnabled = false;
    receiver.client.off("app_mention", observe);
    receiver.client.off("message", observe);
  };
  try {
    const app = new App({ token, appToken, socketMode: true, receiver, logger: boltLogger, clientOptions });
    // Preserve the implicit receiver's shared-options mutation for subsequent Bolt clients,
    // without changing the retry defaults of app.client created above.
    Object.assign(clientOptions, receiverClientOptions);
    return { app, receiver, disposeDiagnostics };
  } catch (error) {
    disposeDiagnostics();
    throw error;
  }
}
