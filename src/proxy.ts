import { NextResponse, type NextRequest } from "next/server";
import { runAuthzPipeline } from "./server/authz/pipeline";
import { isAuthzPipelinePath, isDashboardPagePath } from "./server/security/proxyRoutes";
import {
  CSP_HEADER,
  CSP_NONCE_HEADER,
  buildContentSecurityPolicy,
  createCspNonce,
} from "./server/security/csp.mjs";

function nonceCsp(): { policy: string; forward: Record<string, string> } {
  const nonce = createCspNonce();
  const policy = buildContentSecurityPolicy({
    nonce,
    isDev: process.env.NODE_ENV === "development",
  });
  // Next.js reads the nonce from the request CSP header and adds it to its own scripts;
  // src/app/layout.tsx and HTML route handlers read it from CSP_NONCE_HEADER. Both are
  // always overwritten here, so a client cannot choose the nonce.
  return { policy, forward: { [CSP_HEADER]: policy, [CSP_NONCE_HEADER]: nonce } };
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isAuthzPipelinePath(pathname)) {
    if (!isDashboardPagePath(pathname)) {
      // API / client routes and "/": unchanged (static CSP from next.config.mjs).
      return runAuthzPipeline(request, { enforce: true });
    }
    const { policy, forward } = nonceCsp();
    const response = await runAuthzPipeline(request, {
      enforce: true,
      forwardRequestHeaders: forward,
    });
    // Only when the page is actually rendered; login redirects and JSON rejections keep
    // the static header.
    if (response.headers.has("x-middleware-next")) {
      response.headers.set(CSP_HEADER, policy);
    }
    return response;
  }

  // Every other page (login, onboarding, connect, callback, error pages, /authorize, ...):
  // no authz pipeline (same as before), only the per-request nonce CSP.
  const { policy, forward } = nonceCsp();
  const requestHeaders = new Headers(request.headers);
  for (const [name, value] of Object.entries(forward)) requestHeaders.set(name, value);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(CSP_HEADER, policy);
  return response;
}

export const config = {
  matcher: [
    // Original authz matcher. The pipeline runs for exactly these paths
    // (isAuthzPipelinePath mirrors them; keep both in sync).
    "/",
    "/dashboard/:path*",
    "/home",
    "/home/:path*",
    "/api/:path*",
    "/v1/:path*",
    "/v1",
    "/v1beta/:path*",
    "/v1beta",
    "/chat/:path*",
    "/responses/:path*",
    "/responses",
    "/codex/:path*",
    "/codex",
    "/models",
    // All other pages, for the per-request CSP nonce. Skipped (they keep the static CSP
    // header and never ran the proxy): Next.js internals (/_next/*), the JSON API aliases
    // rewritten in next.config.mjs (/anthropic, /openai, /metrics, /debug), the health
    // check, and files with an extension (public/ assets, sw.js, manifest.webmanifest).
    "/((?!_next/|(?:anthropic|openai|metrics|debug|healthz)(?:/|$)|.*\\.[A-Za-z0-9]+$).*)",
  ],
};
