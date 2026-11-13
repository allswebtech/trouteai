import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { resolveProviderServiceKinds } from "@trouteai/open-sse/config/mediaServiceKinds.ts";
import type { MediaKind } from "../components/mediaKinds";
import { MEDIA_KINDS } from "../components/mediaKinds";
import MediaProviderKindNav from "../components/MediaProviderKindNav";
import ProviderIcon from "@/shared/components/ProviderIcon";
import Badge from "@/shared/components/Badge";
import EmptyState from "@/shared/components/EmptyState";

interface PageProps {
  params: Promise<{ kind: string }>;
}

/**
 * /dashboard/media-providers/[kind]
 *
 * Lists all AI providers that declare the given serviceKind.
 * Returns 404 for unknown kinds.
 */
export default async function MediaProviderKindPage({ params }: PageProps) {
  const { kind } = await params;

  // Validate kind
  if (!MEDIA_KINDS.includes(kind as MediaKind)) {
    notFound();
  }

  const validKind = kind as MediaKind;
  const t = await getTranslations("media");

  // Filter providers that support this kind. Membership is the union of the
  // explicitly declared serviceKinds and the media kinds derived from the
  // backend registries (audio/video/music/image/embedding) — see
  // resolveProviderServiceKinds. This keeps the UI in lockstep with the backend
  // without hand-maintaining serviceKinds on every media provider.
  const matchingProviders = Object.values(AI_PROVIDERS).filter((p) => {
    const entry = p as Record<string, unknown> & { id: string; serviceKinds?: string[] };
    return resolveProviderServiceKinds(entry.id, entry.serviceKinds).includes(validKind);
  });

  const kindLabel = t(`kinds.${validKind}`);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-text-main">{kindLabel}</h1>
      </div>

      <MediaProviderKindNav activeKind={validKind} />

      {matchingProviders.length === 0 ? (
        <div className="rounded-card border border-border bg-surface">
          <EmptyState icon="category" title={t("noProviders")} />
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
          {matchingProviders.map((provider) => {
            const p = provider as Record<string, unknown> & {
              id: string;
              name: string;
              color?: string;
              hasFree?: boolean;
              freeNote?: string;
            };
            return (
              <Link
                key={p.id}
                href={`/dashboard/media-providers/${validKind}/${p.id}`}
                className="group rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                <div className="rounded-card border border-border bg-surface p-3 hover:bg-surface-2/40 hover:border-text-muted/30 transition-colors cursor-pointer h-full flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div className="size-7 rounded-control border border-border bg-surface-2 flex items-center justify-center shrink-0">
                      <ProviderIcon providerId={p.id} size={20} type="color" />
                    </div>
                    <span className="text-sm font-medium text-text-main truncate" title={p.name}>
                      {p.name}
                    </span>
                  </div>
                  {p.hasFree && (
                    <Badge variant="success" size="sm" className="w-fit">
                      Free
                    </Badge>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
