import { App, SocketModeReceiver, type AppOptions } from "@slack/bolt";
import { ConsoleLogger, LogLevel } from "@slack/logger";
import type { WebClientOptions } from "@slack/web-api";

type Options = Pick<AppOptions, "token" | "customRoutes"> & { appToken: string; installerOptions?: { port: number } };

/** One standard Socket Mode receiver/client with Bolt's default logger and retry semantics. */
export function createSocketModeApp({ token, appToken, customRoutes, installerOptions }: Options) {
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
  });
  const app = new App({ token, appToken, socketMode: true, receiver, logger: boltLogger, clientOptions });
  // Preserve the implicit receiver's shared-options mutation for subsequent Bolt clients,
  // without changing the retry defaults of app.client created above.
  Object.assign(clientOptions, receiverClientOptions);
  return { app, receiver };
}
