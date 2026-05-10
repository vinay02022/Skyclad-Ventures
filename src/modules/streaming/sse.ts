/**
 * SSE wire format helpers.
 *
 * The full SSE spec allows multi-line `data:` blocks, named `event:`
 * fields, retry hints, and named ids. We use the smallest defensible
 * subset: one `data:` line per event, JSON-encoded, terminated by the
 * required blank line. Anything more complex is a feature the spec
 * already covers and we are not asked for.
 *
 * Event shapes the gateway emits (assignment-mandated):
 *
 *   { type: "token", content: "..." }                        — one upstream delta
 *   { type: "done" }                                         — clean end of stream
 *   { type: "error", message: "...", partial: true|false }   — stream error event
 *
 * `partial: true` means the client already received tokens before the
 * error and the response is incomplete. `partial: false` means the
 * stream failed before any token reached the client (the failover
 * loop ran and exhausted its candidates).
 */

export type SseEvent =
  | { type: "token"; content: string }
  | { type: "done" }
  | { type: "error"; message: string; partial: boolean };

/**
 * Format a single SSE event ready for `res.write(...)`.
 *
 * The trailing "\n\n" is mandatory in the spec — without it the event
 * is buffered in the client until the next event arrives, and the
 * "done" event (which has no successor) would never flush.
 */
export function formatSSEEvent(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
