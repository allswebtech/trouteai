/**
 * useLiveDashboard — React hooks for real-time dashboard WebSocket
 *
 * Provides hooks for connecting to the live dashboard WebSocket server
 * and subscribing to event channels.
 *
 * Usage:
 *   const { requests, isConnected } = useLiveRequests();
 *   const { comboEvents, lastComboEvent } = useLiveComboStatus();
 */

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { DashboardChannel, DashboardEventName } from "@/lib/events/types";
import { deriveLiveWsPath } from "@/shared/utils/wsPath";

// ── Config ────────────────────────────────────────────────────────────────

const WS_RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

/** Only accept ws:// or wss:// URLs (mirrors the guard in src/app/api/v1/ws/route.ts). */
function sanitizeWsPublicUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  return url.startsWith("ws://") || url.startsWith("wss://") ? url : null;
}

// Build-time inlined value (Docker/npm prebuilt images won't have this — the
// runtime value is discovered via the /api/v1/ws?handshake=1 handshake below).
const BUILD_TIME_PUBLIC_WS_URL = sanitizeWsPublicUrl(process.env.NEXT_PUBLIC_LIVE_WS_PUBLIC_URL);
const BUILD_TIME_WS_PATH = deriveLiveWsPath(process.env.NEXT_PUBLIC_LIVE_WS_PUBLIC_URL);

const BASE_PATH = process.env.NEXT_PUBLIC_TROUTEAI_BASE_PATH || "";

