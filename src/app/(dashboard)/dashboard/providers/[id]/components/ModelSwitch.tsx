"use client";

type ModelSwitchProps = {
  isOn: boolean;
  onToggle: () => void;
  disabled?: boolean;
  label: string;
  title: string;
};

export default function ModelSwitch({ isOn, onToggle, disabled, label, title }: ModelSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={isOn}
      aria-label={label}
      title={title}
      onClick={onToggle}
      disabled={disabled}
      data-model-switch
      className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        isOn ? "border border-primary bg-primary" : "border border-border bg-surface-2"
      }`}
    >
      <span
        className={`inline-block h-3 w-3 rounded-full bg-white shadow-soft transition-transform ${
          isOn ? "translate-x-3" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
