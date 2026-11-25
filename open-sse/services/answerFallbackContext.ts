/**
 * Why an attempt is not the first choice, as known by the layers around it (a combo step after
 * others, the global fallback model, the emergency fallback). Those layers mark the answer's
 * headers after the attempt returns, but the request log row and the end-of-stream metadata are
 * written inside the attempt. This request-scoped store carries their facts in.
 *
 * Request-scoped (AsyncLocalStorage): concurrent requests and hedged combo targets each see their
 * own facts. `handleChatCore` reads it once at its start, because stream callbacks later run
 * outside the store.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { mergeFallbackTokens } from "@/domain/trouteaiResponseMeta";

export interface AnswerFallbackFacts {
  /** Reason tokens, comma list, innermost first (`combo-step, global`). */
  fallback: string;
  /** Attempts that came before this one. */
  attempts: number;
}

// One store for every module graph Next.js builds, like the other request-wide singletons.
const STORE_KEY = "__trouteai_answerFallbackContext__";
const holder = globalThis as unknown as Record<
  string,
  AsyncLocalStorage<AnswerFallbackFacts> | undefined
>;
const store = (holder[STORE_KEY] ??= new AsyncLocalStorage<AnswerFallbackFacts>());

export function getAnswerFallbackFacts(): AnswerFallbackFacts | null {
  return store.getStore() ?? null;
}

/**
 * Run `fn` as an attempt that is not the first choice. Facts already set by an outer layer are
 * kept and come after the new ones, the same order the response headers get.
 */
export function runAsAnswerFallback<T>(
  facts: { fallback: string; attempts?: number } | null,
  fn: () => T
): T {
  if (!facts || !facts.fallback) return fn();
  const outer = store.getStore();
  const attempts = Math.max(0, Math.round(facts.attempts ?? 0));
  return store.run(
    {
      fallback: mergeFallbackTokens(facts.fallback, outer?.fallback),
      attempts: attempts + (outer?.attempts ?? 0),
    },
    fn
  );
}

/** Joins an attempt's own facts (inner) with the facts of the layers around it (outer). */
export function combineAnswerFallbackFacts(
  inner: { fallback?: string | null; attempts?: number },
  outer: AnswerFallbackFacts | null
): AnswerFallbackFacts {
  return {
    fallback: mergeFallbackTokens(inner.fallback ?? null, outer?.fallback ?? null),
    attempts: Math.max(0, Math.round(inner.attempts ?? 0)) + (outer?.attempts ?? 0),
  };
}
