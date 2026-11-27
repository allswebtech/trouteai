// Appearance-flag resolution for the home dashboard.
//
// The provider map (the connection graph) is off by default: it is a large box that a
// person who only wants to connect a tool does not need. The Appearance switch turns it on.

/**
 * Whether the home provider-topology card should render.
 * Off unless switched on: only an explicit `true` shows it (Appearance has the switch).
 */
export function shouldShowProviderTopologyOnHome(setting: unknown): boolean {
  return setting === true;
}
