/**
 * Structured guidance for Google-loopback providers (antigravity / agy) reached from a
 * non-true-localhost origin.
 *
 * Unlike the codex family, these providers have no fixed foreign port — OAuthModal
 * builds `http://127.0.0.1:<dashboardPort>/callback`. On a LAN origin that 127.0.0.1 is
 * the *browser's* machine, and Google's `firstparty/nativeapp` consent only releases the
 * authorization code once that loopback is reachable from the approving browser. When it
 * is not, the consent screen **never redirects at all** — it simply hangs.
 *
 * That is what made the previous copy actively misleading: it told the operator to wait
 * for the redirect and paste the callback URL, but no redirect arrives and there is
 * nothing to paste. Hence the two real remedies surfaced here:
 *
 * 1. the local login helper, which runs the OAuth on the operator's own machine (where
 *    127.0.0.1 works) and prints a credential blob the Step 2 field accepts;
 * 2. an SSH forward of the dashboard port, after which the callback reaches the server.
 */

import {
  buildSshLocalForward,
  resolveDashboardPort,
  type LoopbackLocation,
} from "./loopbackTunnel";

export type GoogleLoopbackHint = {
  provider: string;
  /** The loopback callback OAuthModal will ask Google to redirect to. */
  redirectUri: string;
  /** The LAN host the operator typed — pre-filled into the tunnel command. */
  dashboardHost: string;
  /** Dashboard port, with the protocol-default case resolved. */
  dashboardPort: string;
  /** Ready-to-copy SSH local-forward; only `<user>` is left for the operator. */
  tunnelCommand: string;
  /** Where to browse once the tunnel is up. */
  localDashboardUrl: string;
  /** Local login-helper command. Always null: this build ships no local login CLI. */
  helperCommand: string | null;
};

export function buildGoogleLoopbackHint(
  provider: string,
  location: LoopbackLocation
): GoogleLoopbackHint {
  const dashboardPort = resolveDashboardPort(location);

  return {
    provider,
    redirectUri: `http://127.0.0.1:${dashboardPort}/callback`,
    dashboardHost: location.hostname,
    dashboardPort,
    // One forward only: the callback rides the dashboard port itself.
    tunnelCommand: buildSshLocalForward([dashboardPort], location.hostname),
    localDashboardUrl: `http://localhost:${dashboardPort}`,
    helperCommand: null,
  };
}
