"use client";

import { useState } from "react";

import { Button, Card } from "@/shared/components";
import { cn } from "@/shared/utils/cn";
import { LinkButton } from "./LinkButton";
import { useHomeTr } from "./useHomeTr";

type GetStartedStep = {
  id: string;
  done: boolean;
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  icon: string;
};

/**
 * "Get started" checklist on Home. Each step's status comes from live data (provider
 * connections, combos, API keys). Collapses to a one-line success message once every
 * step is done.
 */
export function GetStartedCard({
  providerCount,
  comboCount,
  keyCount,
}: {
  providerCount: number;
  comboCount: number;
  keyCount: number;
}) {
  const { tr } = useHomeTr();
  const [showSteps, setShowSteps] = useState(false);

  const steps: GetStartedStep[] = [
    {
      id: "provider",
      done: providerCount > 0,
      title: tr("getStartedProviderTitle", "Connect an AI provider"),
      description: tr(
        "getStartedProviderDesc",
        "Add the AI service you want to use, such as OpenAI, Claude or Gemini."
      ),
      actionLabel: tr("addProvider", "Add a provider"),
      href: "/dashboard/providers/new",
      icon: "add",
    },
    {
      id: "combo",
      done: comboCount > 0,
      title: tr("getStartedComboTitle", "Create a combo (recommended)"),
      description: tr(
        "getStartedComboDesc",
        "One model name that tries several models in order, so your apps keep working if one fails."
      ),
      actionLabel: tr("getStartedComboAction", "Create a combo"),
      href: "/dashboard/combos",
      icon: "layers",
    },
    {
      id: "key",
      done: keyCount > 0,
      title: tr("getStartedKeyTitle", "Create an API key"),
      description: tr(
        "getStartedKeyDesc",
        "Your apps use this key like a password to connect to TRouteAI."
      ),
      actionLabel: tr("getStartedKeyAction", "Create an API key"),
      href: "/dashboard/api-manager",
      icon: "key",
    },
  ];

  const total = steps.length;
  const doneCount = steps.filter((step) => step.done).length;
  const allDone = doneCount === total;
  const currentIndex = steps.findIndex((step) => !step.done);
  const progressText = tr("getStartedProgress", `${doneCount} of ${total} done`, {
    done: doneCount,
    total,
  });

  if (allDone && !showSteps) {
    return (
      <div className="flex items-center gap-3 rounded-card border border-border bg-surface px-4 py-3">
        <span
          className="material-symbols-outlined text-[20px] text-success shrink-0"
          aria-hidden="true"
        >
          check_circle
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-main">
            {tr("getStartedAllSet", "You're all set")}
          </p>
          <p className="text-xs text-text-muted">
            {tr(
              "getStartedAllSetDesc",
              "Your apps can now use TRouteAI. The connection details are below."
            )}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowSteps(true)}>
          {tr("getStartedShowSteps", "Show steps")}
        </Button>
      </div>
    );
  }

  return (
    <Card>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text-main">
              {tr("getStartedTitle", "Get started")}
            </h2>
            <p className="mt-0.5 text-sm text-text-muted">
              {tr("getStartedDesc", "Finish these steps to start using AI in your apps.")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-muted tabular-nums">{progressText}</span>
            {allDone && (
              <Button variant="ghost" size="sm" onClick={() => setShowSteps(false)}>
                {tr("getStartedHideSteps", "Hide steps")}
              </Button>
            )}
          </div>
        </div>

        <div
          className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          aria-label={progressText}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={doneCount}
        >
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${(doneCount / total) * 100}%` }}
          />
        </div>

        <ol className="flex flex-col gap-2">
          {steps.map((step, index) => (
            <GetStartedStepRow
              key={step.id}
              step={step}
              number={index + 1}
              isCurrent={index === currentIndex}
              doneLabel={tr("getStartedStepDone", "Done")}
              todoLabel={tr("getStartedStepTodo", "To do")}
            />
          ))}
        </ol>
      </div>
    </Card>
  );
}

function GetStartedStepRow({
  step,
  number,
  isCurrent,
  doneLabel,
  todoLabel,
}: {
  step: GetStartedStep;
  number: number;
  isCurrent: boolean;
  doneLabel: string;
  todoLabel: string;
}) {
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-card border p-4 sm:flex-row sm:items-center",
        isCurrent ? "border-primary/40 bg-primary/5" : "border-border bg-transparent"
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        {step.done ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              check_circle
            </span>
          </span>
        ) : (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full border text-sm font-semibold tabular-nums",
              isCurrent
                ? "border-primary/40 bg-primary/10 text-primary-text"
                : "border-border bg-surface text-text-muted"
            )}
            aria-hidden="true"
          >
            {number}
          </span>
        )}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-main">{step.title}</h3>
            <span
              className={cn(
                "inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium",
                step.done ? "bg-success/10 text-success" : "bg-surface-2 text-text-muted"
              )}
            >
              {step.done ? doneLabel : todoLabel}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-text-muted">{step.description}</p>
        </div>
      </div>
      <LinkButton
        href={step.href}
        variant={isCurrent ? "primary" : "secondary"}
        icon={step.icon}
        className="w-full shrink-0 sm:w-auto"
      >
        {step.actionLabel}
      </LinkButton>
    </li>
  );
}
