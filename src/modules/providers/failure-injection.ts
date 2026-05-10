import type { IncomingHttpHeaders } from "node:http";

import type { FailureInjection, FailureMode } from "./types.js";

const VALID_MODES: ReadonlySet<FailureMode> = new Set([
  "5xx",
  "rate-limit",
  "timeout",
  "stream-drop",
  "pre-stream-drop",
]);

// Header contract:
//   x-skyclad-fail: <mode>             e.g. "5xx", "rate-limit", "stream-drop"
//   x-skyclad-fail-after: <number>     for stream-drop, chunks before failure
//   x-skyclad-fail-delay: <number>     optional artificial latency in ms
//
// The header surface (rather than a body field) means failure injection can
// be turned on for any test without rewriting the body, and never appears in
// the normal request validation.
export function parseFailureInjection(headers: IncomingHttpHeaders): FailureInjection | undefined {
  const raw = headers["x-skyclad-fail"];
  const mode = typeof raw === "string" ? raw.trim() : undefined;
  if (!mode || !VALID_MODES.has(mode as FailureMode)) return undefined;

  const failure: FailureInjection = { mode: mode as FailureMode };

  const after = headers["x-skyclad-fail-after"];
  if (typeof after === "string") {
    const n = Number.parseInt(after, 10);
    if (Number.isFinite(n) && n >= 0) failure.afterChunks = n;
  }

  const delay = headers["x-skyclad-fail-delay"];
  if (typeof delay === "string") {
    const n = Number.parseInt(delay, 10);
    if (Number.isFinite(n) && n >= 0) failure.delayMs = n;
  }

  return failure;
}
