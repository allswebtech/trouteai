"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

// ── Node data shape ───────────────────────────────────────────────────────

export interface RequestNodeData {
  label: string;
  comboName: string;
  [key: string]: unknown;
}

// ── Component ─────────────────────────────────────────────────────────────

/**
 * RequestNode — entry node in the combo cascade flow graph.
 * Shows "Request" label + the combo name. Source handle on the Right.
 */
export function RequestNode({ data }: NodeProps) {
  const { comboName } = data as RequestNodeData;
  const color = "var(--color-primary-text)";

  return (
    <div
      className="rounded-card border bg-surface px-4 py-3 min-w-[110px] text-center transition-all duration-200"
      style={{
        borderColor: color,
      }}
      data-testid="request-node"
    >
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-transparent !border-0 !w-0 !h-0"
      />

      <div className="text-xs font-semibold mb-1" style={{ color }}>
        Request
      </div>
      <div
        className="text-[11px] font-mono text-text-muted truncate max-w-[130px]"
        title={comboName as string}
      >
        {comboName as string}
      </div>
    </div>
  );
}

export default RequestNode;
