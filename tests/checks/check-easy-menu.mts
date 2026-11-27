// The easy menu: the simple menu has 6 pages and no group heading, Show all menus has 10 (6 plus the
// Status group), every other page is off the menu but still answers at its old address, belongs to a
// page of the menu, and every word the menu and the pages of the easy design use is in en.json.
// In-process, no server.
//
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-easy-menu.mts
import fs from "node:fs";
import path from "node:path";

const { SIDEBAR_SECTIONS, ALL_PAGE_SECTIONS, getSectionItems, getSidebarPresetHiddenItems } =
  await import("../../src/shared/constants/sidebarVisibility.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

type Item = ReturnType<typeof getSectionItems>[number];
const shown = (hidden: string[], debug: boolean) =>
  SIDEBAR_SECTIONS.flatMap((section) => getSectionItems(section)).filter(
    (item: Item) => !hidden.includes(item.id) && (debug || !item.debugOnly)
  );

const simple = shown(getSidebarPresetHiddenItems("minimal"), true);
check(
  "simple menu has 6 pages",
  simple.length === 6,
  simple.map((item: Item) => item.id).join(",")
);
check(
  "simple menu order",
  simple.map((item: Item) => item.id).join() === "home,providers,combos,api-manager,analytics,settings"
);
const simpleSections = SIDEBAR_SECTIONS.filter((section) =>
  getSectionItems(section).some((item: Item) => simple.includes(item))
);
check(
  "simple menu has no group heading",
  simpleSections.length === 1 &&
    simpleSections[0].showTitle === false &&
    simpleSections[0].children.every((child) => !("type" in child && child.type === "group"))
);

const all = shown(getSidebarPresetHiddenItems("all"), true);
check("Show all menus has 10 pages", all.length === 10, all.map((item: Item) => item.id).join(","));
check(
  "Show all menus adds the Status group",
  all
    .slice(6)
    .map((item: Item) => item.id)
    .join() === "activity,health,runtime,playground"
);
check("Playground only while debug is on", shown([], false).length === 9);

// Every old address still has its page file.
const OLD_ADDRESSES = [
  "/home",
  "/dashboard/endpoint",
  "/dashboard/api-manager",
  "/dashboard/providers",
  "/dashboard/combos",
  "/dashboard/combos/live",
  "/dashboard/quota",
  "/dashboard/costs/quota-share",
  "/dashboard/system/proxy",
  "/dashboard/analytics",
  "/dashboard/analytics/combo-health",
  "/dashboard/analytics/utilization",
  "/dashboard/cache",
  "/dashboard/provider-stats",
  "/dashboard/activity",
  "/dashboard/logs",
  "/dashboard/logs/proxy",
  "/dashboard/logs/console",
  "/dashboard/logs/timeline",
  "/dashboard/health",
  "/dashboard/runtime",
  "/dashboard/costs",
  "/dashboard/costs/pricing",
  "/dashboard/costs/budget",
  "/dashboard/audit",
  "/dashboard/playground",
  "/dashboard/settings",
  "/dashboard/settings/general",
  "/dashboard/settings/appearance",
  "/dashboard/settings/ai",
  "/dashboard/settings/routing",
  "/dashboard/settings/resilience",
  "/dashboard/settings/advanced",
  "/dashboard/settings/security",
  "/dashboard/settings/feature-flags",
  "/dashboard/settings/cache",
  "/dashboard/settings/sidebar",
  "/dashboard/system",
];
const appDir = path.resolve("src/app/(dashboard)");
const missing = OLD_ADDRESSES.filter(
  (address) => !fs.existsSync(path.join(appDir, address.replace(/^\//, ""), "page.tsx"))
);
check("every old address has its page", missing.length === 0, missing.join(" "));

const pages = ALL_PAGE_SECTIONS.flatMap(getSectionItems) as Item[];
const menuIds = new Set(SIDEBAR_SECTIONS.flatMap(getSectionItems).map((item: Item) => item.id));
const unknown = pages.filter((item) => !OLD_ADDRESSES.includes(item.href)).map((item) => item.href);
check("every page of the lists is an old address", unknown.length === 0, unknown.join(" "));
const orphans = pages
  .filter((item) => !menuIds.has(item.id))
  .filter((item) => !item.parent || !pages.some((page) => page.id === item.parent))
  .map((item) => item.id);
check("every page off the menu belongs to a page", orphans.length === 0, orphans.join(" "));
check(
  "no page is listed twice",
  new Set(pages.map((item) => item.id)).size === pages.length
);

// Words.
const en = JSON.parse(fs.readFileSync("src/i18n/messages/en.json", "utf8"));
const WORDS: Record<string, string> = {
  accounts: "Accounts",
  keys: "Keys",
  usage: "Usage",
  settings: "Settings",
  status: "Status",
  addYourFirstAccount: "Add your first AI account",
  addAccount: "Add account",
  connectCodingTool: "Connect a coding tool",
  address: "Address",
  key: "Key",
  model: "Model",
  makeKey: "Make a key",
  useKeyFromKeys: "Use a key from Keys",
  stepsForEachApp: "Steps for each app",
  tryInTerminal: "Try it in a terminal",
  codingTool: "Coding tool",
  works: "Works",
  needsAttention: "Needs attention",
  turnedOff: "Turned off",
  noAccountYet: "No account yet.",
  allProviders: "All providers",
  limits: "Limits",
  imagesSpeechSearch: "Images, speech and search",
  models: "Models",
  options: "Options",
  test: "Test",
  edit: "Edit",
  turnOff: "Turn off",
  turnOn: "Turn on",
  remove: "Remove",
  newCombo: "New combo",
  more: "More",
  liveView: "Live view",
  tryRoute: "Try a route",
  readyMadeCombos: "Ready-made combos",
  filter: "Filter",
  overview: "Overview",
  requests: "Requests",
  costs: "Costs",
  moreCharts: "More charts",
  comboHealth: "Combo health",
  limitsUsed: "Limits used",
  cache: "Cache",
  routeTrace: "Route trace",
  speedByAccount: "Speed by account",
  serverLog: "Server log",
  proxyLog: "Proxy log",
  timeline: "Timeline",
  prices: "Prices",
  budget: "Budget",
  quotaSharing: "Quota sharing",
  auditLog: "Audit log",
  passwordAndAccess: "Password and access",
  appearance: "Appearance",
  yourData: "Your data",
  advanced: "Advanced",
  ai: "AI",
  routing: "Routing",
  whenProviderFails: "When a provider fails",
  expert: "Expert",
  featureFlags: "Feature flags",
  menu: "Menu",
  proxy: "Proxy",
  showProviderMap: "Show provider map on Home",
};
const wrong = Object.entries(WORDS)
  .filter(([key, value]) => en.easy?.[key] !== value)
  .map(([key]) => key);
check("every word of the easy design is in en.json", wrong.length === 0, wrong.join(" "));
check(
  "counted words",
  typeof en.easy?.accountsNeedAttention === "string" &&
    typeof en.easy?.accountsCount === "string" &&
    en.easy.accountsNeedAttention.includes("{n, plural,") &&
    en.easy.accountsCount.includes("{n, plural,")
);
check(
  "menu labels use the new names",
  en.sidebar.providers === "Accounts" &&
    en.sidebar.apiManager === "Keys" &&
    en.sidebar.usage === "Usage" &&
    en.sidebar.settings === "Settings" &&
    en.sidebar.status === "Status"
);

process.exit(failed ? 1 : 0);
