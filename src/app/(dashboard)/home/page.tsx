import path from "path";
import { redirect } from "next/navigation";
import { getMachineId } from "@/shared/utils/machine";
import { getSettings } from "@/lib/localDb";
import { resolveDataDir } from "@/lib/dataPaths";
import HomePageClient from "../dashboard/HomePageClient";
import BootstrapBanner from "../dashboard/BootstrapBanner";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const settings = await getSettings();
  if (!settings.setupComplete) {
    redirect("/dashboard/onboarding");
  }
  const machineId = await getMachineId();
  const isBootstrapped = process.env.TROUTEAI_BOOTSTRAPPED === "true";
  // The auto-generated secrets live in <DATA_DIR>/server.env on the server (see
  // scripts/build/bootstrap-env.mjs), so show that real path instead of a guess.
  const envFilePath = isBootstrapped ? path.join(resolveDataDir(), "server.env") : undefined;
  return (
    <>
      {isBootstrapped && <BootstrapBanner envFilePath={envFilePath} />}
      <HomePageClient machineId={machineId} />
    </>
  );
}
