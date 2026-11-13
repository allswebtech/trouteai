// Path decisions for src/proxy.ts. Kept free of imports so it can be unit-checked alone.
//
// The proxy runs on every page (for the CSP nonce), but the authz pipeline must run for
// exactly the paths of the original proxy matcher. These regexes mirror what Next.js
// compiles for those matcher entries ("/", "/dashboard/:path*", "/home", "/home/:path*",
// "/api/:path*", "/v1/:path*", "/v1", "/v1beta/:path*", "/v1beta", "/chat/:path*",
// "/responses/:path*", "/responses", "/codex/:path*", "/codex", "/models"):
// case-sensitive, non-empty segments, optional trailing slash, an optional
// "/_next/data/<id>" prefix and an optional transport suffix (.json / .rsc / segment
// prefetch), checked against the raw and the URL-decoded path, as Next.js does.

const SEGMENTS = "(?:\\/[^\\/#\\?]+?(?:\\/[^\\/#\\?]+?)*)?";

const LEGACY_AUTHZ_PATTERNS: ReadonlyArray<RegExp> = [
  /^(?:\/\/?index)?\/?$/, // "/"
  ...["dashboard", "home", "api", "v1", "v1beta", "chat", "responses", "codex"].map(
    (name) => new RegExp(`^\\/${name}${SEGMENTS}\\/?$`) // "/name" and "/name/:path*"
  ),
  /^\/models\/?$/, // "/models"
];

// Dashboard pages inside the authz set: they render HTML and get the nonce CSP.
const DASHBOARD_PAGE_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`^\\/dashboard${SEGMENTS}\\/?$`),
  new RegExp(`^\\/home${SEGMENTS}\\/?$`),
];

const NEXT_DATA_PREFIX = /^\/_next\/data\/[^/]+/;
const TRANSPORT_SUFFIX = /(?:\.json|\.rsc|\.segments\/.+\.segment\.rsc)\/?$/;

function pathCandidates(pathname: string): string[] {
  const candidates = [pathname];
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded !== pathname) candidates.push(decoded);
  } catch {
    // Undecodable path: Next.js only matches the raw form too.
  }
  for (const candidate of [...candidates]) {
    const unprefixed = candidate.replace(NEXT_DATA_PREFIX, "");
    for (const form of unprefixed === candidate ? [candidate] : [candidate, unprefixed]) {
      if (!candidates.includes(form)) candidates.push(form);
      const stripped = form.replace(TRANSPORT_SUFFIX, "");
      if (!candidates.includes(stripped)) candidates.push(stripped);
    }
  }
  return candidates;
}

function matchesAny(pathname: string, patterns: ReadonlyArray<RegExp>): boolean {
  return pathCandidates(pathname).some((path) => patterns.some((re) => re.test(path)));
}

/** True for the paths the authz pipeline ran on before (the original matcher). */
export function isAuthzPipelinePath(pathname: string): boolean {
  return matchesAny(pathname, LEGACY_AUTHZ_PATTERNS);
}

/** True for dashboard page paths (inside the authz set) that render HTML. */
export function isDashboardPagePath(pathname: string): boolean {
  return matchesAny(pathname, DASHBOARD_PAGE_PATTERNS);
}
