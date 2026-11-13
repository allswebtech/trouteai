"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDisplayBaseUrl } from "@/shared/hooks";
import { TierTour } from "./steps/TierTour";

const STEP_IDS = ["welcome", "tiers", "security", "provider", "test", "done"];
const STEP_ICONS = ["waving_hand", "layers", "lock", "dns", "play_circle", "check_circle"];

const COMMON_PROVIDERS = [
  { id: "openai", name: "OpenAI", color: "#10A37F" },
  { id: "anthropic", name: "Anthropic", color: "#D97757" },
  { id: "google", name: "Google AI", color: "#4285F4" },
  { id: "openrouter", name: "OpenRouter", color: "#6B21A8" },
  { id: "groq", name: "Groq", color: "#F55036" },
  { id: "mistral", name: "Mistral", color: "#FF7000" },
];

export default function OnboardingWizard() {
  const router = useRouter();
  const t = useTranslations("onboarding");
  const tc = useTranslations("common");
  const baseUrl = useDisplayBaseUrl();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const apiEndpoint = `${baseUrl}/api/v1`;

  // Security step state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const skipSecurity = false;
  const [capsLockOn, setCapsLockOn] = useState(false);

  // Provider step state
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [providerUrl, setProviderUrl] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerName, setProviderName] = useState("");

  // Test step state
  const [testStatus, setTestStatus] = useState("idle"); // idle, testing, success, error
  const [testMessage, setTestMessage] = useState("");

  // Check if setup is already complete
  useEffect(() => {
    const checkSetup = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const settings = await res.json();
          if (settings.setupComplete) {
            router.replace("/dashboard");
            return;
          }
        }
      } catch {
        // Continue with setup
      }
      setLoading(false);
    };
    checkSetup();
  }, [router]);

  const STEPS = STEP_IDS.map((id, i) => ({
    id,
    title: t(id === "done" ? "ready" : id),
    icon: STEP_ICONS[i],
  }));

  const currentStep = STEPS[step];
  const isLastStep = step === STEPS.length - 1;

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const [errorMessage, setErrorMessage] = useState("");

  const handleSetPassword = async () => {
    if (password !== confirmPassword) return;
    if (password.length < 8) {
      setErrorMessage("Password must be at least 8 characters");
      return;
    }
    setErrorMessage("");
    try {
      const res = await fetch("/api/settings/require-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin: true, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(data.error || t("failedSetPassword"));
        return;
      }
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!loginRes.ok) {
        const data = await loginRes.json().catch(() => ({}));
        setErrorMessage(data.error || t("connectionError"));
        return;
      }
      handleNext();
    } catch {
      setErrorMessage(t("connectionError"));
    }
  };

  const handleAddProvider = async () => {
    if (!selectedProvider || !providerKey) return;
    setErrorMessage("");
    try {
      const provider = COMMON_PROVIDERS.find((p) => p.id === selectedProvider);
      const defaultUrls = {
        openai: "https://api.openai.com",
        anthropic: "https://api.anthropic.com",
        google: "https://generativelanguage.googleapis.com",
        openrouter: "https://openrouter.ai/api",
        groq: "https://api.groq.com/openai",
        mistral: "https://api.mistral.ai",
      };
      const res = await fetch("/api/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          name: providerName || provider?.name || selectedProvider,
          url: providerUrl || defaultUrls[selectedProvider] || "",
          apiKey: providerKey,
          isActive: true,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage(data.error || t("failedAddProvider"));
        return;
      }
      handleNext();
    } catch {
      setErrorMessage(t("connectionError"));
    }
  };

  const handleTestProvider = async () => {
    setTestStatus("testing");
    setTestMessage(t("testingConnection"));
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      const conn = data.connections?.[0];
      if (!conn) {
        setTestStatus("error");
        setTestMessage(t("noProviderFound"));
        return;
      }
      const testRes = await fetch(`/api/providers/${conn.id}/test`, { method: "POST" });
      if (testRes.ok) {
        setTestStatus("success");
        setTestMessage(t("connectionSuccessful"));
      } else {
        const err = await testRes.json().catch(() => ({}));
        setTestStatus("error");
        setTestMessage(err.error || t("testFailed"));
      }
    } catch {
      setTestStatus("error");
      setTestMessage(t("couldNotTest"));
    }
  };

  const handleFinish = async () => {
    try {
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setupComplete: true }),
      });
    } catch {
      // Non-critical
    }
    router.push("/dashboard");
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-sm text-text-muted">{tc("loading")}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4 sm:p-6">
      <div className="w-full max-w-xl">
        {/* Progress Indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex items-center gap-2">
              <div
                className={`flex size-7 items-center justify-center rounded-full border text-xs font-medium tabular-nums transition-colors ${
                  i < step
                    ? "border-success/30 bg-success/10 text-success"
                    : i === step
                      ? "border-primary bg-primary text-on-primary"
                      : "border-border bg-surface text-text-muted"
                }`}
              >
                {i < step ? (
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    check
                  </span>
                ) : (
                  i + 1
                )}
              </div>
              {i < STEPS.length - 1 && (
                <div
                  className={`h-px w-6 transition-colors ${
                    i < step ? "bg-success/40" : "bg-border"
                  }`}
                />
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <div className="rounded-card border border-border bg-surface p-5 sm:p-6">
          {/* Step Header */}
          <div className="text-center mb-6">
            <span
              className={`material-symbols-outlined mb-3 inline-flex size-10 items-center justify-center rounded-lg text-[22px] ${
                currentStep.id === "done"
                  ? "bg-success/10 text-success"
                  : "bg-surface-2 text-primary-text"
              }`}
              aria-hidden="true"
            >
              {currentStep.icon}
            </span>
            <h2 className="text-xl font-semibold tracking-tight text-text-main">
              {currentStep.title}
            </h2>
            {currentStep.id === "tiers" && (
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-text-muted text-balance">
                {t("tier.subtitle")}
              </p>
            )}
          </div>

          {/* Step Content */}
          <div className="min-h-[200px]">
            {/* Welcome */}
            {currentStep.id === "welcome" && (
              <div className="text-center space-y-4">
                <p className="text-sm text-text-muted">{t("welcomeDesc")}</p>
                <div className="mt-6 grid grid-cols-3 gap-3 items-stretch">
                  {[
                    { icon: "swap_horiz", label: t("multiProvider") },
                    { icon: "monitoring", label: t("usageTracking") },
                    { icon: "shield", label: t("apiKeyMgmt") },
                  ].map((f) => (
                    <div
                      key={f.icon}
                      className="h-full rounded-control border border-border bg-surface-2 p-3 text-center"
                    >
                      <div className="flex h-full flex-col items-center justify-center">
                        <span
                          className="material-symbols-outlined mb-1 block text-[20px] text-primary-text"
                          aria-hidden="true"
                        >
                          {f.icon}
                        </span>
                        <span className="text-xs text-text-muted">{f.label}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tiers */}
            {currentStep.id === "tiers" && <TierTour />}

            {/* Security */}
            {currentStep.id === "security" && (
              <div className="space-y-4">
                <p className="text-sm text-text-muted text-center">{t("securityDesc")}</p>
                {!skipSecurity && (
                  <div className="space-y-3">
                    <input
                      type="password"
                      placeholder={t("enterPassword")}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      className="h-9 w-full rounded-control border border-border bg-surface px-3 text-sm text-text-main transition-colors placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      type="password"
                      placeholder={t("confirmPasswordPlaceholder")}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      onKeyDown={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      onKeyUp={(e) => setCapsLockOn(e.getModifierState("CapsLock"))}
                      className="h-9 w-full rounded-control border border-border bg-surface px-3 text-sm text-text-main transition-colors placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    {capsLockOn && (
                      <p className="flex items-center gap-1 text-xs text-warning">
                        <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                          keyboard_capslock
                        </span>
                        Caps Lock is on
                      </p>
                    )}
                    {password && confirmPassword && password !== confirmPassword && (
                      <p className="text-xs text-error">{t("passwordsMismatch")}</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Provider */}
            {currentStep.id === "provider" && (
              <div className="space-y-4">
                <p className="text-sm text-text-muted text-center">{t("providerDesc")}</p>
                <div className="grid grid-cols-3 gap-2">
                  {COMMON_PROVIDERS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setSelectedProvider(p.id);
                        setProviderName(p.name);
                      }}
                      className={`min-h-9 cursor-pointer rounded-control border px-2 py-2 text-center text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
                        selectedProvider === p.id
                          ? "border-primary bg-primary/10 text-primary-text"
                          : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
                      }`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                {selectedProvider && (
                  <div className="space-y-3 mt-4">
                    <input
                      type="password"
                      placeholder={t("apiKeyRequired")}
                      value={providerKey}
                      onChange={(e) => setProviderKey(e.target.value)}
                      className="h-9 w-full rounded-control border border-border bg-surface px-3 text-sm text-text-main transition-colors placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      type="text"
                      placeholder={t("customUrlOptional")}
                      value={providerUrl}
                      onChange={(e) => setProviderUrl(e.target.value)}
                      className="h-9 w-full rounded-control border border-border bg-surface px-3 text-sm text-text-main transition-colors placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                  </div>
                )}
              </div>
            )}

            {/* Test */}
            {currentStep.id === "test" && (
              <div className="text-center space-y-4">
                <p className="text-sm text-text-muted">{t("testDesc")}</p>
                {testStatus === "idle" && (
                  <button
                    onClick={handleTestProvider}
                    className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  >
                    {t("runTest")}
                  </button>
                )}
                {testStatus === "testing" && (
                  <div className="flex items-center justify-center gap-2 text-text-muted">
                    <span className="material-symbols-outlined animate-spin text-[20px]">
                      progress_activity
                    </span>
                    <span className="text-sm">{testMessage}</span>
                  </div>
                )}
                {testStatus === "success" && (
                  <div className="flex items-center justify-center gap-2 text-success">
                    <span className="material-symbols-outlined text-[20px]">check_circle</span>
                    <span className="text-sm">{testMessage}</span>
                  </div>
                )}
                {testStatus === "error" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-center gap-2 text-warning">
                      <span className="material-symbols-outlined text-[20px]">warning</span>
                      <span className="text-sm">{testMessage}</span>
                    </div>
                    <button
                      onClick={handleTestProvider}
                      className="cursor-pointer text-xs text-text-muted underline hover:text-text-main"
                    >
                      {t("retry")}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Done */}
            {currentStep.id === "done" && (
              <div className="text-center space-y-4">
                <p className="text-sm text-text-muted">{t("doneDesc")}</p>
                <div className="rounded-control border border-border bg-surface-2 p-3 text-start">
                  <p className="mb-1.5 text-xs font-medium text-text-muted">{t("yourEndpoint")}</p>
                  <code className="break-all font-mono text-sm text-primary-text">
                    {apiEndpoint}
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
            <div>
              {step > 0 && !isLastStep && (
                <button
                  onClick={handleBack}
                  className="inline-flex h-8 cursor-pointer items-center rounded-control px-3 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {tc("back")}
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!isLastStep && step > 0 && (
                <button
                  onClick={handleNext}
                  className="inline-flex h-8 cursor-pointer items-center rounded-control px-3 text-sm text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {t("skip")}
                </button>
              )}
              {currentStep.id === "welcome" && (
                <button
                  onClick={handleNext}
                  className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {t("getStarted")}
                </button>
              )}
              {currentStep.id === "tiers" && (
                <button
                  onClick={handleNext}
                  className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {t("continue")}
                </button>
              )}
              {currentStep.id === "security" && (
                <button
                  onClick={handleSetPassword}
                  disabled={!skipSecurity && (!password || password !== confirmPassword)}
                  className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {skipSecurity ? t("skipAndContinue") : t("setPassword")}
                </button>
              )}
              {currentStep.id === "provider" && (
                <button
                  onClick={handleAddProvider}
                  disabled={!selectedProvider || !providerKey}
                  className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t("addProvider")}
                </button>
              )}
              {currentStep.id === "test" && (
                <button
                  onClick={handleNext}
                  className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {testStatus === "success" ? t("continue") : t("skip")}
                </button>
              )}
              {isLastStep && (
                <button
                  onClick={handleFinish}
                  className="inline-flex h-8 cursor-pointer items-center justify-center rounded-control bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                >
                  {t("goToDashboard")}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Skip Wizard */}
        {!isLastStep && (
          <div className="text-center mt-4">
            <button
              onClick={handleFinish}
              className="cursor-pointer rounded-sm text-xs text-text-muted transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              {t("skipWizard")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
