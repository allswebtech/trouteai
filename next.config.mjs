import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASE_PRODUCTION_SERVER } from "next/constants.js";
import { normalizeBasePath } from "./scripts/build/normalizeBasePath.mjs";
import { CSP_HEADER, buildContentSecurityPolicy } from "./src/server/security/csp.mjs";

const distDir = process.env.NEXT_DIST_DIR || ".build/next";
const projectRoot = dirname(fileURLToPath(import.meta.url));
// Static CSP for responses the proxy does not give a per-request nonce CSP (API JSON,
// public files, redirects). HTML pages get a nonce CSP from src/proxy.ts instead: it uses
// the same lowercase header key, so Next.js replaces this value rather than sending two
// CSP headers (two headers would be enforced together). Both are built by
// src/server/security/csp.mjs; see there for why script-src/style-src look as they do.
// No third-party script/style/font origins (fonts are self-hosted by next/font).
const isDev = process.env.NODE_ENV === "development";
const contentSecurityPolicy = buildContentSecurityPolicy({ isDev });
const securityHeaders = [
  { key: CSP_HEADER, value: contentSecurityPolicy },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
  },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  // Keep OAuth popups working (they talk back via window.opener) while isolating the window.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  // Private dashboard + API: keep every page and response out of search and AI indexes.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

function isNextIntlExtractorDynamicImportWarning(warning) {
  const message = typeof warning === "string" ? warning : warning?.message || "";
  const resource = warning?.module?.resource || warning?.file || "";
  const target = "next-intl/dist/esm/production/extractor/format/index.js";
  return (
    resource.includes(target) &&
    (message.includes("import(t)") || message.includes("dependency is an expression"))
  );
}

