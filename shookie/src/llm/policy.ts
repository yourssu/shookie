/** Explicit request policy; keep the configured endpoint/model and server thinking default. */
export const DEEPSEEK_REASONING_EFFORT = 'high' as const;
export const DEEPSEEK_PROVIDER_OPTIONS = {
  deepseek: { reasoningEffort: DEEPSEEK_REASONING_EFFORT },
};

// Mastra execution defaults (not modelSettings) apply to every tool-loop turn.
export const DEEPSEEK_AGENT_DEFAULTS = { providerOptions: DEEPSEEK_PROVIDER_OPTIONS };