function getDefaultWsUrl(): string {
  if (BUILD_TIME_PUBLIC_WS_URL) return BUILD_TIME_PUBLIC_WS_URL;
  if (typeof window === "undefined") return `ws://localhost:20017${BASE_PATH}${BUILD_TIME_WS_PATH}`;
  // Same origin: the app server accepts live WebSocket upgrades on this path
  // (scripts/dev/run-next.mjs → src/server/ws/liveServer.ts), so it works behind any domain.
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${BASE_PATH}${BUILD_TIME_WS_PATH}`;
}

const DEFAULT_WS_URL = getDefaultWsUrl();

// ── Types ─────────────────────────────────────────────────────────────────

export interface WsEventPayload {
  event: string;
  channel: DashboardChannel;
  data: unknown;
  timestamp: number;
}

export interface DashboardConnectionState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  reconnectAttempt: number;
}

// ── Core Hook ─────────────────────────────────────────────────────────────

export interface UseLiveDashboardOptions {
  /** WebSocket URL (default: same origin, /live-ws) */
  wsUrl?: string;
  /** Whether the WebSocket connection should be active (default: true) */
  enabled?: boolean;
  /** API key for authentication */
  apiKey?: string;
  /** Channels to subscribe to */
  channels?: DashboardChannel[];
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Event callback */
  onEvent?: (payload: WsEventPayload) => void;
}

/**
 * Core WebSocket connection hook.
 * Manages connection lifecycle, reconnection, and event streaming.
 */
export function useLiveDashboard({
  wsUrl,
  enabled = true,
  apiKey,
  channels = ["requests", "combo", "credentials"],
  autoReconnect = true,
  onEvent,
}: UseLiveDashboardOptions = {}) {
  const [connection, setConnection] = useState<DashboardConnectionState>({
    isConnected: false,
    isConnecting: false,
    error: null,
    reconnectAttempt: 0,
  });

  // Runtime discovery of the public WS URL via the handshake endpoint.
  // NEXT_PUBLIC_* env vars are inlined at build time, so prebuilt Docker/npm
  // images never see a runtime NEXT_PUBLIC_LIVE_WS_PUBLIC_URL — the server
  // echoes it in the /api/v1/ws?handshake=1 response instead.
  // Skipped when the caller passes an explicit wsUrl or the env was inlined.
  const needsHandshake = !wsUrl && !BUILD_TIME_PUBLIC_WS_URL && typeof window !== "undefined";
  const [handshakeUrl, setHandshakeUrl] = useState<string | null>(null);
  const [handshakePath, setHandshakePath] = useState<string | null>(null);
  const [wsUrlResolved, setWsUrlResolved] = useState(!needsHandshake);

  useEffect(() => {
    if (!needsHandshake || wsUrlResolved) return;
    let cancelled = false;
    fetch("/api/v1/ws?handshake=1")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled) return;
        const publicUrl = sanitizeWsPublicUrl(body?.live?.publicUrl);
        if (publicUrl) setHandshakeUrl(publicUrl);
        if (typeof body?.live?.path === "string" && body.live.path.startsWith("/")) {
          setHandshakePath(body.live.path);
        }
      })
      .catch(() => {
        // Handshake unavailable — fall back to the default URL.
      })
      .finally(() => {
        if (!cancelled) setWsUrlResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsHandshake, wsUrlResolved]);

  const effectiveWsUrl = (() => {
    if (wsUrl) return wsUrl;
    if (handshakeUrl) return handshakeUrl;
    if (handshakePath && handshakePath !== BUILD_TIME_WS_PATH) {
      try {
        const url = new URL(DEFAULT_WS_URL);
        url.pathname = handshakePath;
        return url.toString();
      } catch {
        return DEFAULT_WS_URL;
      }
    }
    return DEFAULT_WS_URL;
  })();

  const [events, setEvents] = useState<WsEventPayload[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  // Retry count lives in a ref: keeping it in `connect`'s dependencies re-created the socket
  // on every open/close, and a closing old socket then cleared the new one's ref — a
  // reconnect loop (seen as 40+ connects a minute in the server log).
  const attemptRef = useRef(0);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);
  const connectRef = useRef<() => void>(() => {});
  const maxEvents = 500;

  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setConnection((prev) => ({
      ...prev,
      isConnecting: true,
      error: null,
    }));

    try {
      const wsUrlWithAuth = apiKey
        ? `${effectiveWsUrl}?token=${encodeURIComponent(apiKey)}`
        : effectiveWsUrl;

      const ws = new WebSocket(wsUrlWithAuth);
      wsRef.current = ws;
      // Events of a socket that was replaced or closed on purpose are ignored.
      const isCurrent = () => mountedRef.current && wsRef.current === ws;

      ws.onopen = () => {
        if (!isCurrent()) {
          ws.close();
          return;
        }
        attemptRef.current = 0;
        setConnection({
          isConnected: true,
          isConnecting: false,
          error: null,
          reconnectAttempt: 0,
        });

        // Subscribe to channels
        ws.send(JSON.stringify({ type: "subscribe", channels }));
      };

      ws.onmessage = (event) => {
        if (!isCurrent()) return;
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "event") {
            const payload: WsEventPayload = {
              event: msg.event,
              channel: msg.channel,
              data: msg.data,
              timestamp: msg.timestamp || Date.now(),
            };
            setEvents((prev) => {
              const next = [...prev, payload];
              return next.length > maxEvents ? next.slice(-maxEvents) : next;
            });
            onEventRef.current?.(payload);
          } else if (msg.type === "pong") {
            // Heartbeat response
          } else if (msg.type === "welcome") {
            // Send backlog
            if (Array.isArray(msg.data)) {
              setEvents((prev) => {
                const next = [...prev, ...msg.data];
                return next.length > maxEvents ? next.slice(-maxEvents) : next;
              });
              for (const item of msg.data) {
                const payload: WsEventPayload = {
                  event: item.event,
                  channel: item.channel,
                  data: item.data,
                  timestamp: item.timestamp || Date.now(),
                };
                onEventRef.current?.(payload);
              }
            }
          } else if (msg.type === "error") {
            console.error("[LiveWS] Server error:", msg.code, msg.message);
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onclose = () => {
        if (!isCurrent()) return;
        wsRef.current = null;
        setConnection((prev) => ({
          ...prev,
          isConnected: false,
          isConnecting: false,
        }));

        if (autoReconnect) {
          const attempt = attemptRef.current;
          const delay = WS_RECONNECT_DELAYS[Math.min(attempt, WS_RECONNECT_DELAYS.length - 1)];
          attemptRef.current = attempt + 1;
          setConnection((prev) => ({ ...prev, reconnectAttempt: attempt + 1 }));
          if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectTimeoutRef.current = null;
            connectRef.current();
          }, delay);
        }
      };

      ws.onerror = () => {
        if (!isCurrent()) return;
        setConnection((prev) => ({
          ...prev,
          isConnecting: false,
          error: "Connection failed",
        }));
      };
    } catch (err) {
      setConnection((prev) => ({
        ...prev,
        isConnecting: false,
        error: err instanceof Error ? err.message : "Connection failed",
      }));
    }
  }, [effectiveWsUrl, apiKey, channels.join(","), autoReconnect]);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  /** Close the current socket on purpose (its close event is then ignored). */
  const closeCurrent = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    ws?.close();
  }, []);

  // Connect on mount and on reconnect trigger
  useEffect(() => {
    mountedRef.current = true;
    if (!enabled) {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      closeCurrent();
      attemptRef.current = 0;
      setConnection({
        isConnected: false,
        isConnecting: false,
        error: null,
        reconnectAttempt: 0,
      });
      return;
    }

    // Wait for the handshake URL resolution before opening the socket, so we
    // never connect to the hardcoded default and then flap to the public URL.
    if (!wsUrlResolved) return;

    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      closeCurrent();
    };
  }, [connect, closeCurrent, enabled, wsUrlResolved]);

  // Manual retry: a fresh socket now, backoff reset.
  const reconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    closeCurrent();
    attemptRef.current = 0;
    setConnection((prev) => ({ ...prev, reconnectAttempt: 0 }));
    if (enabledRef.current) connectRef.current();
  }, [closeCurrent]);

  return {
    connection,
    events,
    reconnect,
    /** Filter events by channel */
    getEventsByChannel: useCallback(
      (channel: DashboardChannel) => events.filter((e) => e.channel === channel),
      [events]
    ),
    /** Filter events by name */
    getEventsByName: useCallback(
      (eventName: string) => events.filter((e) => e.event === eventName),
      [events]
    ),
    /** Clear event history */
    clearEvents: useCallback(() => setEvents([]), []),
  };
}

// ── Request Monitoring Hook ───────────────────────────────────────────────

export interface LiveRequest {
  id: string;
  model: string;
  provider: string;
  timestamp: number;
  status: "pending" | "running" | "success" | "error";
  tokensInput?: number;
  tokensOutput?: number;
  latencyMs?: number;
  error?: string;
  comboName?: string;
}

/**
 * Hook for monitoring live requests.
 */
export function useLiveRequests(options?: UseLiveDashboardOptions) {
  const [requestState, setRequestState] = useState<{
    active: Map<string, LiveRequest>;
    completed: LiveRequest[];
  }>({
    active: new Map(),
    completed: [],
  });
  const maxCompleted = 100;

  const handleEvent = useCallback((event: WsEventPayload) => {
    if (event.channel !== "requests") return;

    if (event.event === "request.started") {
      const data = event.data as any;
      setRequestState((prev) => {
        const active = new Map(prev.active);
        active.set(data.id, {
          id: data.id,
          model: data.model,
          provider: data.provider,
          timestamp: data.timestamp,
          status: "pending",
          comboName: data.comboName,
        });
        return { active, completed: prev.completed };
      });
    } else if (event.event === "request.streaming") {
      const data = event.data as any;
      setRequestState((prev) => {
        const active = new Map(prev.active);
        const existing = active.get(data.id);
        if (existing) {
          active.set(data.id, { ...existing, status: "running" });
        }
        return { active, completed: prev.completed };
      });
    } else if (event.event === "request.completed") {
      const data = event.data as any;
      setRequestState((prev) => {
        const active = new Map(prev.active);
        const existing = active.get(data.id);
        if (existing) {
          active.delete(data.id);
          const done: LiveRequest = {
            ...existing,
            status: data.status === "success" ? "success" : "error",
            tokensInput: data.tokensInput,
            tokensOutput: data.tokensOutput,
            latencyMs: data.latencyMs,
            error: data.error,
          };
          const completed = [done, ...prev.completed].slice(0, maxCompleted);
          return { active, completed };
        }
        return prev;
      });
    } else if (event.event === "request.failed") {
      const data = event.data as any;
      setRequestState((prev) => {
        const active = new Map(prev.active);
        const existing = active.get(data.id);
        if (existing) {
          active.delete(data.id);
          const done: LiveRequest = {
            ...existing,
            status: "error",
            error: data.error,
            latencyMs: data.latencyMs,
          };
          const completed = [done, ...prev.completed].slice(0, maxCompleted);
          return { active, completed };
        }
        return prev;
      });
    }
  }, []);

  const { connection, reconnect } = useLiveDashboard({
    channels: ["requests"],
    onEvent: handleEvent,
    ...options,
  });

  return {
    activeRequests: Array.from(requestState.active.values()),
    completedRequests: requestState.completed,
    activeCount: requestState.active.size,
    isConnected: connection.isConnected,
    reconnect,
  };
}

// ── Combo Status Hook ─────────────────────────────────────────────────────

export interface LiveComboEvent {
  comboName: string;
  targetIndex: number;
  provider: string;
  model: string;
  type: "attempt" | "succeeded" | "failed";
  /** Routing strategy, carried on the attempt payload (used by the Combo Studio). */
  strategy?: string;
  latencyMs?: number;
  error?: string;
  timestamp: number;
}

/**
 * Hook for monitoring live combo cascade status.
 */
export function useLiveComboStatus(options?: UseLiveDashboardOptions) {
  const [comboEvents, setComboEvents] = useState<LiveComboEvent[]>([]);
  const maxComboEvents = 200;

  const handleEvent = useCallback((event: WsEventPayload) => {
    if (event.channel !== "combo") return;

    const data = event.data as any;
    let comboEvent: LiveComboEvent | null = null;

    if (event.event === "combo.target.attempt") {
      comboEvent = {
        comboName: data.comboName,
        targetIndex: data.targetIndex,
        provider: data.provider,
        model: data.model,
        type: "attempt",
        strategy: data.strategy,
        timestamp: event.timestamp,
      };
    } else if (event.event === "combo.target.succeeded") {
      comboEvent = {
        comboName: data.comboName,
        targetIndex: data.targetIndex,
        provider: data.provider,
        model: data.model,
        type: "succeeded",
        latencyMs: data.latencyMs,
        timestamp: event.timestamp,
      };
    } else if (event.event === "combo.target.failed") {
      comboEvent = {
        comboName: data.comboName,
        targetIndex: data.targetIndex,
        provider: data.provider,
        model: data.model,
        type: "failed",
        error: data.error,
        latencyMs: data.latencyMs,
        timestamp: event.timestamp,
      };
    }

    if (comboEvent) {
      setComboEvents((prev) => [comboEvent!, ...prev].slice(0, maxComboEvents));
    }
  }, []);

  const { connection, reconnect } = useLiveDashboard({
    channels: ["combo"],
    onEvent: handleEvent,
    ...options,
  });

  /** Get events for a specific combo */
  const getComboHistory = useCallback(
    (comboName: string) => comboEvents.filter((e) => e.comboName === comboName),
    [comboEvents]
  );

  /** Get the last event for a specific combo */
  const getLastComboEvent = useCallback(
    (comboName: string) => comboEvents.find((e) => e.comboName === comboName),
    [comboEvents]
  );

  return {
    comboEvents,
    activeCombos: new Set(comboEvents.map((e) => e.comboName)),
    isConnected: connection.isConnected,
    getComboHistory,
    getLastComboEvent,
    reconnect,
  };
}

// ── Connection Status Hook ────────────────────────────────────────────────

/**
 * Hook for checking connection status only (no events).
 */
export function useLiveConnectionStatus(options?: UseLiveDashboardOptions) {
  const { connection, reconnect } = useLiveDashboard({
    channels: [],
    ...options,
  });
  return { ...connection, reconnect };
}
