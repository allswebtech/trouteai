// src/shared/schemas/searchTools.ts
import { z } from "zod";

/** Item returned by /api/search/providers. */
export const SearchProviderCatalogItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** "search" for the 12 search providers; "fetch" for firecrawl/jina/tavily-fetch. */
  kind: z.enum(["search", "fetch"]),
  costPerQuery: z.number().nonnegative(),
  freeMonthlyQuota: z.number().int().nonnegative(),
  searchTypes: z.array(z.string()).optional(), // search only
  fetchFormats: z.array(z.string()).optional(), // fetch only
  /** "configured" = credentials present; "missing" = no credentials; "rate_limited" = every key is in cooldown. */
  status: z.enum(["configured", "missing", "rate_limited"]),
  /** Link to set up the provider. */
  configureHref: z.string().default("/dashboard/providers"),
});
export type SearchProviderCatalogItem = z.infer<typeof SearchProviderCatalogItemSchema>;

export const SearchProviderCatalogResponseSchema = z.object({
  providers: z.array(SearchProviderCatalogItemSchema),
});

/** ScrapeResult shown in the Scrape tab (the /v1/web/fetch answer, typed). */
export const ScrapeResultSchema = z.object({
  provider: z.string(),
  url: z.string(),
  content: z.string(),
  links: z.array(z.string()),
  metadata: z
    .object({
      title: z.string().nullable(),
      description: z.string().nullable(),
    })
    .nullable(),
  screenshot_url: z.string().nullable(),
});
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;
