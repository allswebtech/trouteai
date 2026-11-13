import type { MetadataRoute } from "next";

// A self-hosted admin dashboard and API: no crawler (search engine or AI) may index it.
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
