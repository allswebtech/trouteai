import { Card } from "@/shared/components";

export function MetricCard({
  label,
  value,
  subValue,
  color = "text-text-main",
  loading = false,
}: {
  label: string;
  value: string;
  subValue?: string;
  color?: string;
  loading?: boolean;
}) {
  return (
    <Card padding="sm">
      <p className="text-xs font-medium text-text-muted truncate" title={label}>
        {label}
      </p>
      <p className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${color}`}>
        {loading ? "…" : value}
      </p>
      {subValue ? <p className="text-xs text-text-muted mt-1">{subValue}</p> : null}
    </Card>
  );
}
