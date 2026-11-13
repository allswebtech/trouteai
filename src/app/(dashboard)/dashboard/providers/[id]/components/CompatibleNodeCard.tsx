"use client";

import { confirmDialog } from "@/shared/components/ConfirmDialog";
import { useRouter } from "next/navigation";
import { Card, Button } from "@/shared/components";
import ProviderIcon from "@/shared/components/ProviderIcon";
import { getApiLabel, getApiPath } from "../providerPageHelpers";
import type { ProviderMessageTranslator } from "../providerPageHelpers";

interface ProviderNode {
  baseUrl?: string;
  apiType?: string;
  chatPath?: string;
  prefix?: string;
  /** Optional operator-supplied remote icon URL. */
  iconUrl?: string;
  [key: string]: unknown;
}

interface CompatibleNodeCardProps {
  providerId: string;
  providerNode: ProviderNode;
  isCcCompatible: boolean;
  isAnthropicCompatible: boolean;
  isAnthropicProtocolCompatible: boolean;
  gateConnectionFlow: (callback: () => void) => void;
  openApiKeyAddFlow: () => void;
  onOpenEditNodeModal: () => void;
  t: ProviderMessageTranslator;
  notify: { error: (msg: string) => void };
}

export default function CompatibleNodeCard({
  providerId,
  providerNode,
  isCcCompatible,
  isAnthropicCompatible,
  isAnthropicProtocolCompatible,
  gateConnectionFlow,
  openApiKeyAddFlow,
  onOpenEditNodeModal,
  t,
  notify,
}: CompatibleNodeCardProps) {
  const router = useRouter();

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {providerNode.iconUrl && (
            <ProviderIcon
              providerId={providerId}
              src={providerNode.iconUrl}
              size={32}
              className="shrink-0 rounded-lg"
              fallbackText={isCcCompatible ? "CC" : isAnthropicCompatible ? "AC" : "OC"}
            />
          )}
          <div>
            <h2 className="text-lg font-semibold">
              {isCcCompatible
                ? t("ccCompatibleDetailsTitle")
                : isAnthropicCompatible
                  ? t("anthropicCompatibleDetails")
                  : t("openaiCompatibleDetails")}
            </h2>
            <p className="text-sm text-text-muted">
              {getApiLabel(t, isAnthropicProtocolCompatible, providerNode?.apiType)} ·{" "}
              {(providerNode.baseUrl || "").replace(/\/$/, "")}/
              {getApiPath(
                isCcCompatible,
                isAnthropicCompatible,
                providerNode?.apiType,
                providerNode?.chatPath
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon="add" onClick={() => gateConnectionFlow(openApiKeyAddFlow)}>
            {t("add")}
          </Button>
          <Button size="sm" variant="secondary" icon="edit" onClick={onOpenEditNodeModal}>
            {t("edit")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="delete"
            onClick={async () => {
              if (
                !(await confirmDialog({
                  message: t("deleteCompatibleNodeConfirm", {
                    type: isCcCompatible
                      ? t("ccCompatibleLabel")
                      : isAnthropicCompatible
                        ? t("anthropic")
                        : t("openai"),
                  }),
                }))
              )
                return;
              try {
                const res = await fetch(`/api/provider-nodes/${providerId}`, {
                  method: "DELETE",
                });
                if (res.ok) {
                  router.push("/dashboard/providers");
                  return;
                }
                const data = await res.json().catch(() => ({}));
                const err = data?.error;
                notify.error(
                  (typeof err === "string" ? err : err?.message) || t("deleteCompatibleNodeFailed")
                );
              } catch (error) {
                console.error("Error deleting provider node:", error);
                notify.error(t("deleteCompatibleNodeFailed"));
              }
            }}
          >
            {t("delete")}
          </Button>
        </div>
      </div>
      {isCcCompatible && (
        <div className="mb-4 rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-text-muted">
          <div className="flex items-start gap-2">
            <span className="material-symbols-outlined mt-0.5 text-[18px] text-warning">
              warning
            </span>
            <p>{t("ccCompatibleValidationHint")}</p>
          </div>
        </div>
      )}
    </Card>
  );
}
