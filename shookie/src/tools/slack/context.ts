import { isUsableSlackActionToken } from "./action-token-validation.js";

export type SlackReadIdentity = Readonly<{
  userId: string;
  teamId: string;
  channel: string;
  requestId: string;
}>;
const identities = new WeakMap<object, SlackReadIdentity>();
// Separate from exported identity / RequestContext entries. Never serialize or persist this map.
const actionTokens = new WeakMap<object, string>();

/** Only the authenticated Slack handler may bind this. Model text/context.get() is not authority. */
export function bindSlackReadContext(context: object, identity: SlackReadIdentity, actionToken?: unknown): void {
  identities.set(context, Object.freeze({ userId: identity.userId, teamId: identity.teamId, channel: identity.channel, requestId: identity.requestId }));
  actionTokens.delete(context);
  if (isUsableSlackActionToken(actionToken)) actionTokens.set(context, actionToken);
}
/** Internal search transport use only; do not add this to model context, grants or outputs. */
export function getSlackSearchActionToken(context?: object): string | undefined {
  return context ? actionTokens.get(context) : undefined;
}
export function getSlackReadIdentity(context?: object): SlackReadIdentity | undefined {
  return context ? identities.get(context) : undefined;
}
