import ErrorPageScaffold from "@/shared/components/ErrorPageScaffold";

export default function BadGatewayPage() {
  return (
    <ErrorPageScaffold
      code="502"
      icon="hub"
      title="Bad Gateway"
      description="Upstream provider or gateway integration returned an invalid response."
      suggestions={[
        "Retry with another provider or active combo route.",
        "Check provider credentials and model availability.",
        "Inspect the request logs for the upstream error details.",
      ]}
      primaryAction={{ href: "/dashboard/providers", label: "Open Providers" }}
      secondaryAction={{ href: "/dashboard/logs", label: "Open Logs" }}
    />
  );
}
