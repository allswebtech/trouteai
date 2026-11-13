/**
 * chatCore skills-format mappers.
 *
 * Pure mapper: request wire format -> model id hint used to parse builtin tool calls.
 */

import { FORMATS } from "../../translator/formats.ts";

export function getSkillsModelIdForFormat(format: string): string {
  switch (format) {
    case FORMATS.CLAUDE:
      return "claude";
    case FORMATS.GEMINI:
      return "gemini";
    default:
      return "openai";
  }
}
