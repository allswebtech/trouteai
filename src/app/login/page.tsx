"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/shared/components";
import BrandCredit from "@/shared/components/BrandCredit";
import { APP_CONFIG } from "@/shared/constants/appConfig";

const FEATURES = [
  { icon: "dns", title: "featureProvidersTitle", desc: "featureProvidersDesc" },
  { icon: "layers", title: "featureCombosTitle", desc: "featureCombosDesc" },
  { icon: "vpn_key", title: "featureKeysTitle", desc: "featureKeysDesc" },
] as const;

function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary"
      style={{ width: size, height: size }}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: Math.round(size * 0.6) }}
        aria-hidden="true"
      >
        alt_route
      </span>
    </div>
  );
}

export default function LoginPage() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [nodeCompatible, setNodeCompatible] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    (async () => {
      try {
        const res = await fetch("/api/settings/require-login", { signal: controller.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (data.nodeCompatible === false) setNodeCompatible(false);
        if (data.requireLogin === false) {
          router.push("/dashboard");
          router.refresh();
          return;
        }
        setHasPassword(!!data.hasPassword);
        setOidcEnabled(!!data.oidcEnabled);
      } catch {
        // Fail closed: show the normal sign-in form.
        setHasPassword(true);
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    return () => {
      clearTimeout(timeoutId);
      controller.abort();
    };
  }, [router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        sessionStorage.setItem("trouteai_login_time", String(Date.now()));
        router.push("/dashboard");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data.needsSetup) {
        setHasPassword(false);
        return;
      }
      setError(typeof data.error === "string" ? data.error : t("invalidPassword"));
    } catch {
      setError(t("errorOccurredRetry"));
    } finally {
      setLoading(false);
    }
  };

  const nodeWarning = !nodeCompatible ? (
    <div className="mb-4 flex items-start gap-2.5 rounded-card border border-error/30 bg-error/10 p-3 text-sm">
      <span className="material-symbols-outlined text-[18px] text-error" aria-hidden="true">
        error
      </span>
      <div className="min-w-0">
        <p className="font-medium text-error">{t("nodeIncompatibleTitle")}</p>
        <p className="mt-0.5 break-words text-text-muted">
          <code className="font-mono">nvm install 26 && nvm use 26</code>
        </p>
      </div>
    </div>
  ) : null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg px-4 py-10">
      <main className="w-full max-w-[360px]">
        {/* Brand mark */}
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark size={36} />
          <span className="text-base font-semibold tracking-tight text-text-main">
            {APP_CONFIG.name}
          </span>
        </div>

        {nodeWarning}

        {hasPassword === null ? (
          <div className="flex items-center justify-center gap-2.5 rounded-card border border-border bg-surface p-5 text-sm text-text-muted">
            <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            {t("loading")}
          </div>
        ) : hasPassword === false ? (
          <div className="rounded-card border border-border bg-surface p-5">
            <div className="mb-3 flex size-9 items-center justify-center rounded-md bg-warning/10 text-warning">
              <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
                shield_person
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-text-main">
              {t("noPasswordTitle")}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{t("noPasswordDesc")}</p>
            <code className="mt-4 block break-all rounded-control border border-border bg-surface-2 px-3 py-2 font-mono text-xs text-text-main">
              INITIAL_PASSWORD=your-strong-password
            </code>
          </div>
        ) : (
          <div className="rounded-card border border-border bg-surface p-5">
            <h1 className="text-xl font-semibold tracking-tight text-text-main">
              {t("welcomeBack")}
            </h1>
            <p className="mt-1 text-sm text-text-muted">{t("signInSubtitle")}</p>

            <form onSubmit={handleLogin} className="mt-5 space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="password" className="text-xs font-medium text-text-muted">
                  {t("password")}
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    placeholder={t("enterPassword")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                    className="h-9 w-full rounded-control border border-border bg-surface px-3 pe-10 text-sm text-text-main outline-none transition-colors placeholder:text-text-muted focus:border-primary focus:ring-2 focus:ring-primary/20"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t("hidePassword") : t("showPassword")}
                    className="absolute inset-y-0 end-0 flex w-9 items-center justify-center rounded-e-control text-text-muted transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  >
                    <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                      {showPassword ? "visibility_off" : "visibility"}
                    </span>
                  </button>
                </div>
                {error && (
                  <p role="alert" className="flex items-start gap-1.5 pt-0.5 text-xs text-error">
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                      error
                    </span>
                    <span className="min-w-0 break-words">{error}</span>
                  </p>
                )}
              </div>

              <Button type="submit" variant="primary" className="h-9 w-full" loading={loading}>
                {t("continue")}
              </Button>
            </form>

            {oidcEnabled && (
              <Button
                type="button"
                variant="secondary"
                className="mt-2 h-9 w-full"
                onClick={() => (window.location.href = "/api/auth/oidc/login")}
              >
                {t("continueWithOidc") || "Continue with OIDC"}
              </Button>
            )}

            <div className="mt-5 border-t border-border pt-4 text-center">
              <a
                href="/forgot-password"
                className="rounded-sm text-xs text-text-muted transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                {t("forgotPassword")}
              </a>
            </div>
          </div>
        )}

        {/* Product summary (quiet, below the card) */}
        <section className="mt-8 px-1">
          <h2 className="text-sm font-semibold text-text-main">{t("brandHeadline")}</h2>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{t("brandSubline")}</p>
          <ul className="mt-4 space-y-3">
            {FEATURES.map((feature) => (
              <li key={feature.icon} className="flex items-start gap-2.5">
                <span
                  className="material-symbols-outlined mt-px text-[18px] text-primary-text"
                  aria-hidden="true"
                >
                  {feature.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium text-text-main">{t(feature.title)}</p>
                  <p className="text-xs text-text-muted">{t(feature.desc)}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-5 flex items-center gap-1.5 text-[11px] text-text-muted">
            <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
              lock
            </span>
            {t("selfHostedNote")}
          </p>
        </section>

        <BrandCredit className="mt-6 text-center" />
      </main>
    </div>
  );
}
