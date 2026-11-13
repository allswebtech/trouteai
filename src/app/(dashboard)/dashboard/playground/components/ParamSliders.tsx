"use client";

// src/app/(dashboard)/dashboard/playground/components/ParamSliders.tsx

import { useState } from "react";
import { useTranslations } from "next-intl";

export interface PlaygroundParams {
  temperature: number;
  max_tokens: number;
  top_p: number;
  presence_penalty: number;
  frequency_penalty: number;
  seed: number | null;
  stop: string;
  jsonMode: boolean;
  // Canonical reasoning params — surfaced by ReasoningControls only when the selected
  // model supports thinking. `effort: ""` means "not set" (left off the request body).
  effort: string;
  thinking: boolean;
}

export const DEFAULT_PARAMS: PlaygroundParams = {
  temperature: 1.0,
  max_tokens: 1024,
  top_p: 1.0,
  presence_penalty: 0,
  frequency_penalty: 0,
  seed: null,
  stop: "",
  jsonMode: false,
  effort: "",
  thinking: false,
};

interface ParamSlidersProps {
  params: PlaygroundParams;
  setParams: (params: PlaygroundParams) => void;
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function SliderRow({ label, value, min, max, step, onChange }: SliderRowProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-xs text-text-muted font-medium">{label}</label>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
          className="w-16 text-xs text-right tabular-nums text-text-main bg-surface border border-border rounded-control px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-primary h-1.5"
      />
    </div>
  );
}

/**
 * Sliders for temperature, max_tokens, top_p, penalties, seed, stop, JSON mode.
 * Props: { params, setParams }
 */
export default function ParamSliders({ params, setParams }: ParamSlidersProps) {
  const t = useTranslations("playground");
  const tc = useTranslations("common");
  // Pure UI disclosure: the rarely-changed params live behind "Advanced settings".
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedChanged = [
    params.top_p !== DEFAULT_PARAMS.top_p,
    params.presence_penalty !== DEFAULT_PARAMS.presence_penalty,
    params.frequency_penalty !== DEFAULT_PARAMS.frequency_penalty,
    params.seed !== DEFAULT_PARAMS.seed,
    params.stop !== DEFAULT_PARAMS.stop,
    params.jsonMode !== DEFAULT_PARAMS.jsonMode,
  ].filter(Boolean).length;
  function update<K extends keyof PlaygroundParams>(key: K, value: PlaygroundParams[K]) {
    setParams({ ...params, [key]: value });
  }

  return (
    <div className="space-y-3">
      <SliderRow
        label={t("temperature")}
        value={params.temperature}
        min={0}
        max={2}
        step={0.01}
        onChange={(v) => update("temperature", v)}
      />

      <SliderRow
        label={t("maxTokens")}
        value={params.max_tokens}
        min={1}
        max={32768}
        step={1}
        onChange={(v) => update("max_tokens", Math.round(v))}
      />

      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
        aria-controls={showAdvanced ? "playground-advanced-params" : undefined}
        className="flex w-full items-center justify-between gap-2 rounded-control px-1 py-1 text-xs font-medium text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{tc("advancedSettings")}</span>
          {advancedChanged > 0 && (
            <span className="inline-flex h-[18px] items-center rounded-full bg-primary/10 px-1.5 text-[10px] font-medium tabular-nums text-primary-text">
              {advancedChanged}
            </span>
          )}
        </span>
        <span
          className="material-symbols-outlined text-[16px] shrink-0 transition-transform duration-200"
          style={{ transform: showAdvanced ? "rotate(0deg)" : "rotate(-90deg)" }}
          aria-hidden="true"
        >
          expand_more
        </span>
      </button>

      {showAdvanced && (
        <div id="playground-advanced-params" className="space-y-3">
          <SliderRow
            label={t("topP")}
            value={params.top_p}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => update("top_p", v)}
          />

          <SliderRow
            label={t("presencePenalty")}
            value={params.presence_penalty}
            min={-2}
            max={2}
            step={0.01}
            onChange={(v) => update("presence_penalty", v)}
          />

          <SliderRow
            label={t("frequencyPenalty")}
            value={params.frequency_penalty}
            min={-2}
            max={2}
            step={0.01}
            onChange={(v) => update("frequency_penalty", v)}
          />

          {/* Seed input */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-muted font-medium">{t("seed")}</label>
            <input
              type="number"
              value={params.seed ?? ""}
              placeholder={t("seedPlaceholder")}
              onChange={(e) => {
                const raw = e.target.value;
                update("seed", raw === "" ? null : parseInt(raw, 10));
              }}
              className="w-full text-xs text-text-main bg-surface border border-border rounded-control px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Stop sequences */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-muted font-medium">{t("stopSequences")}</label>
            <input
              type="text"
              value={params.stop}
              placeholder={t("stopSequencesPlaceholder")}
              onChange={(e) => update("stop", e.target.value)}
              className="w-full text-xs text-text-main bg-surface border border-border rounded-control px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* JSON mode toggle */}
          <div className="flex items-center justify-between">
            <label className="text-xs text-text-muted font-medium">{t("jsonMode")}</label>
            <button
              type="button"
              role="switch"
              aria-checked={params.jsonMode}
              onClick={() => update("jsonMode", !params.jsonMode)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/30 ${
                params.jsonMode ? "bg-primary" : "bg-surface-2 border border-border"
              }`}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                  params.jsonMode ? "translate-x-4" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
