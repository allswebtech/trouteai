"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

// ── Strategy color map ────────────────────────────────────────────────────

// One accent color for every strategy (the strategy name is shown as text).
const STRATEGY_COLORS: Record<string, string> = {};

function getStrategyColor(strategy: string): string {
  return STRATEGY_COLORS[strategy] ?? "var(--color-primary-text)";
}

// ── Node data shape ───────────────────────────────────────────────────────

export interface StrategyNodeData {
  label: string;
  strategy: string;
  targetCount: number;
  [key: string]: unknown;
}

// ── Component ─────────────────────────────────────────────────────────────

/**
 * StrategyNode — pill that shows the combo routing strategy + target count.
 * Custom ReactFlow node with Left/Right Handles (left = source from request,
 * right = target into first provider cascade).
 */
export function StrategyNode({ data }: NodeProps) {
  const { strategy, targetCount } = data as StrategyNodeData;
  const color = getStrategyColor(strategy as string);
  const label = (strategy as string) || "combo";
  const count = targetCount as number;

  return (
    <div
      className="flex flex-col items-center gap-1 px-3 py-2 rounded-full border bg-surface transition-all duration-300"
      style={{
        borderColor: color,
        minWidth: "110px",
      }}
      data-testid="strategy-node"
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-transparent !border-0 !w-0 !h-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <span
        className="text-xs font-semibold truncate"
        style={{ color }}
        data-testid="strategy-label"
      >
        {label}
      </span>
      {count > 0 && (
        <span
          className="text-[10px] font-mono px-1.5 rounded-full"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
          data-testid="strategy-target-count"
        >
          {count} target{count !== 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}

export default StrategyNode;
