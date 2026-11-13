/**
 * Structured Logger — Pino-based logger for TRouteAI
 *
 * Usage:
 *   import { logger } from "@/shared/utils/logger";
 *   const log = logger.child({ module: "proxy" });
 *   log.info({ model: "gpt-4o" }, "Request received");
 *   log.error({ err }, "Connection failed");
 *
 * In development, output is pretty-printed via pino-pretty.
 * In production, output is structured JSON for log aggregation.
 *
 * When APP_LOG_TO_FILE is enabled (default: true), logs are also written
 * as JSON lines to the file specified by APP_LOG_FILE_PATH.
 */
import pino from "pino";
import { resolve } from "path";
import { getLogConfig, initLogRotation } from "@/lib/logRotation";
import { getAppLogLevel } from "@/lib/logEnv";
import { redactLogArgs } from "@/shared/utils/logRedaction";

const isDev = process.env.NODE_ENV !== "production";

const baseConfig: pino.LoggerOptions = {
  level: getAppLogLevel(isDev ? "debug" : "info"),
  base: { service: "trouteai" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  // Final defense-in-depth redaction net: runs in the main thread (transport-safe) and
  // scrubs credentials that slip into any log message/object/error. See logRedaction.ts.
  hooks: {
    logMethod(inputArgs: unknown[], method: (...args: unknown[]) => void) {
      return (method as (...a: unknown[]) => void).apply(this, redactLogArgs(inputArgs));
    },
  },
};

function getTransportCompatibleConfig(): pino.LoggerOptions {
  const { formatters, ...rest } = baseConfig;
  if (!formatters) return rest;

  const { level: _levelFormatter, ...safeFormatters } = formatters;
  return Object.keys(safeFormatters).length > 0 ? { ...rest, formatters: safeFormatters } : rest;
}

/**
 * Build a `pino.transport()` worker-thread stream and attach an `error` listener
 * BEFORE handing it to `pino()`.
 *
 * `pino({ transport: {...} })` builds the same stream internally but never listens
 * for its `error` event. A destination that stops existing mid-run (its directory is
 * deleted — e.g. a test's tmp `DATA_DIR` removed in `after()`, or an operator wiping
 * `logs/`) makes the worker's write fail with `ENOENT`; that surfaces as an unlistened
 * `error` event on the main-thread stream, which Node re-throws as an uncaught
 * exception ("resource generated asynchronous activity after the test
 * ended"). A logger must never crash its host process because its own log file
 * vanished, so failed writes are dropped (best-effort stderr notice) instead of
 * escalating.
 */
function buildFileTransportStream(targets: NonNullable<pino.TransportMultiOptions["targets"]>) {
  const stream = pino.transport({ targets });
  stream.on("error", (err: unknown) => {
    try {
      process.stderr.write(
        `[logger] log transport write failed, dropping log line: ${(err as Error)?.message || err}\n`
      );
    } catch {
      // Nothing more we can do — never let a logging failure crash the process.
    }
  });
  return stream;
}

const PINO_LEVEL_LABELS: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO",
  40: "WARN",
  50: "ERROR",
  60: "FATAL",
};

/**
 * Production terminal: warnings and errors only, unless APP_LOG_LEVEL is set explicitly
 * (`trouteai --verbose` sets it to info). The log file keeps the configured level.
 */
const terminalLevel = process.env.APP_LOG_LEVEL ? (baseConfig.level as string) : "warn";

/** One short line per entry ("16:52:14 WARN  [sse:AUTH] message") instead of raw JSON. */
function formatTerminalLine(line: string): string {
  try {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const time = new Date(
      typeof entry.time === "string" ? entry.time : Date.now()
    ).toLocaleTimeString("en-GB", { hourCycle: "h23" });
    const level =
      typeof entry.level === "number"
        ? (PINO_LEVEL_LABELS[entry.level] ?? String(entry.level))
        : String(entry.level ?? "").toUpperCase();
    const where = [entry.module, entry.tag].filter(Boolean).join(":");
    const err = entry.err as { message?: string } | undefined;
    const detail = err?.message ? ` (${err.message})` : "";
    return `${time} ${level.padEnd(5)} ${where ? `[${where}] ` : ""}${String(entry.msg ?? "")}${detail}\n`;
  } catch {
    return line.endsWith("\n") ? line : `${line}\n`;
  }
}

