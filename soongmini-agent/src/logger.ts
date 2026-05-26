type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function formatMessage(level: LogLevel, msg: string): string {
  const ts = new Date().toISOString();
  return `${ts} [${level.toUpperCase()}] ${msg}`;
}

export const logger = {
  debug: (msg: string, ...args: unknown[]) => {
    if (shouldLog("debug")) console.log(formatMessage("debug", msg), ...args);
  },
  info: (msg: string, ...args: unknown[]) => {
    if (shouldLog("info")) console.info(formatMessage("info", msg), ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    if (shouldLog("warn")) console.warn(formatMessage("warn", msg), ...args);
  },
  error: (msg: string, ...args: unknown[]) => {
    if (shouldLog("error")) console.error(formatMessage("error", msg), ...args);
  },
};
