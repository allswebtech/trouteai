import { SkillHandler } from "./types";
import { executeWebSearch } from "@/lib/search/executeWebSearch";
import { executeWebFetch } from "./webFetchExecution";

// Builtin tool handlers used by the web search / web fetch fallback in chatCore.
export const builtinSkills: Record<string, SkillHandler> = {
  web_search: async (input, context) => {
    const {
      query,
      limit,
      max_results,
      search_type,
      provider,
      country,
      language,
      time_range,
      offset,
      filters,
      content,
      provider_options,
      strict_filters,
    } = input as {
      query: string;
      limit?: number;
      max_results?: number;
      search_type?: "web" | "news";
      provider?: string;
      country?: string;
      language?: string;
      time_range?: "any" | "day" | "week" | "month" | "year";
      offset?: number;
      filters?: {
        include_domains?: string[];
        exclude_domains?: string[];
        safe_search?: "off" | "moderate" | "strict";
      };
      content?: {
        snippet?: boolean;
        full_page?: boolean;
        format?: "text" | "markdown";
        max_characters?: number;
      };
      provider_options?: Record<string, unknown>;
      strict_filters?: boolean;
    };
    if (!query) {
      throw new Error("Missing required field: query");
    }
    const search = await executeWebSearch({
      query,
      provider,
      limit,
      max_results,
      search_type,
      country,
      language,
      time_range,
      offset,
      filters,
      content,
      provider_options,
      strict_filters,
      apiKeyId: context.apiKeyId || null,
    });
    return {
      success: true,
      provider: search.data.provider,
      query: search.data.query,
      results: search.data.results,
      answer: search.data.answer,
      usage: search.cached ? { queries_used: 0, search_cost_usd: 0 } : search.data.usage,
      metrics: search.data.metrics,
      cached: search.cached,
      context: context.apiKeyId,
    };
  },

  web_fetch: async (input, context) => {
    const { url, format, depth, wait_for_selector, include_metadata, provider } = input as {
      url: string;
      format?: "markdown" | "html" | "links" | "screenshot";
      depth?: 0 | 1 | 2;
      wait_for_selector?: string;
      include_metadata?: boolean;
      provider?: string;
    };
    if (!url || typeof url !== "string") {
      throw new Error("Missing required field: url");
    }
    const fetched = await executeWebFetch({
      url,
      format,
      depth,
      wait_for_selector,
      include_metadata,
      provider,
      ruleProvider: context.provider ?? null,
      ruleModel: context.model ?? null,
    });
    return {
      success: true,
      provider: fetched.provider,
      url: fetched.url,
      content: fetched.content,
      links: fetched.links,
      metadata: fetched.metadata,
      screenshot_url: fetched.screenshot_url,
      context: context.apiKeyId,
    };
  },
};
