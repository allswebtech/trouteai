"use client";

import { Card } from "@/shared/components";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface SearchProviderCardProps {
  providerId: string;
  t: ProviderMessageTranslator;
}

export default function SearchProviderCard({ providerId, t }: SearchProviderCardProps) {
  return (
    <Card>
      <h2 className="text-lg font-semibold mb-4">{t("searchProvider")}</h2>
      <p className="text-sm text-text-muted">{t("searchProviderDesc")}</p>
      {providerId === "perplexity-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-primary/10 border border-primary/20">
          <span className="material-symbols-outlined text-sm text-primary-text">link</span>
          <p className="text-xs text-primary-text">{t("perplexitySearchSharedKeyInfo")}</p>
        </div>
      )}
      {providerId === "google-pse-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-warning/10 border border-warning/20">
          <span className="material-symbols-outlined text-sm text-warning">tune</span>
          <p className="text-xs text-warning">{t("googlePseInfo")}</p>
        </div>
      )}
      {providerId === "searxng-search" && (
        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-success/10 border border-success/20">
          <span className="material-symbols-outlined text-sm text-success">dns</span>
          <p className="text-xs text-success">{t("searxngInfo")}</p>
        </div>
      )}
    </Card>
  );
}
