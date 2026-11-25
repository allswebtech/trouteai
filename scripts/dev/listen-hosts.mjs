import os from "node:os";

/**
 * Which addresses the server listens on, from the HOST setting.
 *
 * - empty or "localhost": only this computer, on both loopback addresses (127.0.0.1 and ::1),
 *   because a client may resolve "localhost" to either one.
 * - "0.0.0.0" or "::": every interface (this computer and the network).
 * - anything else: exactly that address.
 *
 * Some shells (csh/tcsh) export HOST as the machine name; that is not a listen address, so it
 * counts as empty.
 */
export function resolveListenHosts(rawHost, machineName = safeHostname()) {
  let host = String(rawHost ?? "").trim();
  if (host && machineName && host === machineName && host.toLowerCase() !== "localhost") host = "";
  if (!host || host.toLowerCase() === "localhost") {
    return {
      hosts: ["127.0.0.1", "::1"],
      primary: "127.0.0.1",
      loopbackOnly: true,
      everyInterface: false,
    };
  }
  const everyInterface = host === "0.0.0.0" || host === "::";
  const loopbackOnly = host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  return { hosts: [host], primary: host, loopbackOnly, everyInterface };
}

/** The address to show a person: loopback and wildcard addresses read as "localhost". */
export function displayHost(host) {
  if (["0.0.0.0", "::", "127.0.0.1", "::1", "localhost"].includes(host)) return "localhost";
  return host.includes(":") ? `[${host}]` : host;
}

/** The one line that says how to open the dashboard to the network. */
export const NETWORK_HINT =
  "Only this computer can connect. To allow your network: HOST=0.0.0.0 (or trouteai --host 0.0.0.0), then restart.";

function safeHostname() {
  try {
    return os.hostname();
  } catch {
    return "";
  }
}
