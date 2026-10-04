/** One absolute execution deadline; construct only AFTER runtime.acquire(), never at admission. */
export const CONVERSATION_DEADLINE_MS = 180_000;

export type StopReason = "cancelled" | "timed_out";
export type ExecutionState = "running" | "committing" | "committed" | "settled";

export class ConversationStoppedError extends Error {
  constructor(readonly reason: StopReason) {
    super(reason === "cancelled" ? "요청이 취소되었습니다." : "요청 처리 시간이 3분을 초과했습니다.");
    this.name = "ConversationStoppedError";
  }
}

/**
 * Cooperative cancellation, NOT a Promise.race executor. Operations remain owned by
 * the runtime until they actually settle. All stages share this signal/deadline.
 */
export class ConversationControl {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private currentState: ExecutionState = "running";
  private stopped?: StopReason;
  readonly startedAt: number;
  readonly deadlineAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
    this.deadlineAt = this.startedAt + CONVERSATION_DEADLINE_MS;
    this.timer = setTimeout(() => this.stop("timed_out"), CONVERSATION_DEADLINE_MS);
    this.timer.unref?.();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get state(): ExecutionState { return this.currentState; }
  get stopReason(): StopReason | undefined { this.refreshDeadline(); return this.stopped; }
  get isCommitted(): boolean { return this.currentState === "committed"; }

  private refreshDeadline(): void {
    if (this.now() >= this.deadlineAt) this.stop("timed_out");
  }

  /** Called by a verified requester only. Persistence already in flight cannot be cancelled. */
  cancel(): boolean {
    this.refreshDeadline();
    if (this.currentState !== "running" || this.stopped) return false;
    return this.stop("cancelled");
  }

  private stop(reason: StopReason): boolean {
    if (this.currentState === "committed" || this.currentState === "settled" || this.stopped) return false;
    this.stopped = reason;
    clearTimeout(this.timer);
    this.controller.abort(new ConversationStoppedError(reason));
    return true;
  }

  /** Check before starting AND after settling each stage; never consume late results. */
  checkpoint(): void {
    this.refreshDeadline();
    if (this.stopped) throw new ConversationStoppedError(this.stopped);
    if (this.currentState !== "running") throw new Error("Conversation is not executing");
  }

  async operation<T>(execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.checkpoint();
    try {
      const result = await execute(this.signal);
      this.checkpoint();
      return result;
    } catch (error) {
      // Normalize provider abort errors without leaking provider messages/tokens.
      if (this.stopped) throw new ConversationStoppedError(this.stopped);
      throw error;
    }
  }

  /**
   * Linearization boundary: reject a late commit BEFORE invoking persistence.
   * Once started, await its real outcome (DB has no AbortSignal transaction API).
   * Success wins a concurrent deadline; never turn a durable successful turn into fail().
   * Delivery after success belongs to a separate bounded scope, not this deadline.
   */
  async commit(persist: () => Promise<void>): Promise<void> {
    this.checkpoint();
    this.currentState = "committing";
    try {
      await persist();
      this.currentState = "committed";
      clearTimeout(this.timer);
    } catch (error) {
      this.currentState = "running";
      if (this.stopped) throw new ConversationStoppedError(this.stopped);
      throw error;
    }
  }

  /** Only after all execution operations/commit have settled; not permission to release early. */
  finish(): void {
    clearTimeout(this.timer);
    // Keep durable success observable even after delivery cleanup.
    if (this.currentState !== "committed") this.currentState = "settled";
  }
}
