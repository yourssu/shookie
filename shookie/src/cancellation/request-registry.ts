import type { ConversationControl } from "./conversation-control.js";

/** Immutable server-side identity from the original verified Slack event. */
export interface CancellationOwner {
  requestId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  userId: string;
}

/**
 * Use only Slack's verified action.user/team/channel/container fields.
 * Never populate identity/linkage from action.value, blocks, metadata, or model output.
 * `requestId` is the sole untrusted lookup hint from the button value.
 */
export interface TrustedCancellationAction {
  requestId: string;
  userId: string;
  teamId: string;
  channel: string;
  messageTs: string;
  threadTs?: string;
}

export const CANCEL_ACTION_ID = "shookie_cancel_request";
export const CANCEL_ACCEPTED_TEXT = "요청 취소를 접수했습니다. 진행 중인 작업을 정리하고 있어요.";
// Same message for forbidden, malformed, expired, completed, and repeated actions.
// No lookup result or other user's cancellation state is disclosed.
export const CANCEL_UNAVAILABLE_TEXT = "이 버튼으로 요청을 취소할 수 없습니다. 요청자만 실행 중인 요청을 취소할 수 있어요. 이미 종료된 요청이라면 새 메시지로 요청해주세요.";

interface Entry {
  owner: Readonly<CancellationOwner>;
  control: ConversationControl;
  messageTs?: string;
}

/**
 * Active executions only. The runtime's existing admission bound bounds entries;
 * don't evict live executions (including aborted ones that have not settled).
 * Remove in execution finally, after settling and attempting UI cleanup.
 */
export class CancellationRegistry {
  private readonly entries = new Map<string, Entry>();

  register(owner: CancellationOwner, control: ConversationControl): void {
    if (Object.values(owner).some(value => typeof value !== "string" || !value)) {
      throw new Error("Cancellation requires a complete trusted identity");
    }
    if (this.entries.has(owner.requestId)) throw new Error("Cancellation request already registered");
    this.entries.set(owner.requestId, { owner: Object.freeze({ ...owner }), control });
  }

  /** Bind only the ts returned by the server's own initial control-message post. */
  bindMessage(requestId: string, control: ConversationControl, messageTs: string): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.control !== control || entry.messageTs || !messageTs) {
      throw new Error("Invalid cancellation message binding");
    }
    entry.messageTs = messageTs;
  }

  cancel(action: TrustedCancellationAction): "accepted" | "unavailable" {
    const entry = this.entries.get(action.requestId);
    if (!entry || !entry.messageTs) return "unavailable";
    const { owner, control } = entry;
    if (action.userId !== owner.userId || action.teamId !== owner.teamId ||
        action.channel !== owner.channel || action.messageTs !== entry.messageTs ||
        (action.threadTs !== undefined && action.threadTs !== owner.threadTs)) return "unavailable";
    return control.cancel() ? "accepted" : "unavailable";
  }

  /** Compare controller identity too: a stale finally must not delete a later registration. */
  remove(requestId: string, control: ConversationControl): void {
    if (this.entries.get(requestId)?.control === control) this.entries.delete(requestId);
  }
}
