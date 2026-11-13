"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/shared/utils/cn";
import type { ServiceKind } from "@/shared/constants/providers";

const KIND_ICON: Record<ServiceKind, string> = {
  llm: "chat",
  embedding: "data_object",
  image: "image",
  imageToText: "image_search",
  tts: "record_voice_over",
  stt: "mic",
  webSearch: "search",
  webFetch: "language",
  video: "videocam",
  music: "music_note",
  ocr: "document_scanner",
};

interface ServiceKindTabsProps {
  kinds: ServiceKind[];
  activeKind: ServiceKind;
  onSelect: (kind: ServiceKind) => void;
  className?: string;
}

/**
 * Horizontal tab-strip for switching between provider service kinds
 * (embedding, image, tts, etc.).  Renders as compact pill-style chips,
 * consistent with the MediaProviderKindNav style.
 */
export function ServiceKindTabs({ kinds, activeKind, onSelect, className }: ServiceKindTabsProps) {
  const t = useTranslations("media");

  if (kinds.length <= 1) return null;

  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {kinds.map((kind) => {
        const isActive = kind === activeKind;
        const label = t(`kinds.${kind}`);
        const icon = KIND_ICON[kind] ?? "category";
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onSelect(kind)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30",
              isActive
                ? "bg-primary/10 text-primary-text border-primary/30"
                : "bg-surface border-border text-text-muted hover:text-text-main hover:bg-surface-2"
            )}
          >
            <span className="material-symbols-outlined text-[13px] leading-none">{icon}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
