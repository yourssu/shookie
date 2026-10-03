// UTF-8 bytes bound application-provided dialogue, NOT an exact model token count.
// Tools, system instructions and provider token limits remain separate concerns.
export const conversationLimits = {
  inputBytes: 16_000,
  contextBytes: 48_000,
  recentTurns: 15,
  cacheSessions: 256,
  cacheTtlMs: 15 * 60_000,
  activeRuns: 4,
  admittedRuns: 64,
  perThreadRuns: 8,
} as const;
