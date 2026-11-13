/**
 * Turkish-safe text normalization, search and sorting helpers.
 *
 * JavaScript's locale-independent `toLowerCase()` breaks the Turkish `İ/I/ı/i`
 * characters: `"İ".toLowerCase()` → `"i̇"` (U+0069 U+0307
 * combining dot above). That makes Turkish input fail to match in a
 * `toLowerCase().includes()` based search.
 *
 * Pure functions — no side effects and no dependencies.
 *
 * @module shared/utils/turkishText
 */

/** Explicit mapping for Turkish letters that NFD does not fold. */
const TR_FOLD: Readonly<Record<string, string>> = {
  ı: "i",
  ş: "s",
  ğ: "g",
  ü: "u",
  ö: "o",
  ç: "c",
};

/**
 * Builds an accent-insensitive, Turkish-safe search key.
 * `"İstanbul"` and `"istanbul"` → `"istanbul"`; `"Şarj"` → `"sarj"`.
 * Leading and trailing whitespace is trimmed.
 */
export function normalizeForSearch(input: string | null | undefined): string {
  if (!input) return "";
  let s = input.toLocaleLowerCase("tr"); // İ→i, I→ı (Turkish-safe)
  s = s.replace(/[ışğüöç]/g, (ch) => TR_FOLD[ch] ?? ch); // explicit Turkish fold
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); // strip the remaining accents
  return s.trim();
}

/**
 * Does `text` contain `query` (accent-insensitive, Turkish-safe)?
 * An empty query always returns `true`.
 */
export function matchesSearch(
  text: string | null | undefined,
  query: string | null | undefined
): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  return normalizeForSearch(text).includes(q);
}

/**
 * Checks if `text` matches any whitespace-separated token in `query`.
 * Returns `true` if `query` is empty or if any token is found in `text`.
 * Full query match takes priority over token-level OR fallback.
 */
export function matchesAnyToken(
  text: string | null | undefined,
  query: string | null | undefined
): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  const normalizedText = normalizeForSearch(text);
  if (normalizedText.includes(q)) return true;
  return q
    .split(/\s+/)
    .filter(Boolean)
    .some((token) => normalizedText.includes(token));
}

const trCollator = new Intl.Collator("tr", {
  sensitivity: "base",
  numeric: true,
});

/**
 * Turkish-alphabet, numeric-aware comparison for user-visible lists.
 * Can be passed straight to `Array.prototype.sort`.
 *
 * Because it uses `sensitivity: "base"`, accent and case variants sort as
 * equal — for example `"Şehir"` and `"şehir"` tie. This comparator is for
 * visual list ordering, not for strict accent-aware ordering.
 */
export function compareTr(a: string | null | undefined, b: string | null | undefined): number {
  return trCollator.compare(a ?? "", b ?? "");
}
