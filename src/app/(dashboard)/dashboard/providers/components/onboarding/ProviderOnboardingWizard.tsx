"use client";

import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import {
  Badge,
  Button,
  Card,
  CursorAuthModal,
  Input,
  KiroOAuthWrapper,
  OAuthModal,
} from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";

import { POPULAR_PROVIDER_DESCRIPTIONS } from "../../featuredProviders";
import {
  buildProviderSpecificData,
  filterWizardProviderOptions,
  getWizardApiKeyProviderOptions,
  getWizardOAuthProviderOptions,
  getWizardProviderFieldNeeds,
  splitPopularProviderOptions,
  type WizardProviderOption,
} from "./providerOnboardingCatalog";
import { buildProviderDetailsHref } from "./providerOnboardingHref";
import {
  createCompatibleProviderNode,
  createOnboardingConnection,
  fetchOnboardingConnections,
  fetchOnboardingProviderNodes,
  testOnboardingConnection,
  validateOnboardingApiKey,
  type CompatibleNodeMode,
  type OnboardingConnection,
  type OnboardingTestResult,
} from "./providerOnboardingApi";

type WizardKind = "apikey" | "custom" | "oauth";
type WizardStep = "type" | "provider" | "credentials" | "oauth" | "result";

type ApiKeyFormState = {
  name: string;
  apiKey: string;
  baseUrl: string;
  region: string;
  cx: string;
  customUserAgent: string;
};

type CustomFormState = {
  mode: CompatibleNodeMode;
  name: string;
  prefix: string;
  baseUrl: string;
  apiKey: string;
  chatPath: string;
  modelsPath: string;
};

const EMPTY_API_KEY_FORM: ApiKeyFormState = {
  name: "",
  apiKey: "",
  baseUrl: "",
  region: "",
  cx: "",
  customUserAgent: "",
};

const DEFAULT_CUSTOM_FORM: CustomFormState = {
  mode: "openai",
  name: "",
  prefix: "",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  chatPath: "",
  modelsPath: "",
};

type ProviderMessageTranslator = ((key: string, values?: Record<string, unknown>) => string) & {
  has?: (key: string) => boolean;
};

