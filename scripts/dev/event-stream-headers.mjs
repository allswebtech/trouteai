/**
 * Every event stream leaves with `X-Accel-Buffering: no`, whichever route or helper built it:
 * nginx (the usual front door of a hosted TRouteAI) buffers a proxied answer unless the app
 * sends this header, and a buffered stream reaches the client in lumps or after a time-out.
 */
function isEventStream(value) {
  const text = Array.isArray(value) ? value.join(",") : String(value ?? "");
  return text.toLowerCase().includes("text/event-stream");
}

function headerFromArgs(args, name) {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    if (Array.isArray(arg)) {
      // Raw header list: [name, value, name, value, ...] or [[name, value], ...]
      for (let i = 0; i < arg.length; i++) {
        const entry = arg[i];
        if (Array.isArray(entry) && String(entry[0]).toLowerCase() === name) return entry[1];
        if (typeof entry === "string" && entry.toLowerCase() === name && i % 2 === 0) {
          return arg[i + 1];
        }
      }
      continue;
    }
    for (const [key, value] of Object.entries(arg)) {
      if (key.toLowerCase() === name) return value;
    }
  }
  return undefined;
}

export function addEventStreamProxyHeaders(res) {
  const originalWriteHead = res.writeHead;
  res.writeHead = function writeHeadWithProxyHeaders(statusCode, ...rest) {
    try {
      const contentType = headerFromArgs(rest, "content-type") ?? res.getHeader("content-type");
      if (
        isEventStream(contentType) &&
        headerFromArgs(rest, "x-accel-buffering") === undefined &&
        !res.hasHeader("x-accel-buffering")
      ) {
        res.setHeader("X-Accel-Buffering", "no");
      }
    } catch {
      // never block an answer on an extra header
    }
    return originalWriteHead.call(this, statusCode, ...rest);
  };
}
