export type SlackReadIdentity = Readonly<{
  userId: string;
  teamId: string;
  channel: string;
  requestId: string;
}>;
const identities = new WeakMap<object, SlackReadIdentity>();

/** Only the authenticated Slack handler may bind this. Model text/context.get() is not authority. */
export function bindSlackReadContext(context: object, identity: SlackReadIdentity): void {
  identities.set(context, Object.freeze({ ...identity }));
}
export function getSlackReadIdentity(context?: object): SlackReadIdentity | undefined {
  return context ? identities.get(context) : undefined;
}
