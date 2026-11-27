import { randomBytes } from "node:crypto";

/**
 * A response id for an answer whose upstream sent none. The clock alone repeats for two
 * answers in one millisecond, so a random part follows it.
 */
export function newResponseId(): string {
  return `resp_${Date.now()}_${randomBytes(4).toString("hex")}`;
}
