import type { App } from "@slack/bolt";
import type { ConversationEvent } from "database";
import type { ExecutionScope } from "./execution-context.js";
import { CANCEL_ACTION_ID, CANCEL_ACCEPTED_TEXT, CANCEL_UNAVAILABLE_TEXT, CancellationRegistry } from "./request-registry.js";
import { scopedSlackClient, slackDelivery } from "./slack-transport.js";

export const STOP_TEXT = {
  cancelled: "요청을 취소했습니다. 진행 중인 작업을 정리하고 있어요. 다시 필요하시면 새 메시지로 요청해주세요.",
  timed_out: "요청 처리 시간이 3분을 초과해 중단했습니다. 진행 중인 작업을 정리하고 있어요. 질문 범위를 줄여 새 메시지로 요청해주세요.",
};

export function registerCancellationAction(app: App, registry: CancellationRegistry): void {
  app.action(CANCEL_ACTION_ID, async ({ ack, body, action, context }) => {
    await ack(); // First action: never defer acknowledgement to network/registry work.
    const b = body as unknown as { user?: { id?: string }; team?: { id?: string }; channel?: { id?: string };
      container?: { type?: string; channel_id?: string; message_ts?: string }; message?: { ts?: string; thread_ts?: string } };
    const a = action as { value?: unknown };
    const user = b.user?.id, team = b.team?.id, channel = b.channel?.id, message = b.container?.message_ts;
    const valid = typeof a.value === "string" && a.value.length > 0 && a.value.length <= 256 &&
      !!user && /^[UW][A-Z0-9]{1,63}$/.test(user) && !!team && /^T[A-Z0-9]{1,63}$/.test(team) &&
      !!channel && b.container?.type === "message" && channel === b.container.channel_id && !!message &&
      (!b.message?.ts || b.message.ts === message) && (!context.teamId || context.teamId === team);
    const result = valid ? registry.cancel({ requestId: a.value as string, userId: user!, teamId: team!,
      channel: channel!, messageTs: message!, ...(b.message?.thread_ts ? { threadTs: b.message.thread_ts } : {}) }) : "unavailable";
    // A different requester never learns whether the target was cancelled/completed or even existed.
    if (user && channel) {
      try { await slackDelivery(app, client => client.chat.postEphemeral({ channel, user,
        text: result === "accepted" ? CANCEL_ACCEPTED_TEXT : CANCEL_UNAVAILABLE_TEXT })); } catch { /* ack already delivered */ }
    }
  });
}

export class SlackRequestControls {
  private messageTs?: string;
  private scope?: ExecutionScope;
  private notification?: Promise<void>;
  private notified = false;
  constructor(private readonly app: App, private readonly registry: CancellationRegistry,
    private readonly event: ConversationEvent) {}
  get stopNotified(): boolean { return this.notified; }

  async start(scope: ExecutionScope): Promise<void> {
    this.scope = scope;
    if (this.event.teamId) this.registry.register({ ...this.event, teamId: this.event.teamId }, scope.control);
    const client = scopedSlackClient(this.app, scope.control.signal);
    const posted = await client.chat.postMessage({ channel: this.event.channel, thread_ts: this.event.threadTs,
      text: "요청을 확인하고 있어요. 실행은 최대 3분이며 요청자만 취소할 수 있습니다.",
      blocks: this.event.teamId ? [{ type: "actions", elements: [{ type: "button", action_id: CANCEL_ACTION_ID,
        text: { type: "plain_text", text: "요청 취소" }, value: this.event.requestId }] }] : [] });
    if (!posted.ts) throw new Error("Missing control message linkage");
    this.messageTs = posted.ts;
    if (this.event.teamId) this.registry.bindMessage(this.event.requestId, scope.control, posted.ts);
    scope.control.signal.addEventListener("abort", this.onAbort, { once: true });
    if (scope.control.signal.aborted) this.onAbort();
  }
  private readonly onAbort = () => {
    if (!this.scope || this.scope.control.isCommitted || this.scope.control.state === "committing" || this.notified) return;
    this.notified = true;
    const text = STOP_TEXT[this.scope.control.stopReason ?? "cancelled"];
    // Notify immediately at 180 seconds, independently of residual tool settlement.
    this.notification = slackDelivery(this.app, async client => {
      if (this.messageTs) await client.chat.update({ channel: this.event.channel, ts: this.messageTs, text, blocks: [] });
      else await client.chat.postMessage({ channel: this.event.channel, thread_ts: this.event.threadTs, text });
    }).catch(() => {});
  };
  async finish(): Promise<void> {
    const scope = this.scope;
    if (!scope) return;
    scope.control.signal.removeEventListener("abort", this.onAbort);
    this.registry.remove(this.event.requestId, scope.control);
    if (this.notification) await this.notification;
    if (this.messageTs && !this.notified) {
      try { await slackDelivery(this.app, client => client.chat.update({ channel: this.event.channel,
        ts: this.messageTs!, text: scope.control.isCommitted ? "요청을 완료했습니다." : "요청을 종료했습니다.", blocks: [] })); } catch { /* expired button still denied by registry */ }
    }
  }
}
