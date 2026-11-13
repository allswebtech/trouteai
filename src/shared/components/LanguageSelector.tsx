"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LANGUAGES } from "@/i18n/config";
import type { Locale } from "@/i18n/config";
import { useLocale } from "next-intl";
import { persistLocale } from "@/shared/lib/persistLocale";

function CountryFlag({ emoji, alt }: { emoji: string; alt: string }) {
  const [error, setError] = useState(false);

  if (!emoji) return null;

  const chars = [...emoji];
  const codePoints = chars.map((c) => c.codePointAt(0) || 0);
  const isRegional = codePoints.every((cp) => cp >= 127462 && cp <= 127487);

  if (!isRegional || codePoints.length !== 2 || error) {
    return <span className="text-base leading-none shrink-0">{emoji}</span>;
  }

  const countryCode = codePoints.map((cp) => String.fromCharCode(cp - 127462 + 97)).join("");

  return (
    <img
      src={`https://flagcdn.com/w40/${countryCode}.png`}
      className="h-3 w-4.5 shrink-0 rounded-[2px] border border-border object-cover"
      alt={alt}
      onError={() => setError(true)}
    />
  );
}

export default function LanguageSelector() {
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const currentLang = LANGUAGES.find((l) => l.code === locale) || LANGUAGES[0];

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleSelect = (code: Locale) => {
    if (code === locale) {
      setOpen(false);
      return;
    }

    persistLocale(code);
    setOpen(false);
    router.refresh();
  };

  return (
    <div ref={ref} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        title={currentLang.name}
      >
        <CountryFlag emoji={currentLang.flag} alt={currentLang.name} />
        <span className="text-xs font-medium">{currentLang.label}</span>
        <span
          className={`material-symbols-outlined text-[16px] text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          expand_more
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute end-0 top-full z-50 mt-1 max-h-80 w-56 overflow-y-auto rounded-card border border-border bg-surface p-1 shadow-elevated">
          {LANGUAGES.map((lang) => (
            <button
              type="button"
              key={lang.code}
              onClick={() => handleSelect(lang.code)}
              className={`flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
                lang.code === locale
                  ? "bg-surface-2 font-medium text-text-main"
                  : "text-text-main hover:bg-surface-2"
              }`}
            >
              <CountryFlag emoji={lang.flag} alt={lang.name} />
              <span className="flex-1 text-start">{lang.name}</span>
              {lang.code === locale && (
                <span
                  className="material-symbols-outlined text-[16px] text-primary-text"
                  aria-hidden="true"
                >
                  check
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
