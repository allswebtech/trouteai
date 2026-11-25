/**
 * A Responses turn that sends only its new input names the answer it follows in
 * `previous_response_id`. Its conversation is that answer's, so it goes to the account that gave
 * the answer (that account holds the conversation and its prompt cache). The id of every
 * Responses answer of a round-robin combo is therefore noted with its account, read from the
 * first bytes of the answer as they pass, without holding the answer back.
 */

// The id of a Responses answer: the first `"id":"resp_…"` of a JSON answer or of the stream's
// `response.created` event. Item ids (msg_, rs_, fc_) do not match.
const RESPONSE_ID = /"id"\s*:\s*"(resp_[A-Za-z0-9_-]{1,200})"/;
const SCAN_LIMIT = 64 * 1024;

/** The stickiness key of a Responses answer id. */
export function responseKey(id: string): string {
  return `response:${id}`;
}

/** The key of the answer a request follows, or null when it names none. */
export function previousResponseKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const id = (body as { previous_response_id?: unknown }).previous_response_id;
  return typeof id === "string" && id.trim() !== "" ? responseKey(id.trim()) : null;
}

/** True for a request in the Responses shape (`input`, no `messages`). */
export function isResponsesRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const record = body as { input?: unknown; messages?: unknown };
  return record.input !== undefined && !Array.isArray(record.messages);
}

/** Passes the answer on unchanged and calls `onId` with its Responses id once it has passed. */
export function noteResponseId(response: Response, onId: (id: string) => void): Response {
  if (!response?.body) return response;
  const decoder = new TextDecoder();
  let seen = "";
  let done = false;
  const scan = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (done) return;
      seen += decoder.decode(chunk, { stream: true });
      const match = RESPONSE_ID.exec(seen);
      if (match || seen.length > SCAN_LIMIT) {
        done = true;
        seen = "";
        if (match) {
          try {
            onId(match[1]);
          } catch {
            // noting the id is best effort; the answer goes on
          }
        }
      }
    },
  });
  return new Response(response.body.pipeThrough(scan), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
