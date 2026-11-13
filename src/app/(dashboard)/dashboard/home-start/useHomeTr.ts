"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

type TrValues = Record<string, string | number>;
type TrRichValues = Record<string, string | number | ((chunks: ReactNode) => ReactNode)>;

/**
 * Translator for the "home" namespace with English fallbacks. New Home strings render in
 * English until their keys are added to src/i18n/messages/*.json.
 * For fallbacks that contain values, pass the already-formatted English string.
 */
export function useHomeTr() {
  const t = useTranslations("home");
  const has = (key: string) => typeof t.has === "function" && t.has(key);

  const tr = (key: string, fallback: string, values?: TrValues): string =>
    has(key) ? t(key, values) : fallback;

  const trRich = (key: string, fallback: ReactNode, values: TrRichValues): ReactNode =>
    has(key) ? t.rich(key, values) : fallback;

  return { tr, trRich };
}
