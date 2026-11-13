"use client";

import { useEffect, useState } from "react";
import { cn } from "@/shared/utils/cn";

interface BrandCreditData {
  text: string;
  url: string;
}

// One request per page load, shared by every BrandCredit on the page.
let creditPromise: Promise<BrandCreditData | null> | null = null;

function loadBrandCredit(): Promise<BrandCreditData | null> {
  creditPromise ??= fetch("/api/settings/require-login")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const credit = data?.brandCredit;
      return credit && typeof credit.text === "string" && credit.text
        ? { text: credit.text, url: typeof credit.url === "string" ? credit.url : "" }
        : null;
    })
    .catch(() => null);
  return creditPromise;
}

/**
 * Optional white-label credit line (BRAND_CREDIT / BRAND_CREDIT_URL in .env, see
 * src/lib/branding.ts). Renders nothing until a credit is configured.
 */
export default function BrandCredit({ className }: { className?: string }) {
  const [credit, setCredit] = useState<BrandCreditData | null>(null);

  useEffect(() => {
    let active = true;
    loadBrandCredit().then((value) => {
      if (active) setCredit(value);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!credit) return null;

  return (
    <p className={cn("break-words text-[11px] leading-snug text-text-muted", className)}>
      {credit.url ? (
        <a
          href={credit.url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-sm transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          {credit.text}
        </a>
      ) : (
        credit.text
      )}
    </p>
  );
}
