/**
 * Minimal Server-Sent Events parser used by the real provider adapters.
 *
 * Reads a Web ReadableStream<Uint8Array> (which is what `fetch`'s
 * `response.body` gives us) and yields one event at a time as
 * `{ event?: string, data: string }` objects.
 *
 * Why hand-rolled (instead of `eventsource-parser` from npm):
 *   - Both OpenAI and Anthropic SSE shapes are simple enough that the
 *     parsing fits in ~50 lines, and adding a dependency for it has a
 *     real audit cost (transitive deps, license review, version pins).
 *   - We need exactly one shape across both providers; using a library
 *     would still need a small adapter to normalize.
 *
 * SSE wire format (subset we care about):
 *   - Lines separated by \n (or \r\n).
 *   - Lines starting with ":" are comments — skip.
 *   - "data: foo" appends "foo" to the current event's data buffer.
 *   - "event: bar" sets the current event name.
 *   - A blank line dispatches the current event and resets buffers.
 *   - Multiple "data:" lines join with \n (per spec).
 *
 * What we deliberately don't handle (not relevant here):
 *   - "id:" / "retry:" fields (no client reconnection logic).
 *   - UTF-8 BOM at stream start (neither upstream emits one).
 */
export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | undefined;

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0 && eventName === undefined) {
      return null;
    }
    const ev: SseEvent = { data: dataLines.join("\n") };
    if (eventName !== undefined) ev.event = eventName;
    dataLines = [];
    eventName = undefined;
    return ev;
  };

  // Single line-processor used both for in-buffer lines and the
  // trailing not-newline-terminated leftover at EOF. Returns true if
  // the line was a "blank line dispatch" so the outer loop can yield.
  const processLine = (line: string): SseEvent | null => {
    if (line === "") return flush();
    if (line.startsWith(":")) return null;
    const colonIdx = line.indexOf(":");
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      eventName = value;
    }
    return null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Process every complete line currently in the buffer. We treat
      // both \n and \r\n as line terminators by stripping a trailing \r.
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        const ev = processLine(line);
        if (ev) yield ev;
      }
    }
    // EOF. Process any leftover line that wasn't \n-terminated, then
    // flush any pending event. Both branches matter:
    //   - leftover buffer covers "data: foo<EOF>" with no trailing \n
    //   - final flush covers "data: foo\n<EOF>" where the blank-line
    //     dispatcher never ran but data is queued
    if (buffer.length > 0) {
      let line = buffer;
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const ev = processLine(line);
      if (ev) yield ev;
      buffer = "";
    }
    const ev = flush();
    if (ev) yield ev;
  } finally {
    reader.releaseLock();
  }
}
