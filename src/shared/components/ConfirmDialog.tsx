"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import Modal from "./Modal";
import Button, { type ButtonVariant } from "./Button";
import Input from "./Input";

export interface ConfirmOptions {
  title?: ReactNode;
  message: ReactNode;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  variant?: ButtonVariant;
}

export interface PromptOptions {
  title?: ReactNode;
  message: ReactNode;
  defaultValue?: string;
  confirmText?: ReactNode;
}

type DialogState =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

/**
 * Promise-based replacement for window.confirm / window.prompt.
 * Render `dialog` once in the component, then `await confirm({ message })`.
 * Cancel, Escape and a click outside resolve false (or null for prompt).
 */
export function useConfirmDialog() {
  const t = useTranslations("common");
  const [state, setState] = useState<DialogState | null>(null);
  const [value, setValue] = useState("");
  const stateRef = useRef<DialogState | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const finish = useCallback((result: boolean | string | null) => {
    const current = stateRef.current;
    if (!current) return;
    stateRef.current = null;
    setState(null);
    if (current.kind === "confirm") current.resolve(result === true);
    else current.resolve(typeof result === "string" ? result : null);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) setTimeout(() => target.focus(), 0);
  }, []);

  const open = useCallback((next: DialogState) => {
    if (stateRef.current) {
      const previous = stateRef.current;
      if (previous.kind === "confirm") previous.resolve(false);
      else previous.resolve(null);
    } else {
      returnFocusRef.current =
        typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    }
    stateRef.current = next;
    setState(next);
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => open({ kind: "confirm", options, resolve })),
    [open]
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.defaultValue ?? "");
        open({ kind: "prompt", options, resolve });
      }),
    [open]
  );

  // Capture Escape before any parent modal's own handler so only this dialog closes.
  const isOpen = state !== null;
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      finish(stateRef.current?.kind === "prompt" ? null : false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isOpen, finish]);

  // A pending promise must never be left hanging when the owner unmounts.
  useEffect(
    () => () => {
      const current = stateRef.current;
      if (!current) return;
      stateRef.current = null;
      if (current.kind === "confirm") current.resolve(false);
      else current.resolve(null);
    },
    []
  );

  let dialog: ReactNode = null;
  if (state?.kind === "confirm") {
    const { options } = state;
    dialog = (
      <Modal
        isOpen
        onClose={() => finish(false)}
        title={options.title ?? t("confirmTitle")}
        size="sm"
        showCloseButton={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(false)}>
              {options.cancelText ?? t("cancel")}
            </Button>
            <Button variant={options.variant ?? "danger"} onClick={() => finish(true)}>
              {options.confirmText ?? t("confirmAction")}
            </Button>
          </>
        }
      >
        <p className="whitespace-pre-line text-sm text-text-muted">{options.message}</p>
      </Modal>
    );
  } else if (state?.kind === "prompt") {
    const { options } = state;
    const submit = () => finish(value);
    dialog = (
      <Modal
        isOpen
        onClose={() => finish(null)}
        title={options.title ?? t("confirmTitle")}
        size="sm"
        showCloseButton={false}
        footer={
          <>
            <Button variant="ghost" onClick={() => finish(null)}>
              {t("cancel")}
            </Button>
            <Button variant="primary" onClick={submit}>
              {options.confirmText ?? t("save")}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            label={options.message}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </form>
      </Modal>
    );
  }

  return { confirm, prompt, dialog };
}

type Handlers = {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  prompt: (options: PromptOptions) => Promise<string | null>;
};

let activeHandlers: Handlers | null = null;

/** Drop-in for window.confirm: `if (!(await confirmDialog({ message }))) return;` */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return activeHandlers ? activeHandlers.confirm(options) : Promise.resolve(false);
}

/** Drop-in for window.prompt: resolves the entered text, or null when cancelled. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return activeHandlers ? activeHandlers.prompt(options) : Promise.resolve(null);
}

/** Mount once (DashboardLayout) so confirmDialog / promptDialog can open the modal. */
export function ConfirmDialogHost() {
  const { confirm, prompt, dialog } = useConfirmDialog();
  useEffect(() => {
    const handlers: Handlers = { confirm, prompt };
    activeHandlers = handlers;
    return () => {
      if (activeHandlers === handlers) activeHandlers = null;
    };
  }, [confirm, prompt]);
  return <>{dialog}</>;
}