function providerText(
  t: ProviderMessageTranslator,
  key: string,
  fallback: string,
  values?: Record<string, unknown>
): string {
  if (typeof t.has === "function" && t.has(key)) {
    return t(key, values);
  }
  if (values) {
    return Object.entries(values).reduce(
      (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
      fallback
    );
  }
  return fallback;
}

function localizeProviderOptions(
  options: WizardProviderOption[],
  t: ProviderMessageTranslator
): WizardProviderOption[] {
  return options.map((option) => {
    // Popular providers get a short plain-language line instead of the technical hint.
    const popularDescription: { key: string; fallback: string } | undefined =
      POPULAR_PROVIDER_DESCRIPTIONS[option.id];
    return {
      ...option,
      description: popularDescription
        ? providerText(t, popularDescription.key, popularDescription.fallback)
        : providerText(t, `onboardingProviderDescriptions.${option.id}`, option.description, {
            provider: option.name,
          }),
    };
  });
}

function StepPill({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div
      aria-current={active ? "step" : undefined}
      className={`flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
        active
          ? "border-primary/50 bg-primary/10 text-primary"
          : done
            ? "border-success/30 bg-success/10 text-success"
            : "border-border bg-bg-subtle text-text-muted"
      }`}
    >
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
        {done ? "check" : active ? "radio_button_checked" : "radio_button_unchecked"}
      </span>
      {label}
    </div>
  );
}

function StepHeader({
  title,
  description,
  backLabel,
  onBack,
}: {
  title: string;
  description?: string;
  backLabel: string;
  onBack: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-xl font-semibold text-text-main">{title}</h2>
        {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
      </div>
      <Button variant="ghost" icon="arrow_back" onClick={onBack} className="shrink-0">
        {backLabel}
      </Button>
    </div>
  );
}

function AdvancedOptions({
  id,
  open,
  onToggle,
  label,
  note,
  children,
}: {
  id: string;
  open: boolean;
  onToggle: () => void;
  label: string;
  note: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={id}
          className="inline-flex items-center gap-1 rounded-control text-sm font-medium text-text-main transition-colors hover:text-primary"
        >
          <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
            {open ? "expand_less" : "expand_more"}
          </span>
          {label}
        </button>
        <span className="text-xs text-text-muted">{note}</span>
      </div>
      {open && (
        <div id={id} className="grid gap-4 md:grid-cols-2">
          {children}
        </div>
      )}
    </div>
  );
}

function getProviderIconClass(providerId: string): string {
  const classes = ["bg-surface-2 border border-border"];
  const index = [...providerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % classes.length;
  return classes[index];
}

function ProviderOptionCard({
  option,
  selected,
  onSelect,
  t,
}: {
  option: WizardProviderOption;
  selected: boolean;
  onSelect: () => void;
  t: ProviderMessageTranslator;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex h-full flex-col gap-3 rounded-card border p-4 text-left transition-colors ${
        selected
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-bg-card hover:border-primary/40 hover:bg-bg-subtle"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-10 shrink-0 items-center justify-center rounded-control text-text-main ${getProviderIconClass(
              option.id
            )}`}
          >
            <ProviderIcon
              providerId={option.id}
              size={24}
              type="color"
              fallbackText={option.name.slice(0, 2).toUpperCase()}
              fallbackColor="currentColor"
            />
          </div>
          <div className="font-semibold text-text-main">{option.name}</div>
        </div>
        {option.deprecated && (
          <Badge variant="warning">
            {providerText(t, "onboardingNotRecommended", "Not recommended")}
          </Badge>
        )}
      </div>
      <p className="line-clamp-3 text-sm text-text-muted">{option.description}</p>
      {option.apiKeyOptional && option.authKind === "apikey" && (
        <span className="text-xs font-medium text-success">
          {providerText(t, "onboardingApiKeyOptional", "API key optional")}
        </span>
      )}
    </button>
  );
}

function ProviderOptionGrid({
  options,
  selectedId,
  onSelect,
  t,
}: {
  options: WizardProviderOption[];
  selectedId: string | undefined;
  onSelect: (option: WizardProviderOption) => void;
  t: ProviderMessageTranslator;
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {options.map((option) => (
        <ProviderOptionCard
          key={option.id}
          option={option}
          selected={selectedId === option.id}
          onSelect={() => onSelect(option)}
          t={t}
        />
      ))}
    </div>
  );
}

function ProviderOptionGroup({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h3 id={id} className="text-xs font-semibold uppercase tracking-wide text-text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

function ResultSummary({
  connection,
  testResult,
  error,
  t,
}: {
  connection: OnboardingConnection | null;
  testResult: OnboardingTestResult | null;
  error: string | null;
  t: ProviderMessageTranslator;
}) {
  const valid = testResult?.valid === true;
  const failed = Boolean(error || testResult?.valid === false);
  const title = valid
    ? providerText(t, "onboardingProviderConnected", "Provider connected")
    : failed
      ? connection
        ? providerText(t, "onboardingSavedTestFailed", "Saved, but the test did not pass")
        : providerText(t, "onboardingCouldNotConnect", "Could not connect the provider")
      : providerText(t, "onboardingProviderAdded", "Provider added");

  return (
    <Card padding="lg">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex size-12 shrink-0 items-center justify-center rounded-full ${
              valid
                ? "bg-success/10 text-success"
                : failed
                  ? "bg-error/10 text-error"
                  : "bg-primary/10 text-primary"
            }`}
          >
            <span className="material-symbols-outlined text-[28px]" aria-hidden="true">
              {valid ? "check_circle" : failed ? "error" : "dns"}
            </span>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-text-main">{title}</h2>
            <p className="text-sm text-text-muted">
              {connection?.name ||
                connection?.provider ||
                providerText(t, "onboardingYourProviderConnection", "Your provider connection")}
            </p>
          </div>
        </div>

        {failed && (
          <p className="text-sm text-text-muted">
            {providerText(t, "onboardingResultFailedHelp", "Check your details and try again.")}
          </p>
        )}

        {testResult && (
          <div className="rounded-lg border border-border bg-bg-subtle p-3 text-sm text-text-muted">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={valid ? "success" : "error"}>
                {valid
                  ? providerText(t, "onboardingTestPassed", "Test passed")
                  : providerText(t, "onboardingTestFailed", "Test failed")}
              </Badge>
              {typeof testResult.latencyMs === "number" && <span>{testResult.latencyMs} ms</span>}
              {typeof testResult.statusCode === "number" && (
                <span>HTTP {testResult.statusCode}</span>
              )}
            </div>
            {(testResult.error || testResult.warning || testResult.diagnosis?.message) && (
              <p className="mt-2">
                {testResult.error || testResult.warning || testResult.diagnosis?.message}
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-error/30 bg-error/10 p-3 text-sm text-error">
            {error}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {(() => {
            const detailsHref = buildProviderDetailsHref(connection);
            return (
              detailsHref && (
                <Link
                  href={detailsHref}
                  className="inline-flex items-center justify-center rounded-control bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90"
                >
                  {providerText(t, "onboardingOpenProviderDetails", "Open provider details")}
                </Link>
              )
            );
          })()}
          <Link
            href="/dashboard/providers"
            className="inline-flex items-center justify-center rounded-lg border border-border bg-bg-subtle px-4 py-2 text-sm font-medium text-text-main transition-colors hover:bg-bg-card"
          >
            {providerText(t, "backToProviders", "Back to providers")}
          </Link>
          <Link
            href="/dashboard/playground"
            className="inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-bg-subtle hover:text-text-main"
          >
            {providerText(t, "onboardingTryInPlayground", "Try in playground")}
          </Link>
        </div>
      </div>
    </Card>
  );
}

export default function ProviderOnboardingWizard() {
  const router = useRouter();
  const t = useTranslations("providers");
  const text = (key: string, fallback: string, values?: Record<string, unknown>) =>
    providerText(t, key, fallback, values);
  const defaultConnectionName = (provider: string) =>
    text("onboardingDefaultConnectionName", "{provider} Primary", { provider });
  const apiKeyOptions = useMemo(
    () => localizeProviderOptions(getWizardApiKeyProviderOptions(), t),
    [t]
  );
  const oauthOptions = useMemo(
    () => localizeProviderOptions(getWizardOAuthProviderOptions(), t),
    [t]
  );
  const advancedOptionsId = useId();
  const [kind, setKind] = useState<WizardKind>("apikey");
  const [step, setStep] = useState<WizardStep>("type");
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<WizardProviderOption | null>(null);
  const [apiKeyForm, setApiKeyForm] = useState<ApiKeyFormState>(EMPTY_API_KEY_FORM);
  const [customForm, setCustomForm] = useState<CustomFormState>(DEFAULT_CUSTOM_FORM);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [createdConnection, setCreatedConnection] = useState<OnboardingConnection | null>(null);
  const [testResult, setTestResult] = useState<OnboardingTestResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const [knownOAuthConnectionIds, setKnownOAuthConnectionIds] = useState<Set<string>>(new Set());
  const [ccCompatibleProviderEnabled, setCcCompatibleProviderEnabled] = useState(false);

  const providerOptions = kind === "oauth" ? oauthOptions : apiKeyOptions;
  const filteredOptions = filterWizardProviderOptions(providerOptions, query);
  const { popular: popularOptions, others: otherOptions } =
    splitPopularProviderOptions(filteredOptions);
  // Group headings only for the full list; search results stay one flat list.
  const showProviderGroups = !query.trim() && popularOptions.length > 0 && otherOptions.length > 0;
  const currentStepIndex = ["type", "provider", "credentials", "oauth", "result"].indexOf(step);
  const fieldNeeds = getWizardProviderFieldNeeds(selectedProvider?.id);

  useEffect(() => {
    let cancelled = false;
    fetchOnboardingProviderNodes()
      .then((data) => {
        if (!cancelled) {
          setCcCompatibleProviderEnabled(data.ccCompatibleProviderEnabled);
          if (!data.ccCompatibleProviderEnabled) {
            setCustomForm((current) =>
              current.mode === "cc"
                ? { ...current, mode: "openai", baseUrl: "https://api.openai.com/v1" }
                : current
            );
          }
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCcCompatibleProviderEnabled(false);
          setCustomForm((current) =>
            current.mode === "cc"
              ? { ...current, mode: "openai", baseUrl: "https://api.openai.com/v1" }
              : current
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetProviderSelection = (nextKind: WizardKind) => {
    setKind(nextKind);
    setSelectedProvider(null);
    setQuery("");
    setError(null);
    setTestResult(null);
    setCreatedConnection(null);
    setApiKeyForm(EMPTY_API_KEY_FORM);
    setCustomForm(DEFAULT_CUSTOM_FORM);
    setShowAdvanced(false);
    setStep(nextKind === "custom" ? "credentials" : "provider");
  };

  const selectProvider = (option: WizardProviderOption) => {
    setSelectedProvider(option);
    setApiKeyForm({ ...EMPTY_API_KEY_FORM, name: defaultConnectionName(option.name) });
    setError(null);
    setShowAdvanced(false);
    setStep(option.authKind === "oauth" ? "oauth" : "credentials");
  };

  const runConnectionTest = async (connection: OnboardingConnection) => {
    setStatus(text("onboardingTestingConnection", "Testing provider connection…"));
    const result = await testOnboardingConnection(connection.id);
    setTestResult(result);
    setStatus("");
    return result;
  };

  const submitApiKeyProvider = async () => {
    if (!selectedProvider) return;
    setSubmitting(true);
    setError(null);
    setTestResult(null);
    try {
      const providerSpecificData = buildProviderSpecificData(apiKeyForm);
      if (apiKeyForm.apiKey.trim()) {
        setStatus(text("onboardingCheckingApiKey", "Checking your API key…"));
        await validateOnboardingApiKey({
          provider: selectedProvider.id,
          apiKey: apiKeyForm.apiKey.trim() || undefined,
          baseUrl: apiKeyForm.baseUrl.trim() || undefined,
          region: apiKeyForm.region.trim() || undefined,
          cx: apiKeyForm.cx.trim() || undefined,
          customUserAgent: apiKeyForm.customUserAgent.trim() || undefined,
        });
      }
      setStatus(text("onboardingSavingConnection", "Saving provider connection…"));
      const connection = await createOnboardingConnection({
        provider: selectedProvider.id,
        name: apiKeyForm.name.trim() || defaultConnectionName(selectedProvider.name),
        apiKey: apiKeyForm.apiKey.trim() || undefined,
        providerSpecificData,
        testStatus: "unknown",
      });
      setCreatedConnection(connection);
      await runConnectionTest(connection);
      setStep("result");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : text("onboardingSomethingWentWrong", "Something went wrong. Please try again.")
      );
      setStep("result");
    } finally {
      setSubmitting(false);
      setStatus("");
    }
  };

  const submitCustomProvider = async () => {
    setSubmitting(true);
    setError(null);
    setTestResult(null);
    try {
      setStatus(text("onboardingAddingServer", "Adding your server…"));
      const node = await createCompatibleProviderNode(customForm);
      setStatus(text("onboardingSavingConnection", "Saving provider connection…"));
      const providerName =
        node.name || text("onboardingCustomProviderFallbackName", "Custom provider");
      const connection = await createOnboardingConnection({
        provider: node.id,
        name: customForm.name.trim() || defaultConnectionName(providerName),
        apiKey: customForm.apiKey.trim() || undefined,
        testStatus: "unknown",
      });
      setCreatedConnection(connection);
      await runConnectionTest(connection);
      setStep("result");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : text("onboardingSomethingWentWrong", "Something went wrong. Please try again.")
      );
      setStep("result");
    } finally {
      setSubmitting(false);
      setStatus("");
    }
  };

  const openOAuth = async () => {
    if (!selectedProvider) return;
    setError(null);
    const connections = await fetchOnboardingConnections().catch(() => []);
    setKnownOAuthConnectionIds(new Set(connections.map((connection) => connection.id)));
    setShowOAuthModal(true);
  };

  const handleOAuthSuccess = async () => {
    if (!selectedProvider) return;
    setShowOAuthModal(false);
    setSubmitting(true);
    setError(null);
    try {
      setStatus(text("onboardingFinishingSignIn", "Finishing sign-in…"));
      const connections = await fetchOnboardingConnections();
      const matchingConnections = connections.filter(
        (connection) => connection.provider === selectedProvider.id
      );
      const connection =
        matchingConnections.find((candidate) => !knownOAuthConnectionIds.has(candidate.id)) ||
        matchingConnections[0] ||
        null;
      if (!connection) {
        throw new Error(
          text(
            "onboardingSignInNoConnection",
            "Sign-in finished, but the new connection was not found. Please try again."
          )
        );
      }
      setCreatedConnection(connection);
      await runConnectionTest(connection);
      setStep("result");
    } catch (oauthError) {
      setError(
        oauthError instanceof Error
          ? oauthError.message
          : text("onboardingSignInFailed", "Sign-in did not work. Please try again.")
      );
      setStep("result");
    } finally {
      setSubmitting(false);
      setStatus("");
    }
  };

  const customReady = Boolean(
    customForm.name.trim() && customForm.prefix.trim() && customForm.baseUrl.trim()
  );
  const apiKeyReady = Boolean(
    selectedProvider &&
    apiKeyForm.name.trim() &&
    (selectedProvider.apiKeyOptional || apiKeyForm.apiKey.trim())
  );
  // The connection name is required (see apiKeyReady). It lives under "Advanced options",
  // so keep that section open while the name is empty: a required field is never hidden.
  const apiKeyNameMissing = !apiKeyForm.name.trim();
  const apiKeyAdvancedOpen = showAdvanced || apiKeyNameMissing;
  const selectedProviderName = selectedProvider?.name ?? "";

  const advancedLabel = text("onboardingAdvancedOptions", "Advanced options");
  const advancedNote = text(
    "onboardingAdvancedOptionsNote",
    "Optional. Most people can skip this."
  );
  const onlyIfAskedHint = text(
    "onboardingOnlyIfAskedHint",
    "Only fill this in if your provider asks for it."
  );
  const apiKeyPlaceholder = text("onboardingApiKeyPlaceholder", "Paste your API key here");
  const connectNote = text(
    "onboardingConnectNote",
    "We check your details, save them and run a quick test."
  );

  const baseUrlField = (
    <Input
      label={text("onboardingServerAddressLabel", "Server address (URL)")}
      value={apiKeyForm.baseUrl}
      onChange={(event) => setApiKeyForm({ ...apiKeyForm, baseUrl: event.target.value })}
      placeholder="https://api.example.com/v1"
      hint={
        fieldNeeds.baseUrl
          ? text(
              "onboardingServerAddressHint",
              "The web address for your {provider} account or server. You can find it in your {provider} settings.",
              { provider: selectedProviderName }
            )
          : text("onboardingServerAddressOptionalHint", "Leave empty to use the standard address.")
      }
    />
  );
  const regionField = (
    <Input
      label={text("onboardingRegion", "Region")}
      value={apiKeyForm.region}
      onChange={(event) => setApiKeyForm({ ...apiKeyForm, region: event.target.value })}
      placeholder="us-east-1"
      hint={fieldNeeds.region ? undefined : onlyIfAskedHint}
    />
  );
  const searchEngineIdField = (
    <Input
      label={text("onboardingSearchEngineIdLabel", "Search engine ID")}
      value={apiKeyForm.cx}
      onChange={(event) => setApiKeyForm({ ...apiKeyForm, cx: event.target.value })}
      placeholder={text("optional", "Optional")}
      hint={fieldNeeds.cx ? undefined : onlyIfAskedHint}
    />
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <Link
            href="/dashboard/providers"
            className="text-sm text-text-muted hover:text-text-main"
          >
            ← {text("backToProviders", "Back to providers")}
          </Link>
          <h1 className="mt-2 text-xl font-semibold tracking-tight text-text-main">
            {text("onboardingAddProviderTitle", "Add a provider")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-text-muted">
            {text(
              "onboardingIntroSimple",
              "Connect an AI provider such as OpenAI or Google Gemini in a few simple steps. We test the connection for you at the end."
            )}
          </p>
        </div>
        <Button variant="ghost" onClick={() => router.push("/dashboard/providers")}>
          {text("close", "Close")}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <StepPill
          label={text("onboardingStepHowToConnect", "How to connect")}
          active={step === "type"}
          done={currentStepIndex > 0}
        />
        <StepPill
          label={text("onboardingStepProvider", "Provider")}
          active={step === "provider"}
          done={currentStepIndex > 1}
        />
        <StepPill
          label={text("onboardingStepConnect", "Connect")}
          active={step === "credentials" || step === "oauth"}
          done={currentStepIndex > 3}
        />
        <StepPill
          label={text("onboardingStepFinish", "Finish")}
          active={step === "result"}
          done={false}
        />
      </div>

      {status && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-lg border border-primary/25 bg-primary/10 p-3 text-sm text-primary"
        >
          {status}
        </div>
      )}

      {step === "type" && (
        <Card padding="lg">
          <div className="flex flex-col gap-4">
            <h2 className="text-xl font-semibold text-text-main">
              {text("onboardingTypeQuestion", "How do you want to connect?")}
            </h2>
            <div className="grid gap-4 md:grid-cols-3">
              {[
                {
                  id: "apikey" as const,
                  icon: "key",
                  recommended: true,
                  title: text("onboardingTypeApiKeyTitleSimple", "Use an API key"),
                  text: text(
                    "onboardingTypeApiKeyTextSimple",
                    "Paste a key from OpenAI, Anthropic, Google Gemini, Groq or many others. This works for most people."
                  ),
                },
                {
                  id: "oauth" as const,
                  icon: "account_circle",
                  recommended: false,
                  title: text("onboardingTypeSignInTitle", "Sign in with your account"),
                  text: text(
                    "onboardingTypeSignInText",
                    "Log in with an account you already have, such as Claude Code, OpenAI Codex, GitHub Copilot or Cursor."
                  ),
                },
                {
                  id: "custom" as const,
                  icon: "dns",
                  recommended: false,
                  title: text("onboardingTypeCustomTitleSimple", "Custom server (advanced)"),
                  text: text(
                    "onboardingTypeCustomTextSimple",
                    "For any other service that works like OpenAI or Anthropic. You need its server address (URL)."
                  ),
                },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => resetProviderSelection(item.id)}
                  className="flex flex-col rounded-card border border-border bg-bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-bg-subtle"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className="material-symbols-outlined text-[32px] text-primary"
                      aria-hidden="true"
                    >
                      {item.icon}
                    </span>
                    {item.recommended && (
                      <Badge variant="primary">
                        {text("onboardingRecommended", "Recommended")}
                      </Badge>
                    )}
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-text-main">{item.title}</h3>
                  <p className="mt-2 text-sm text-text-muted">{item.text}</p>
                </button>
              ))}
            </div>
          </div>
        </Card>
      )}

      {step === "provider" && (
        <Card padding="lg">
          <div className="flex flex-col gap-4">
            <StepHeader
              title={
                kind === "oauth"
                  ? text("onboardingChooseSignInProvider", "Choose the account to sign in with")
                  : text("onboardingChooseProviderSimple", "Choose your provider")
              }
              description={text(
                "onboardingChooseProviderHelp",
                "Pick the one you want to use. You can add more later."
              )}
              backLabel={text("onboardingBack", "Back")}
              onBack={() => setStep("type")}
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={text("onboardingSearchProviders", "Search providers…")}
              aria-label={text("onboardingSearchProviders", "Search providers…")}
              icon="search"
            />
            {filteredOptions.length === 0 ? (
              <p className="rounded-lg border border-border bg-bg-subtle p-4 text-sm text-text-muted">
                {text(
                  "onboardingNoProvidersFound",
                  "No provider matches “{query}”. Try a different name.",
                  { query: query.trim() }
                )}
              </p>
            ) : showProviderGroups ? (
              <div className="flex flex-col gap-6">
                <ProviderOptionGroup
                  id="onboarding-popular-providers"
                  title={text("onboardingPopularHeading", "Popular")}
                >
                  <ProviderOptionGrid
                    options={popularOptions}
                    selectedId={selectedProvider?.id}
                    onSelect={selectProvider}
                    t={t}
                  />
                </ProviderOptionGroup>
                <ProviderOptionGroup
                  id="onboarding-all-providers"
                  title={text("onboardingAllProvidersHeading", "All providers")}
                >
                  <ProviderOptionGrid
                    options={otherOptions}
                    selectedId={selectedProvider?.id}
                    onSelect={selectProvider}
                    t={t}
                  />
                </ProviderOptionGroup>
              </div>
            ) : (
              <ProviderOptionGrid
                options={filteredOptions}
                selectedId={selectedProvider?.id}
                onSelect={selectProvider}
                t={t}
              />
            )}
          </div>
        </Card>
      )}

      {step === "credentials" && kind === "apikey" && selectedProvider && (
        <Card padding="lg">
          <div className="flex flex-col gap-5">
            <StepHeader
              title={text("onboardingAddProvider", "Add {provider}", {
                provider: selectedProvider.name,
              })}
              description={selectedProvider.description}
              backLabel={text("onboardingBack", "Back")}
              onBack={() => setStep("provider")}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <div className="flex flex-col gap-2 md:col-span-2">
                <Input
                  label={
                    selectedProvider.apiKeyOptional
                      ? text("onboardingApiKeyOptionalLabel", "API key (optional)")
                      : text("apiKeyLabel", "API key")
                  }
                  type="password"
                  required={!selectedProvider.apiKeyOptional}
                  value={apiKeyForm.apiKey}
                  onChange={(event) => setApiKeyForm({ ...apiKeyForm, apiKey: event.target.value })}
                  placeholder={apiKeyPlaceholder}
                  hint={
                    selectedProvider.apiKeyOptional
                      ? text(
                          "onboardingApiKeyOptionalHelp",
                          "You can leave this empty if {provider} does not give you a key.",
                          { provider: selectedProvider.name }
                        )
                      : text(
                          "onboardingApiKeyHelp",
                          "Copy the key from your {provider} account and paste it here.",
                          { provider: selectedProvider.name }
                        )
                  }
                />
                {!selectedProvider.apiKeyOptional && selectedProvider.apiKeyHelpUrl && (
                  <p className="text-sm text-text-muted">
                    {text("onboardingNoApiKeyYet", "Don't have an API key yet?")}{" "}
                    <a
                      href={selectedProvider.apiKeyHelpUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                    >
                      {text("onboardingGetApiKeyFrom", "Get one from {provider}", {
                        provider: selectedProvider.name,
                      })}
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                        open_in_new
                      </span>
                    </a>
                  </p>
                )}
              </div>
              {fieldNeeds.baseUrl && baseUrlField}
              {fieldNeeds.region && regionField}
              {fieldNeeds.cx && searchEngineIdField}
            </div>
            <AdvancedOptions
              id={advancedOptionsId}
              open={apiKeyAdvancedOpen}
              onToggle={() => setShowAdvanced(apiKeyNameMissing ? true : !showAdvanced)}
              label={advancedLabel}
              note={advancedNote}
            >
              <Input
                label={text("onboardingNameLabel", "Name")}
                required
                value={apiKeyForm.name}
                onChange={(event) => setApiKeyForm({ ...apiKeyForm, name: event.target.value })}
                placeholder={defaultConnectionName(selectedProvider.name)}
                error={
                  apiKeyNameMissing
                    ? text("onboardingNameRequired", "Please enter a name.")
                    : undefined
                }
                hint={text(
                  "onboardingNameHint",
                  "Helps you find it later. You can keep the suggested name."
                )}
              />
              {!fieldNeeds.baseUrl && baseUrlField}
              {!fieldNeeds.region && regionField}
              {!fieldNeeds.cx && searchEngineIdField}
              <Input
                label={text("onboardingCustomUserAgent", "Custom User-Agent")}
                value={apiKeyForm.customUserAgent}
                onChange={(event) =>
                  setApiKeyForm({ ...apiKeyForm, customUserAgent: event.target.value })
                }
                placeholder={text("optional", "Optional")}
                hint={text(
                  "onboardingUserAgentHint",
                  "The app name sent with each request. Most people leave this empty."
                )}
              />
            </AdvancedOptions>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <Button
                size="lg"
                icon="link"
                loading={submitting}
                onClick={submitApiKeyProvider}
                disabled={!apiKeyReady || submitting}
              >
                {submitting
                  ? text("onboardingConnecting", "Connecting…")
                  : text("connect", "Connect")}
              </Button>
              <p className="text-xs text-text-muted">{connectNote}</p>
            </div>
          </div>
        </Card>
      )}

      {step === "credentials" && kind === "custom" && (
        <Card padding="lg">
          <div className="flex flex-col gap-5">
            <StepHeader
              title={text("onboardingCustomServerTitle", "Connect a custom server")}
              description={text(
                "onboardingCustomServerDescription",
                "Use this for a service that works like the OpenAI or Anthropic API. Fill in the details, then we test the connection."
              )}
              backLabel={text("onboardingBack", "Back")}
              onBack={() => setStep("type")}
            />
            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm font-medium text-text-main">
                {text("onboardingServerTypeLabel", "Server type")}
                <select
                  className="rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-main outline-none focus:border-primary"
                  value={customForm.mode}
                  onChange={(event) =>
                    setCustomForm({
                      ...customForm,
                      mode: event.target.value as CompatibleNodeMode,
                      baseUrl:
                        event.target.value === "openai"
                          ? "https://api.openai.com/v1"
                          : event.target.value === "anthropic"
                            ? "https://api.anthropic.com/v1"
                            : "",
                      chatPath: event.target.value === "cc" ? "/v1/messages?beta=true" : "",
                    })
                  }
                >
                  <option value="openai">
                    {text("onboardingWorksLikeOpenAi", "Works like OpenAI (most common)")}
                  </option>
                  <option value="anthropic">
                    {text("onboardingWorksLikeAnthropic", "Works like Anthropic (Claude)")}
                  </option>
                  {ccCompatibleProviderEnabled && (
                    <option value="cc">
                      {text("onboardingWorksLikeClaudeCode", "Works like Claude Code")}
                    </option>
                  )}
                </select>
              </label>
              <Input
                label={text("onboardingNameLabel", "Name")}
                required
                value={customForm.name}
                onChange={(event) => setCustomForm({ ...customForm, name: event.target.value })}
                placeholder={text("onboardingCustomNamePlaceholder", "My AI server")}
                hint={text("onboardingCustomNameHint", "Shown in your list of providers.")}
              />
              <Input
                label={text("onboardingShortIdLabel", "Short ID")}
                required
                value={customForm.prefix}
                onChange={(event) => setCustomForm({ ...customForm, prefix: event.target.value })}
                placeholder="my-server"
                hint={text(
                  "onboardingShortIdHint",
                  "A short, unique nickname without spaces, like my-server. It goes in front of model names."
                )}
              />
              <Input
                label={text("onboardingServerAddressLabel", "Server address (URL)")}
                required
                value={customForm.baseUrl}
                onChange={(event) => setCustomForm({ ...customForm, baseUrl: event.target.value })}
                placeholder="https://api.example.com/v1"
                hint={text(
                  "onboardingCustomServerAddressHint",
                  "Where the server accepts requests. It often ends with /v1."
                )}
              />
              <Input
                label={text("onboardingApiKeyOptionalLabel", "API key (optional)")}
                type="password"
                value={customForm.apiKey}
                onChange={(event) => setCustomForm({ ...customForm, apiKey: event.target.value })}
                placeholder={apiKeyPlaceholder}
                hint={text(
                  "onboardingCustomApiKeyHint",
                  "Leave empty if your server does not need a key."
                )}
                className="md:col-span-2"
              />
            </div>
            <AdvancedOptions
              id={advancedOptionsId}
              open={showAdvanced}
              onToggle={() => setShowAdvanced(!showAdvanced)}
              label={advancedLabel}
              note={advancedNote}
            >
              <Input
                label={text("onboardingChatPath", "Chat path")}
                value={customForm.chatPath}
                onChange={(event) => setCustomForm({ ...customForm, chatPath: event.target.value })}
                placeholder={
                  customForm.mode === "cc" ? "/v1/messages?beta=true" : text("optional", "Optional")
                }
                hint={text("onboardingPathDefaultHint", "Leave empty to use the standard path.")}
              />
              {customForm.mode !== "cc" && (
                <Input
                  label={text("onboardingModelsPath", "Models path")}
                  value={customForm.modelsPath}
                  onChange={(event) =>
                    setCustomForm({ ...customForm, modelsPath: event.target.value })
                  }
                  placeholder={text("optional", "Optional")}
                  hint={text("onboardingPathDefaultHint", "Leave empty to use the standard path.")}
                />
              )}
            </AdvancedOptions>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <Button
                size="lg"
                icon="link"
                loading={submitting}
                onClick={submitCustomProvider}
                disabled={!customReady || submitting}
              >
                {submitting
                  ? text("onboardingConnecting", "Connecting…")
                  : text("connect", "Connect")}
              </Button>
              <p className="text-xs text-text-muted">{connectNote}</p>
            </div>
          </div>
        </Card>
      )}

      {step === "oauth" && selectedProvider && (
        <Card padding="lg">
          <div className="flex flex-col gap-5">
            <StepHeader
              title={text("onboardingConnectProvider", "Connect {provider}", {
                provider: selectedProvider.name,
              })}
              description={selectedProvider.description}
              backLabel={text("onboardingBack", "Back")}
              onBack={() => setStep("provider")}
            />
            <ol className="list-decimal space-y-2 rounded-lg border border-border bg-bg-subtle p-4 pl-8 text-sm text-text-main">
              <li>{text("onboardingSignInStep1", "Click the button below.")}</li>
              <li>
                {text("onboardingSignInStep2", "A sign-in window opens. Log in and allow access.")}
              </li>
              <li>
                {text("onboardingSignInStep3", "Come back here. We check the connection for you.")}
              </li>
            </ol>
            <div>
              <Button size="lg" icon="login" onClick={openOAuth} disabled={submitting}>
                {text("onboardingSignInWith", "Sign in with {provider}", {
                  provider: selectedProvider.name,
                })}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === "result" && (
        <ResultSummary connection={createdConnection} testResult={testResult} error={error} t={t} />
      )}

      {selectedProvider &&
        (selectedProvider.id === "kiro" || selectedProvider.id === "amazon-q" ? (
          <KiroOAuthWrapper
            isOpen={showOAuthModal}
            providerInfo={{ id: selectedProvider.id, name: selectedProvider.name }}
            onSuccess={handleOAuthSuccess}
            onClose={() => setShowOAuthModal(false)}
          />
        ) : selectedProvider.id === "cursor" ? (
          <CursorAuthModal
            isOpen={showOAuthModal}
            onSuccess={handleOAuthSuccess}
            onClose={() => setShowOAuthModal(false)}
          />
        ) : (
          <OAuthModal
            isOpen={showOAuthModal}
            provider={selectedProvider.id}
            providerInfo={selectedProvider}
            onSuccess={handleOAuthSuccess}
            onClose={() => setShowOAuthModal(false)}
          />
        ))}
    </div>
  );
}
