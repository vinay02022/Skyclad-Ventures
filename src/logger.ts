import { pino, type Logger, type LoggerOptions } from "pino";
import type { AppConfig } from "./config.js";

// Pretty in development, structured JSON everywhere else. Production logs
// go straight to stdout for the platform (Docker / k8s / Loki / etc.) to ship.
export function createLogger(config: AppConfig): Logger {
  const base: LoggerOptions = {
    level: config.LOG_LEVEL,
    base: { service: "skyclad-gateway" },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "headers.authorization",
        "headers.cookie",
        "*.api_key",
        "*.apiKey",
      ],
      remove: true,
    },
  };

  if (config.NODE_ENV === "development") {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", singleLine: false },
      },
    });
  }

  return pino(base);
}
