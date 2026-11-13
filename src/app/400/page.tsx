import ErrorPageScaffold from "@/shared/components/ErrorPageScaffold";

export default function BadRequestPage() {
  return (
    <ErrorPageScaffold
      code="400"
      icon="rule"
      title="Bad Request"
      description="The request payload is invalid or incomplete."
      suggestions={[
        "Review required fields and payload format before retrying.",
        "If you are using the API, validate the JSON schema locally.",
        "Check the request logs in the dashboard for the exact validation error.",
      ]}
      primaryAction={{ href: "/dashboard", label: "Open Dashboard" }}
      secondaryAction={{ href: "/dashboard/logs", label: "Open Logs" }}
    />
  );
}
