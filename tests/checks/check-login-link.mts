// The one-time sign-in link store (src/lib/auth/loginLink.ts): a code works once, for 60 seconds,
// a wrong, empty, used or late code does not, the store keeps only a hash and stays small.
// Run from the repository root:
//   DATA_DIR=$(mktemp -d) npx tsx --tsconfig tsconfig.json tests/checks/check-login-link.mts
const { mintLoginLink, consumeLoginLink, LOGIN_LINK_TTL_SECONDS, pendingLoginLinks } =
  await import("../../src/lib/auth/loginLink.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const t0 = 1_000_000;
check("the time to live is 60 seconds", LOGIN_LINK_TTL_SECONDS === 60);
const a = mintLoginLink(t0);
check("a code is 43 url-safe characters", /^[A-Za-z0-9_-]{43}$/.test(a), a.length + "");
check("the same code is not made twice", mintLoginLink(t0) !== a);
check("a wrong code is refused", !consumeLoginLink("x".repeat(43), t0 + 1));
check(
  "an empty code is refused",
  !consumeLoginLink("", t0 + 1) && !consumeLoginLink(undefined, t0)
);
check("the code works once", consumeLoginLink(a, t0 + 1_000));
check("the second use is refused", !consumeLoginLink(a, t0 + 2_000));
const b = mintLoginLink(t0);
check("59 seconds is still in time", consumeLoginLink(b, t0 + 59_000));
const c = mintLoginLink(t0);
check("61 seconds is late", !consumeLoginLink(c, t0 + 61_000));
const d = mintLoginLink(t0);
check(
  "a late use burns the code",
  !consumeLoginLink(d, t0 + 61_000) && !consumeLoginLink(d, t0 + 1)
);
const many = Array.from({ length: 200 }, () => mintLoginLink(t0));
check("the store stays small", pendingLoginLinks() <= 20, String(pendingLoginLinks()));
check("the newest code still works", consumeLoginLink(many[199], t0 + 10));
mintLoginLink(t0 + 120_000);
check(
  "a later mint drops the expired ones",
  pendingLoginLinks() === 1,
  String(pendingLoginLinks())
);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