const terminalStream = {
  write(line: string) {
    process.stdout.write(formatTerminalLine(line));
  },
};

function lowerLevel(a: string, b: string): string {
  return (pino.levels.values[a] ?? 30) <= (pino.levels.values[b] ?? 30) ? a : b;
}

/**
 * Build the logger with optional file transport.
 * Uses pino transport targets for all destinations.
 */
function buildLogger(): pino.Logger {
  const logConfig = getLogConfig();
  const logLevel = (baseConfig.level as string) || "info";
  const transportConfig = getTransportCompatibleConfig();

  // If file logging is enabled, set up dual transport (stdout + file)
  if (logConfig.logToFile) {
    try {
      // Initialize log directory and rotation
      initLogRotation();

      // Resolve to absolute path for pino worker threads
      const absLogPath = resolve(logConfig.logFilePath);

      if (isDev) {
        // Dev: pino-pretty → stdout, JSON → file
        const stream = buildFileTransportStream([
          {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "SYS:HH:MM:ss.l",
              ignore: "pid,hostname,service",
              messageFormat: "[{module}] {msg}",
              destination: 1,
            },
            level: logLevel,
          },
          {
            target: "pino/file",
            options: { destination: absLogPath, mkdir: true },
            level: logLevel,
          },
        ]);
        return pino(transportConfig, stream);
      }

      // Production: short lines on the terminal, JSON → file (unchanged format)
      {
        const fileStream = buildFileTransportStream([
          {
            target: "pino/file",
            options: { destination: absLogPath, mkdir: true },
            level: logLevel,
          },
        ]);
        return pino(
          { ...transportConfig, level: lowerLevel(logLevel, terminalLevel) },
          pino.multistream([
            { level: terminalLevel as pino.Level, stream: terminalStream },
            { level: logLevel as pino.Level, stream: fileStream },
          ])
        );
      }
    } catch (err) {
      // Log the actual error for diagnostics
      try {
        process.stderr.write(
          `[logger] Failed to set up file transport, attempting sync fallback: ${(err as Error)?.message || err}\n`
        );
      } catch {}

      // Fallback: use sync pino.destination() instead of worker-thread transport
      // pino.transport() uses worker threads which can fail in Next.js production bundles
      try {
        const absLogPath = resolve(logConfig.logFilePath);
        const fileDestination = pino.destination({ dest: absLogPath, mkdir: true, sync: true });
        fileDestination.on("error", (err: unknown) => {
          try {
            process.stderr.write(
              `[logger] sync log destination write failed, dropping log line: ${(err as Error)?.message || err}\n`
            );
          } catch {
            // Nothing more we can do — never let a logging failure crash the process.
          }
        });

        // Fallback: short lines on the terminal, JSON → file via multistream
        return pino(
          { ...baseConfig, level: lowerLevel(logLevel, terminalLevel) },
          pino.multistream([
            {
              stream: isDev ? process.stdout : terminalStream,
              level: (isDev ? logLevel : terminalLevel) as pino.Level,
            },
            { stream: fileDestination, level: logLevel as pino.Level },
          ])
        );
      } catch (fallbackErr) {
        try {
          process.stderr.write(
            `[logger] Sync fallback also failed, falling back to console only: ${(fallbackErr as Error)?.message || fallbackErr}\n`
          );
        } catch {}
      }
    }
  }

  // Console-only (no file logging)
  if (isDev) {
    return pino({
      ...baseConfig,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname,service",
          messageFormat: "[{module}] {msg}",
        },
      },
    });
  }

  if (isDev) return pino(baseConfig);
  return pino(
    { ...baseConfig, level: terminalLevel },
    pino.multistream([{ level: terminalLevel as pino.Level, stream: terminalStream }])
  );
}

export const logger = buildLogger();

/**
 * Create a child logger with a module tag.
 * @param {string} module - Module name for log context (e.g., "proxy", "db", "sse")
 * @returns {pino.Logger}
 */
export function createLogger(module: string) {
  return logger.child({ module });
}
