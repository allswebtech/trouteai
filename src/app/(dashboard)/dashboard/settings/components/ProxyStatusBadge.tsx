"use client";

interface ProxyStatusBadgeProps {
  status?: string;
}

export function ProxyStatusBadge({ status }: ProxyStatusBadgeProps) {
  const isInactive = status === "inactive";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border ${
        isInactive
          ? "border-error/30 bg-error/10 text-error"
          : "border-success/30 bg-success/10 text-success"
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isInactive ? "bg-error" : "bg-success"}`} />
      {isInactive ? "Inactive" : "Active"}
    </span>
  );
}