function readTimeoutMs(...values) {
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : value;
    if (normalized == null || normalized === "") continue;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return 600_000;
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Opt-in subpath deployment behind a reverse proxy (e.g. https://host/trouteai/).
  // Empty by default so root-path deployments are unaffected.
  basePath: normalizeBasePath(process.env.TROUTEAI_BASE_PATH),
  env: {
    NEXT_PUBLIC_TROUTEAI_BASE_PATH: normalizeBasePath(process.env.TROUTEAI_BASE_PATH),
    // Hosting panels (SixPanel) set NEXT_PUBLIC_SITE_URL to the site's https address; use it
    // when NEXT_PUBLIC_BASE_URL is not set, so no address has to be typed.
    ...(!process.env.NEXT_PUBLIC_BASE_URL?.trim() && process.env.NEXT_PUBLIC_SITE_URL?.trim()
      ? { NEXT_PUBLIC_BASE_URL: process.env.NEXT_PUBLIC_SITE_URL.trim() }
      : {}),
  },
  distDir,
  turbopack: {
    root: projectRoot,
    // open-sse/services/compression/{ruleLoader,engines/rtk/filterLoader}.ts walk up
    // directories with a non-literal fs path; the access is bounded and benign.
    ignoreIssue: [
      {
        path: "**/open-sse/services/compression/**",
        description: /Overly broad patterns can lead to build performance issues/,
      },
    ],
  },
  compress: true,
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
  experimental: {
    // Build memory (set by scripts/build/build.mjs). Every build worker is a separate Node
    // process, so fewer workers = a lower peak on small servers (hosting panels kill a
    // build that goes past the free memory). The Turbopack build cache only speeds up the
    // next build in the same folder; panels build each release in a new folder, so it is
    // off unless TROUTEAI_BUILD_CACHE=1.
    ...(Number(process.env.TROUTEAI_BUILD_CPUS) > 0
      ? { cpus: Math.floor(Number(process.env.TROUTEAI_BUILD_CPUS)) }
      : {}),
    turbopackFileSystemCacheForBuild: process.env.TROUTEAI_BUILD_CACHE === "1",
    // AI request bodies routinely include multi-MB payloads (images, long histories).
    serverActions: {
      bodySizeLimit: process.env.TROUTEAI_SERVER_ACTIONS_BODY_LIMIT || "50mb",
    },
    // Next.js proxy (middleware) body clone limit; /v1/files uploads can exceed 10MB.
    proxyClientMaxBodySize: process.env.NEXT_PROXY_BODY_LIMIT || "512mb",
    // Non-streaming chat requests can legitimately stay open for minutes.
    proxyTimeout: readTimeoutMs(process.env.REQUEST_TIMEOUT_MS, process.env.FETCH_TIMEOUT_MS),
    // Only EXTERNAL barrel libraries here (never the internal @trouteai/open-sse workspace).
    optimizePackageImports: [
      "@lobehub/icons",
      "date-fns",
      "lodash",
      "lodash-es",
      "material-symbols",
      "next-intl",
    ],
  },
  serverExternalPackages: [
    "pino",
    "pino-pretty",
    "thread-stream",
    "pino-abstract-transport",
    "better-sqlite3",
    // Loaded at runtime via createRequire()/dynamic import (some are optional and may be
    // absent); externalizing keeps the bundler from trying to resolve or bundle them.
    "sql.js",
    "node-machine-id",
    "keytar",
    "wreq-js",
    "zod",
    "tls-client-node",
    "koffi",
    "tough-cookie",
    "@huggingface/transformers",
    // `ws` must stay external so its optional native addons resolve at runtime.
    "ws",
    "bufferutil",
    "utf-8-validate",
    "child_process",
    "fs",
    "path",
    "os",
    "crypto",
    "net",
    "tls",
    "http",
    "https",
    "stream",
    "buffer",
    "util",
    "process",
  ],
  transpilePackages: ["@trouteai/open-sse", "@lobehub/icons"],
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  typescript: {
    // Type errors are checked separately (`npm run typecheck`); don't block builds on them.
    ignoreBuildErrors: true,
  },
  webpack(config) {
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      isNextIntlExtractorDynamicImportWarning,
    ];
    config.optimization = config.optimization || {};
    config.optimization.splitChunks = {
      ...config.optimization.splitChunks,
      cacheGroups: {
        ...(config.optimization.splitChunks?.cacheGroups || {}),
        recharts: {
          test: /[\\/]node_modules[\\/]recharts[\\/]/,
          name: "vendor-recharts",
          chunks: "all",
          priority: 20,
        },
        lobeIcons: {
          test: /[\\/]node_modules[\\/]@lobehub[\\/]icons[\\/]/,
          name: "vendor-lobe-icons",
          chunks: "all",
          priority: 20,
        },
        monaco: {
          test: /[\\/]node_modules[\\/]monaco-editor[\\/]/,
          name: "vendor-monaco",
          chunks: "all",
          priority: 20,
        },
        xyflow: {
          test: /[\\/]node_modules[\\/]@xyflow[\\/]/,
          name: "vendor-xyflow",
          chunks: "all",
          priority: 20,
        },
        nextIntl: {
          test: /[\\/]node_modules[\\/]next-intl[\\/]/,
          name: "vendor-next-intl",
          chunks: "all",
          priority: 25,
        },
      },
    };
    return config;
  },
  images: {
    unoptimized: true,
  },

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Streamed (SSE) API responses must not be buffered by nginx-style reverse proxies
      // (common in hosting panels); this header is a no-op for non-streaming responses.
      ...[
        "/v1/:path*",
        "/api/v1/:path*",
        "/chat/completions",
        "/responses",
        "/responses/:path*",
        "/codex/:path*",
      ].map((source) => ({
        source,
        headers: [{ key: "X-Accel-Buffering", value: "no" }],
      })),
    ];
  },

  async rewrites() {
    return [
      { source: "/chat/completions", destination: "/api/v1/chat/completions" },
      { source: "/responses", destination: "/api/v1/responses" },
      { source: "/responses/:path*", destination: "/api/v1/responses/:path*" },
      { source: "/models", destination: "/api/v1/models" },
      { source: "/v1/v1/:path*", destination: "/api/v1/:path*" },
      { source: "/v1/v1", destination: "/api/v1" },
      { source: "/codex/:path*", destination: "/api/v1/responses" },
      { source: "/v1/:path*", destination: "/api/v1/:path*" },
      { source: "/v1", destination: "/api/v1" },
      { source: "/v1beta/:path*", destination: "/api/v1beta/:path*" },
      { source: "/v1beta", destination: "/api/v1beta" },
      // Unknown root-level API-ish paths return JSON 404 via /api/[...trouteaiApiCatchAll]
      // instead of the dashboard HTML shell.
      { source: "/anthropic/:path*", destination: "/api/anthropic/:path*" },
      { source: "/openai/:path*", destination: "/api/openai/:path*" },
      { source: "/metrics", destination: "/api/metrics" },
      { source: "/debug", destination: "/api/debug" },
      { source: "/.env", destination: "/api/.env" },
    ];
  },
};

// The next-intl plugin only configures the bundler (dev and build). The production server
// skips it, so an installed package does not need next-intl and its compiler dependencies
// at runtime; the built bundles already contain what the plugin set up.
export default async function config(phase) {
  if (phase === PHASE_PRODUCTION_SERVER) return nextConfig;
  const { default: createNextIntlPlugin } = await import("next-intl/plugin");
  return createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
}
