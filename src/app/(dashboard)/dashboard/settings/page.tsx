import { redirect } from "next/navigation";
import SettingsListClient from "./SettingsListClient";

const LEGACY_TAB_ROUTES: Record<string, string> = {
  advanced: "/dashboard/settings/advanced",
  ai: "/dashboard/settings/ai",
  appearance: "/dashboard/settings/appearance",
  featureFlags: "/dashboard/settings/feature-flags",
  "feature-flags": "/dashboard/settings/feature-flags",
  cache: "/dashboard/settings/cache",
  general: "/dashboard/settings/general",
  resilience: "/dashboard/settings/resilience",
  routing: "/dashboard/settings/routing",
  security: "/dashboard/settings/security",
  sidebar: "/dashboard/settings/sidebar",
};

type SettingsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = searchParams ? await searchParams : {};
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  // Without ?tab the page is the list of settings; any ?tab= goes to its page as before.
  if (tab) redirect(LEGACY_TAB_ROUTES[tab] || "/dashboard/settings/general");
  return <SettingsListClient />;
}
