/**
 * Images in a request: whether a body carries any, the error a client gets when an image
 * cannot reach the model, and the fetch that turns an image URL into bytes for a provider
 * that only takes inline image data (Kiro).
 *
 * An image is either carried to the model or refused with an error that says so. It is never
 * removed on the way: a model answering without the picture it was asked about is worse than
 * a clear error.
 */
import { safeOutboundFetch, SafeOutboundFetchError } from "@/shared/network/safeOutboundFetch";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueContainsImagePart(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (typeof value === "string") return value.startsWith("data:image/");
  if (Array.isArray(value)) return value.some((entry) => valueContainsImagePart(entry, depth + 1));
  if (!isRecord(value)) return false;

  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "image" || type === "image_url" || type === "input_image") return true;
  if ("image_url" in value || "input_image" in value) return true;

  const source = isRecord(value.source) ? value.source : null;
  const mediaType = typeof source?.media_type === "string" ? source.media_type.toLowerCase() : "";
  if (mediaType.startsWith("image/")) return true;

  return Object.values(value).some((entry) => valueContainsImagePart(entry, depth + 1));
}

/** True when the conversation of a Chat Completions, Messages or Responses body has an image. */
export function requestHasImageInput(body: unknown): boolean {
  if (!isRecord(body)) return false;
  return valueContainsImagePart(body.messages) || valueContainsImagePart(body.input);
}

/** A client error about an image (400, `invalid_request_error`); the message is safe to show. */
export class ImageInputError extends Error {
  statusCode = 400;
  errorType = "invalid_request_error";
  constructor(message: string) {
    super(message);
    this.name = "ImageInputError";
  }
}

export function modelCannotSeeMessage(model: string): string {
  return `Model ${model} does not accept images, and this request has images. Remove the images or choose a model that can see.`;
}

// Claude's own limit for an inline image on Bedrock (which serves Kiro) is 5 MB of base64,
// about 3.75 MB of image.
export const MAX_FETCHED_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
export const MAX_FETCHED_IMAGES = 20;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function readCapped(response: Response, cap: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new ImageInputError(
        `An image URL points to an image larger than ${Math.floor(cap / (1024 * 1024))} MB. Send a smaller image.`
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads an image URL on the client's behalf: public addresses only, every redirect checked
 * again, a size and time limit, image types only. Throws ImageInputError with a message that
 * does not repeat the URL.
 */
export async function fetchImageAsBase64(
  url: string,
  signal?: AbortSignal | null
): Promise<{ mediaType: string; data: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await safeOutboundFetch(current, {
        method: "GET",
        guard: "public-only",
        timeoutMs: FETCH_TIMEOUT_MS,
        retry: false,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof SafeOutboundFetchError) {
        if (error.code === "REDIRECT_BLOCKED" && error.location) {
          try {
            current = new URL(error.location, current).toString();
          } catch {
            throw new ImageInputError("An image URL redirects to an invalid address.");
          }
          continue;
        }
        if (error.code === "URL_GUARD_BLOCKED" || error.code === "INVALID_URL") {
          throw new ImageInputError(
            "An image URL is not a public http(s) address, so it cannot be fetched. Send the image as base64 data."
          );
        }
      }
      throw new ImageInputError(
        "An image URL could not be fetched. Send the image as base64 data."
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ImageInputError(
        `An image URL could not be fetched (status ${response.status}). Send the image as base64 data.`
      );
    }
    const mediaType = (response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ACCEPTED_IMAGE_TYPES.has(mediaType)) {
      await response.body?.cancel().catch(() => {});
      throw new ImageInputError(
        "An image URL did not return a JPEG, PNG, GIF or WebP image. Send the image as base64 data."
      );
    }
    const declared = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > MAX_FETCHED_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new ImageInputError(
        `An image URL points to an image larger than ${Math.floor(MAX_FETCHED_IMAGE_BYTES / (1024 * 1024))} MB. Send a smaller image.`
      );
    }
    const bytes = await readCapped(response, MAX_FETCHED_IMAGE_BYTES);
    if (bytes.length === 0) throw new ImageInputError("An image URL returned an empty image.");
    return { mediaType, data: bytes.toString("base64") };
  }
  throw new ImageInputError(
    "An image URL redirects too many times. Send the image as base64 data."
  );
}

const isHttpUrl = (value: unknown): value is string =>
  typeof value === "string" && /^https?:\/\//i.test(value.trim());

/**
 * For a provider that takes inline image bytes only (Kiro): every image given by an http(s)
 * URL in the conversation (OpenAI `image_url`, Anthropic `image` with a `url` source, also
 * inside tool results, and Responses `input_image`) is downloaded and put in as base64 data.
 * Returns the body unchanged when it has no such image, otherwise a copy.
 */
export async function inlineRemoteImages<T>(body: T, signal?: AbortSignal | null): Promise<T> {
  if (!isRecord(body)) return body;
  const jobs: Array<{ url: string; apply: (img: { mediaType: string; data: string }) => void }> =
    [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 8 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const part = value as Record<string, unknown>;
    if (part.type === "image_url" && isRecord(part.image_url) && isHttpUrl(part.image_url.url)) {
      const holder = part.image_url;
      jobs.push({
        url: String(holder.url).trim(),
        apply: (img) => {
          holder.url = `data:${img.mediaType};base64,${img.data}`;
        },
      });
    } else if (part.type === "image_url" && isHttpUrl(part.image_url)) {
      jobs.push({
        url: String(part.image_url).trim(),
        apply: (img) => {
          part.image_url = { url: `data:${img.mediaType};base64,${img.data}` };
        },
      });
    } else if (part.type === "input_image" && isHttpUrl(part.image_url)) {
      jobs.push({
        url: String(part.image_url).trim(),
        apply: (img) => {
          part.image_url = `data:${img.mediaType};base64,${img.data}`;
        },
      });
    } else if (
      part.type === "image" &&
      isRecord(part.source) &&
      part.source.type === "url" &&
      isHttpUrl(part.source.url)
    ) {
      jobs.push({
        url: String(part.source.url).trim(),
        apply: (img) => {
          part.source = { type: "base64", media_type: img.mediaType, data: img.data };
        },
      });
    } else if (part.type === "image" && isHttpUrl(part.image)) {
      jobs.push({
        url: String(part.image).trim(),
        apply: (img) => {
          part.image = `data:${img.mediaType};base64,${img.data}`;
        },
      });
    }
    for (const [key, entry] of Object.entries(part)) {
      if (key === "image_url" || key === "source") continue;
      if (entry && typeof entry === "object") visit(entry, depth + 1);
    }
  };
  const copy = structuredClone(body) as Record<string, unknown>;
  visit(copy.messages, 0);
  visit(copy.input, 0);
  if (jobs.length === 0) return body;
  if (jobs.length > MAX_FETCHED_IMAGES) {
    throw new ImageInputError(
      `This request has ${jobs.length} images given by URL; at most ${MAX_FETCHED_IMAGES} can be downloaded. Send them as base64 data.`
    );
  }
  const images = await Promise.all(jobs.map((job) => fetchImageAsBase64(job.url, signal)));
  images.forEach((img, i) => jobs[i].apply(img));
  return copy as T;
}
