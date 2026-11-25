/**
 * Whether `trouteai` asks the npm registry for a newer version at start. Off unless
 * TROUTEAI_UPDATE_CHECK is switched on, so by default nothing leaves the computer except the
 * calls to the providers the user set up. Never on a hosting panel (it deploys versions
 * itself) and never without a terminal (nobody would read the line).
 */
export function updateCheckEnabled(env = process.env, isTty = Boolean(process.stdout.isTTY)) {
  if (env.SIXPANEL_SLOT || !isTty) return false;
  return /^(1|true|yes|on)$/i.test(String(env.TROUTEAI_UPDATE_CHECK || "").trim());
}
