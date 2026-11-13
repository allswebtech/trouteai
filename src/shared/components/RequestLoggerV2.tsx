"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import Card from "./Card";
import ColumnToggle from "./ColumnToggle";
import EmptyState from "./EmptyState";
import RequestLoggerDetail from "./RequestLoggerDetail";
import { copyToClipboard } from "@/shared/utils/clipboard";
import { PROVIDER_COLORS, getProtocolColor } from "@/shared/constants/colors";
import {
  formatTime,
  formatDuration,
  maskAccount,
  stableAccountSuffix,
  formatApiKeyLabel,
} from "@/shared/utils/formatting";
import { getProviderDisplayLabel } from "@/shared/utils/providerDisplayLabel";
import useEmailPrivacyStore from "@/store/emailPrivacyStore";
import {
  computeLogsSignature,
  shouldAutoRefresh,
  shouldTriggerInfiniteScroll,
} from "./requestLoggerSignature";
import {
  DEFAULT_REFRESH_INTERVAL_SEC,
  clampRefreshIntervalSec,
  readSavedRefreshIntervalSec,
  writeSavedRefreshIntervalSec,
} from "./requestLoggerPreferences";
import {
  LOG_TABLE_CLASS,
  LOG_TABLE_HEAD_CLASS,
  LOG_TABLE_HEADER_BG_STYLE,
  LOG_TABLE_HEADER_CELL_CLASS,
  LOG_TABLE_HEADER_CELL_RIGHT_CLASS,
  LOG_TABLE_ROW_CLASS,
  getCacheSourceMeta,
  getStatusBadgeClass,
} from "./logTableStyles";

// Number of call-log rows fetched per page. The viewer grows its window by this
// amount on "Load more" / infinite scroll so users can browse past the first
// page (previously hardcoded to a single 300-row window).
// Reduced from 300 → 50 to avoid browser freeze and network saturation.
const PAGE_SIZE = 50;

const LOGGER_SELECT_CLASS =
  "h-8 max-w-[220px] cursor-pointer truncate rounded-control border border-border bg-surface px-3 text-sm text-text-main focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

function getLogTotalTokens(log) {
  return (log?.tokens?.in || 0) + (log?.tokens?.out || 0);
}

function getLogTps(log): number {
  const tokensOut = log?.tokens?.out || 0;
  const durationMs = log?.duration || 0;
  if (tokensOut <= 0 || durationMs <= 0) return 0;
  return tokensOut / (durationMs / 1000);
}

function formatTps(tps: number): string {
  if (tps <= 0) return "—";
  if (tps >= 100) return Math.round(tps).toLocaleString();
  return tps.toFixed(1);
}

export interface RequestLoggerV2Handle {
  openDetail: (logEntry: any) => void;
  getSortedLogs: () => any[];
}

const RequestLoggerV2 = forwardRef<RequestLoggerV2Handle, { initialSelectedId?: string }>(
  (props, ref) => {
    const { initialSelectedId } = props as any;
    const t = useTranslations("requestLogger");
    const tc = useTranslations("common");
    const { emailsVisible } = useEmailPrivacyStore();

    // Get translated status filters
    const statusFilters = useMemo(
      () => [
        { key: "all", label: t("statusFilters.all"), icon: "" },
        { key: "error", label: t("statusFilters.error"), icon: "error" },
        { key: "ok", label: t("statusFilters.success"), icon: "check_circle" },
        { key: "combo", label: t("statusFilters.combo"), icon: "hub" },
      ],
      [t]
    );

    // Get translated columns
    const columns = useMemo(
      () => [
        { key: "status", label: t("columns.status") },
        { key: "cacheSource", label: t("columns.cacheSource") },
        { key: "model", label: t("columns.model") },
        { key: "requestedModel", label: t("columns.requested") },
        { key: "provider", label: t("columns.provider") },
        { key: "protocol", label: t("columns.protocol") },
        { key: "account", label: t("columns.account") },
        { key: "apiKey", label: t("columns.apiKey") },
        { key: "combo", label: t("columns.combo") },
        { key: "tokens", label: t("columns.tokens") },
        { key: "tps", label: t("columns.tps") },
        { key: "duration", label: t("columns.duration") },
        { key: "time", label: t("columns.time") },
      ],
      [t]
    );

    const [logs, setLogs] = useState([]);
    const [loading, setLoading] = useState(true);
    const [recording, setRecording] = useState(true);
    const [search, setSearch] = useState("");
    const [activeFilter, setActiveFilter] = useState("all");
    const [selectedModel, setSelectedModel] = useState("");
    const [selectedAccount, setSelectedAccount] = useState("");
    const [selectedProvider, setSelectedProvider] = useState("");
    const [selectedApiKey, setSelectedApiKey] = useState("");
    const [sortBy, setSortBy] = useState("newest");
    const [selectedLog, setSelectedLog] = useState(null);
    const [correlationIdFilter, setCorrelationIdFilter] = useState("");
    const [hoveredCid, setHoveredCid] = useState<string | null>(null);
    const [groupedView, setGroupedView] = useState(false);
    const [detailLoading, setDetailLoading] = useState(false);
    // Pure UI: advanced filters stay folded until asked for.
    const [showFilters, setShowFilters] = useState(false);

    // Column sort toggle: clicking a column header toggles asc/desc
    const columnSortMap = {
      status: { desc: "status_desc", asc: "status_asc" },
      model: { desc: "model_desc", asc: "model_asc" },
      tokens: { desc: "tokens_desc", asc: "tokens_asc" },
      tps: { desc: "tps_desc", asc: "tps_asc" },
      duration: { desc: "duration_desc", asc: "duration_asc" },
      time: { desc: "newest", asc: "oldest" },
    };
    const toggleSort = useCallback((column: string) => {
      const mapping = columnSortMap[column as keyof typeof columnSortMap];
      if (!mapping) return;
      setSortBy((prev) => {
        if (prev === mapping.desc) return mapping.asc;
        return mapping.desc;
      });
    }, []);
    const getSortIndicator = useCallback(
      (column: string) => {
        const mapping = columnSortMap[column as keyof typeof columnSortMap];
        if (!mapping) return "";
        if (sortBy === mapping.desc) return " ↓";
        if (sortBy === mapping.asc) return " ↑";
        return "";
      },
      [sortBy]
    );
    const [detailData, setDetailData] = useState(null);
    const [detailLoggingEnabled, setDetailLoggingEnabled] = useState(false);
    const [detailLoggingLoading, setDetailLoggingLoading] = useState(false);
    const [limit, setLimit] = useState(PAGE_SIZE);
    const [hasMore, setHasMore] = useState(false);
    const [refreshIntervalSec, setRefreshIntervalSec] = useState(DEFAULT_REFRESH_INTERVAL_SEC);
    const intervalRef = useRef(null);
    const refreshIntervalSecRef = useRef(DEFAULT_REFRESH_INTERVAL_SEC);
    const detailRequestRef = useRef("");
    const hasLoadedRef = useRef(false);
    const logsSignatureRef = useRef("");
    const scrollContainerRef = useRef(null);
    const loadMoreSentinelRef = useRef(null);
    const hasScrolledRef = useRef(false);
    const [providerNodes, setProviderNodes] = useState([]);
    const visibleRef = useRef(true);

    const [visibleColumns, setVisibleColumns] = useState(() => {
      const defaultVisible = Object.fromEntries(columns.map((c) => [c.key, true]));
      if (globalThis.window === undefined) return defaultVisible;
      try {
        const saved = localStorage.getItem("loggerVisibleColumns");
        return saved ? { ...defaultVisible, ...JSON.parse(saved) } : defaultVisible;
      } catch {
        return defaultVisible;
      }
    });

    const toggleColumn = useCallback((key) => {
      setVisibleColumns((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        try {
          localStorage.setItem("loggerVisibleColumns", JSON.stringify(next));
        } catch {}
        return next;
      });
    }, []);

    useEffect(() => {
      const saved = readSavedRefreshIntervalSec();
      refreshIntervalSecRef.current = saved;
      setRefreshIntervalSec(saved);
    }, []);

    useEffect(() => {
      refreshIntervalSecRef.current = refreshIntervalSec;
    }, [refreshIntervalSec]);

    const updateRefreshIntervalSec = useCallback(
      (valueOrUpdater: number | ((current: number) => number)) => {
        const current = refreshIntervalSecRef.current;
        const rawValue =
          typeof valueOrUpdater === "function" ? valueOrUpdater(current) : valueOrUpdater;
        const next = clampRefreshIntervalSec(rawValue);
        refreshIntervalSecRef.current = next;
        writeSavedRefreshIntervalSec(next);
        setRefreshIntervalSec(next);
      },
      []
    );

    const fetchLogs = useCallback(
      async (showLoading = false) => {
        if (showLoading) setLoading(true);
        try {
          const params = new URLSearchParams();
          if (search) params.set("search", search);
          if (activeFilter === "error") params.set("status", "error");
          if (activeFilter === "ok") params.set("status", "ok");
          if (activeFilter === "combo") params.set("combo", "1");
          if (selectedModel) params.set("model", selectedModel);
          if (selectedProvider) params.set("provider", selectedProvider);
          if (selectedAccount) params.set("account", selectedAccount);
          if (selectedApiKey) params.set("apiKey", selectedApiKey);
          if (correlationIdFilter) params.set("correlationId", correlationIdFilter);
          params.set("limit", String(limit));

          const res = await fetch(`/api/usage/call-logs?${params}`);
          if (res.ok) {
            const data = await res.json();
            // If the server returned a full window, more rows may exist beyond it.
            setHasMore(Array.isArray(data) && data.length >= limit);
            // Skip re-render if data hasn't changed (GPU perf). The signature
            // captures id + status + duration + tokens_out so in-progress updates
            // still re-render while identical snapshots are skipped.
            const sig = computeLogsSignature(data);
            if (sig !== logsSignatureRef.current) {
              logsSignatureRef.current = sig;
              setLogs(data);
            }
          }
        } catch (error) {
          console.error("Failed to fetch call logs:", error);
        } finally {
          if (showLoading) setLoading(false);
        }
      },
      [
        search,
        activeFilter,
        selectedModel,
        selectedAccount,
        selectedProvider,
        selectedApiKey,
        correlationIdFilter,
        limit,
      ]
    );

    useEffect(() => {
      const showLoading = !hasLoadedRef.current;
      hasLoadedRef.current = true;
      fetchLogs(showLoading);
    }, [fetchLogs]);

    // Fetch provider nodes for display labels
    useEffect(() => {
      fetch("/api/provider-nodes")
        .then((r) => (r.ok ? r.json() : { nodes: [] }))
        .then((d) => setProviderNodes(d.nodes || []))
        .catch(() => {});
    }, []);

    useEffect(() => {
      fetch("/api/logs/detail?limit=1")
        .then(async (res) => {
          if (!res.ok) return null;
          return await res.json();
        })
        .then((data) => {
          if (!data) return;
          setDetailLoggingEnabled(data.enabled === true);
        })
        .catch(() => {});
    }, []);

    // Visibility-aware auto-refresh: pause polling when tab is hidden or user has
    // scrolled past the first page, or when a detail modal is open.
    useEffect(() => {
      const onVisibility = () => {
        const isVisible = document.visibilityState === "visible";
        visibleRef.current = isVisible;
        if (isVisible && !selectedLog && shouldAutoRefresh(recording, limit, PAGE_SIZE)) {
          fetchLogs(false);
        }
      };
      // Re-arm on window focus. Embedded / proxied hosts (Docker dashboard
      // wrappers, webviews) can fire a one-shot `visibilitychange` → hidden and
      // then keep reporting "hidden" — or recover without firing the event again —
      // which left `visibleRef` stuck `false` and froze auto-refresh permanently
      // (a "stopped refreshing after an update" report). A window
      // `focus` is a reliable signal the page is actively viewed, so re-arm and
      // poll. A genuinely backgrounded tab never receives focus, so this does not
      // defeat the perf pause.
      const onFocus = () => {
        visibleRef.current = true;
        if (!selectedLog && shouldAutoRefresh(recording, limit, PAGE_SIZE)) {
          fetchLogs(false);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("focus", onFocus);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("focus", onFocus);
      };
    }, [recording, limit, fetchLogs, selectedLog]);

    useEffect(() => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (!selectedLog && shouldAutoRefresh(recording, limit, PAGE_SIZE)) {
        intervalRef.current = setInterval(() => {
          // Poll while the page is plausibly viewed — the
          // event-tracked `visibleRef` (fail-open) OR a *live* `visibilityState`
          // read. A real background tab has both false → pause (perf); an
          // embedded host that misreports "hidden" keeps polling instead of
          // freezing. The window-`focus` re-arm above covers a host pinned
          // "hidden" while focused.
          if (visibleRef.current || document.visibilityState === "visible") {
            fetchLogs(false);
          }
        }, refreshIntervalSec * 1000);
      }
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }, [recording, fetchLogs, limit, refreshIntervalSec, selectedLog]);

    // Reset the window back to the first page whenever the active filters change,
    // so switching filters doesn't keep fetching a large expanded window.
    useEffect(() => {
      setLimit(PAGE_SIZE);
      // A filter change is a fresh first-page view — re-arm the ghost-load-more
      // guard so auto-refresh resumes until the user scrolls again.
      hasScrolledRef.current = false;
    }, [
      search,
      activeFilter,
      selectedModel,
      selectedAccount,
      selectedProvider,
      selectedApiKey,
      correlationIdFilter,
    ]);

    const loadMore = useCallback(() => {
      setLimit((prev) => prev + PAGE_SIZE);
    }, []);

    // Record the first genuine user scroll of the log list. Until then, the
    // infinite-scroll observer below must NOT grow the window (see
    // shouldTriggerInfiniteScroll) — otherwise a sentinel that is already visible on
    // mount fires a "ghost" loadMore and permanently pauses auto-refresh.
    useEffect(() => {
      const root = scrollContainerRef.current;
      if (!root) return;
      const onScroll = () => {
        if (root.scrollTop > 0) hasScrolledRef.current = true;
      };
      root.addEventListener("scroll", onScroll, { passive: true });
      return () => root.removeEventListener("scroll", onScroll);
    }, []);

    // Infinite scroll: grow the window when the sentinel near the bottom of the
    // scroll container becomes visible — but only after a real user scroll.
    useEffect(() => {
      const sentinel = loadMoreSentinelRef.current;
      const root = scrollContainerRef.current;
      if (!sentinel || !hasMore) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (
            shouldTriggerInfiniteScroll({
              isIntersecting: !!entries[0]?.isIntersecting,
              hasMore,
              loading,
              hasScrolled: hasScrolledRef.current,
            })
          ) {
            loadMore();
          }
        },
        { root, rootMargin: "200px" }
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [hasMore, loading, loadMore]);

    const filteredLogs = useMemo(() => {
      let arr = logs;

      // Status filter
      if (activeFilter === "error") {
        arr = arr.filter((l) => l.status >= 400);
      } else if (activeFilter === "ok") {
        arr = arr.filter((l) => l.status >= 200 && l.status < 300);
      } else if (activeFilter === "combo") {
        arr = arr.filter((l) => l.comboName);
      }

      return arr;
    }, [logs, activeFilter]);

    // Grouped view: deduplicate by correlationId, keeping only the latest per group.
    // Rows without a correlationId are always shown.
    const dedupedLogs = useMemo(() => {
      if (!groupedView) return filteredLogs;
      const byCid = new Map<string, (typeof filteredLogs)[0]>();
      const noCid: typeof filteredLogs = [];
      for (const log of filteredLogs) {
        const cid = log.correlationId;
        if (!cid) {
          noCid.push(log);
          continue;
        }
        const existing = byCid.get(cid);
        if (
          !existing ||
          new Date(log.timestamp).getTime() > new Date(existing.timestamp).getTime()
        ) {
          byCid.set(cid, log);
        }
      }
      return [...noCid, ...byCid.values()];
    }, [filteredLogs, groupedView]);

    const sortedLogs = useMemo(() => {
      const arr = [...dedupedLogs];

      arr.sort((a, b) => {
        switch (sortBy) {
          case "oldest":
            return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
          case "tokens_desc":
            return getLogTotalTokens(b) - getLogTotalTokens(a);
          case "tokens_asc":
            return getLogTotalTokens(a) - getLogTotalTokens(b);
          case "duration_desc":
            return (b.duration || 0) - (a.duration || 0);
          case "duration_asc":
            return (a.duration || 0) - (b.duration || 0);
          case "tps_desc":
            return getLogTps(b) - getLogTps(a);
          case "tps_asc":
            return getLogTps(a) - getLogTps(b);
          case "status_desc":
            return (b.status || 0) - (a.status || 0);
          case "status_asc":
            return (a.status || 0) - (b.status || 0);
          case "model_asc":
            return (a.model || "").localeCompare(b.model || "");
          case "model_desc":
            return (b.model || "").localeCompare(a.model || "");
          case "newest":
          default:
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        }
      });

      return arr;
    }, [dedupedLogs, sortBy]);

    // Group by correlationId: mark retries as children so they render indented
    // under the first request in each group. Compute group health:
    //   "healed"  — at least one failure followed by a success
    //   "failed"  — all attempts failed
    //   null      — single request or all succeeded
    const groupedLogs = useMemo(() => {
      const cidGroups = new Map();
      for (const log of sortedLogs) {
        const cid = log.correlationId;
        if (cid) {
          if (!cidGroups.has(cid)) cidGroups.set(cid, []);
          cidGroups.get(cid).push(log);
        }
      }
      return sortedLogs.map((log) => {
        const cid = log.correlationId;
        if (!cid) return { ...log, isRetry: false, groupSize: 1, groupStatus: null };
        const group = cidGroups.get(cid);
        if (!group || group.length <= 1)
          return { ...log, isRetry: false, groupSize: 1, groupStatus: null };
        const isFirst = group[0].id === log.id;
        const hasFailure = group.some((g) => g.status >= 400 || g.active);
        const hasSuccess = group.some((g) => g.status >= 200 && g.status < 300);
        const groupStatus = hasFailure && hasSuccess ? "healed" : hasFailure ? "failed" : null;
        return { ...log, isRetry: !isFirst, groupSize: group.length, groupStatus };
      });
    }, [sortedLogs]);

    // Fetch log detail from the persisted call-log endpoint. If a deep-linked
    // request is still being finalized, keep the modal open and poll this same
    // endpoint until the row appears.
    const router = useRouter();

    const openDetail = async (logEntry) => {
      // Guard: if no valid id provided, close instead of opening an empty modal
      if (!logEntry?.id) {
        try {
          closeDetail();
        } catch {}
        return;
      }

      const requestToken = `${logEntry.id}:${Date.now()}:${Math.random()}`;
      detailRequestRef.current = requestToken;
      const isCurrentDetailRequest = () => detailRequestRef.current === requestToken;

      setSelectedLog(logEntry);
      try {
        const url = new URL(globalThis.location.href);
        url.searchParams.set("id", logEntry.id);
        router.replace(url.pathname + url.search);
      } catch (e) {
        // ignore navigation errors
      }
      setDetailLoading(true);
      setDetailData(null);
      try {
        const res = await fetch(`/api/logs/${logEntry.id}`, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (!isCurrentDetailRequest()) return;
          const dataHasPipeline =
            data?.pipelinePayloads && Object.keys(data.pipelinePayloads || {}).length > 0;
          setDetailData((prev: { pipelinePayloads: any }) => ({
            ...prev,
            ...data,
            pipelinePayloads: dataHasPipeline ? data.pipelinePayloads : prev?.pipelinePayloads,
          }));
          // ensure the modal summary reflects the fetched call log summary
          if (data && typeof data === "object") {
            setSelectedLog((prev: any) => ({
              ...prev,
              ...data,
              active: data.active === true,
            }));
          }
        } else {
          // A deep-linked id can legitimately 404 while the request is still
          // finalizing. Keep the modal open and poll /api/logs/[id] instead of
          // falling back to an in-memory active-request endpoint.
          if (!isCurrentDetailRequest()) return;
          if (res.status === 404) {
            if (logEntry.pendingLookup || logEntry.active) {
              setSelectedLog((prev: { method: any; path: any }) => ({
                ...prev,
                id: logEntry.id,
                status: 0,
                method: prev?.method,
                path: prev?.path || "",
              }));
              setDetailData({ detailState: "pending" });
              return;
            }
            try {
              console.warn("Log not found:", logEntry.id);
            } catch {}
            try {
              closeDetail();
            } catch {}
            return;
          }
          // other errors: show a minimal error indicator by setting detailData to an error object
          try {
            const body = await res.text().catch(() => null);
            if (!isCurrentDetailRequest()) return;
            setDetailData({ error: `Failed to fetch log (status ${res.status})`, body });
          } catch {}
        }
      } catch (error) {
        console.error("Failed to fetch log detail:", error);
      } finally {
        if (isCurrentDetailRequest()) setDetailLoading(false);
      }
    };

    const closeDetail = () => {
      detailRequestRef.current = "";
      setSelectedLog(null);
      setDetailData(null);
      try {
        // remove id param when closing detail
        const url = new URL(globalThis.location.href);
        url.searchParams.delete("id");
        router.replace(url.pathname + url.search);
      } catch (e) {
        // ignore navigation errors
      }
    };

    const sortedLogsForNav = useMemo(() => sortedLogs, [sortedLogs]);

    useImperativeHandle(
      ref,
      () => ({
        openDetail,
        getSortedLogs: () => sortedLogsForNav,
      }),
      [openDetail, sortedLogsForNav]
    );

    // If the page provided an initialSelectedId (via ?id=), open it on mount.
    // Guard with a ref so subsequent URL updates (close -> replace) don't re-open the modal.
    const initialOpenedRef = useRef(false);
    useEffect(() => {
      if (initialSelectedId && !initialOpenedRef.current) {
        initialOpenedRef.current = true;
        openDetail({ id: initialSelectedId, pendingLookup: true })
          .then((r) => r)
          .catch((error_) => {
            console.error("Failed to open initial log id:", error_);
          });
      }
    }, [initialSelectedId]);

    useEffect(() => {
      const isActive = selectedLog?.active === true;
      if (!selectedLog?.id || !isActive) return;
      let cancelled = false;
      let graceCount = 0;
      const interval = setInterval(async () => {
        if (document.visibilityState !== "visible") return;
        try {
          const res = await fetch(`/api/logs/${selectedLog.id}`, { cache: "no-store" });
          if (cancelled) return;
          if (res.status === 404) {
            if (isActive) return;
            clearInterval(interval);
            return;
          }
          if (res.ok) {
            const data = await res.json();
            const stillActive = data.active === true;
            setDetailData((prev: { pipelinePayloads: any }) => ({
              ...prev,
              ...data,
              pipelinePayloads: data?.pipelinePayloads || prev?.pipelinePayloads,
            }));
            setSelectedLog((prev: any) => ({
              ...prev,
              ...data,
              active: stillActive,
            }));
            if (!stillActive) {
              graceCount++;
              if (graceCount >= 3) clearInterval(interval);
            }
          }
        } catch {
          // keep waiting; the detail endpoint is the single source of truth
        }
      }, 1000);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }, [selectedLog?.id, detailData?.detailState, selectedLog?.active, fetchLogs]);

    // Poll for related logs (same correlationId) while the detail modal is open.
    // This ensures newly completed retries appear without closing the modal.
    useEffect(() => {
      const cid = selectedLog?.correlationId;
      if (!selectedLog?.id || !cid) return;
      let cancelled = false;
      const interval = setInterval(async () => {
        if (document.visibilityState !== "visible") return;
        try {
          const res = await fetch(`/api/usage/call-logs?correlationId=${encodeURIComponent(cid)}`, {
            cache: "no-store",
          });
          if (cancelled || !res.ok) return;
          const cidLogs = await res.json();
          if (!Array.isArray(cidLogs) || cidLogs.length === 0) return;
          setLogs((prev) => {
            const ids = new Set(cidLogs.map((l: any) => l.id));
            let changed = false;
            const merged = prev.map((l: any) => {
              const updated = cidLogs.find((c: any) => c.id === l.id);
              if (updated) {
                changed = true;
                return { ...l, ...updated };
              }
              return l;
            });
            for (const cl of cidLogs) {
              if (!merged.some((m: any) => m.id === cl.id)) {
                merged.push(cl);
                changed = true;
              }
            }
            return changed ? merged : prev;
          });
        } catch {
          /* poll failed — non-critical */
        }
      }, 3000);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }, [selectedLog?.id, selectedLog?.correlationId]);

    const currentLogIndex = useMemo(() => {
      if (!selectedLog) return -1;
      return sortedLogsForNav.findIndex((l) => l.id === selectedLog.id);
    }, [selectedLog, sortedLogsForNav]);

    const handlePrev = useCallback(() => {
      const idx = currentLogIndex;
      const target = idx > 0 ? sortedLogsForNav[idx - 1] : null;
      if (target?.id) {
        openDetail(target)
          .then((r) => r)
          .catch((error_) => {
            console.error("Failed to open previous log id:", error_);
          });
      } else {
        closeDetail();
      }
    }, [currentLogIndex, sortedLogsForNav]);

    const handleNext = useCallback(() => {
      const idx = currentLogIndex;
      const target =
        idx >= 0 && idx < sortedLogsForNav.length - 1 ? sortedLogsForNav[idx + 1] : null;
      if (target?.id) {
        openDetail(target)
          .then((r) => r)
          .catch((error_) => {
            console.error("Failed to open previous log id:", error_);
          });
      } else {
        closeDetail();
      }
    }, [currentLogIndex, sortedLogsForNav]);

    const toggleDetailLogging = async () => {
      setDetailLoggingLoading(true);
      try {
        const nextEnabled = !detailLoggingEnabled;
        const res = await fetch("/api/logs/detail", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        });
        if (!res.ok) throw new Error(t("updatePipelineFailed"));
        setDetailLoggingEnabled(nextEnabled);
      } catch (error) {
        console.error("Failed to toggle pipeline logging:", error);
      } finally {
        setDetailLoggingLoading(false);
      }
    };

    const sourceLogsForDropdowns = logs;

    // Unique accounts and providers for dropdowns

    const uniqueAccounts = useMemo(
      () => [
        ...new Set(sourceLogsForDropdowns.map((l) => l.account).filter((a) => a && a !== "-")),
      ],
      [sourceLogsForDropdowns]
    );
    const uniqueModels = useMemo(
      () =>
        [
          ...new Set(
            sourceLogsForDropdowns.flatMap((l) => [l.model, l.requestedModel]).filter(Boolean)
          ),
        ].sort(),
      [sourceLogsForDropdowns]
    );
    const uniqueProviders = useMemo(
      () =>
        [
          ...new Set(sourceLogsForDropdowns.map((l) => l.provider).filter((p) => p && p !== "-")),
        ].sort(),
      [sourceLogsForDropdowns]
    );
    const uniqueApiKeys = useMemo(
      () =>
        [
          ...new Set(sourceLogsForDropdowns.map((l) => l.apiKeyId || l.apiKeyName).filter(Boolean)),
        ].sort(),
      [sourceLogsForDropdowns]
    );

    // Stats (memoized to avoid re-computation on every render)
    const { totalCount, okCount, errorCount, comboCount, apiKeyCount, runningCount } = useMemo(
      () => ({
        totalCount: filteredLogs.length,
        okCount: filteredLogs.filter((l) => l.status >= 200 && l.status < 300).length,
        errorCount: filteredLogs.filter((l) => l.status >= 400).length,
        comboCount: logs.filter((l) => l.comboName).length,
        apiKeyCount: uniqueApiKeys.length,
        runningCount: filteredLogs.filter((l) => l.active === true).length,
      }),
      [filteredLogs, logs, uniqueApiKeys]
    );

    // Badge count for the "Filters" button (only filters hidden behind it).
    const activeAdvancedFilterCount = [
      selectedProvider,
      selectedModel,
      selectedAccount,
      selectedApiKey,
      correlationIdFilter,
      groupedView,
      sortBy !== "newest",
    ].filter(Boolean).length;

    return (
      <div className="flex flex-col gap-4">
        {/* Toolbar: the controls most people need stay visible */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Recording Toggle */}
          <button
            onClick={() => setRecording(!recording)}
            className={`inline-flex h-8 items-center gap-2 rounded-control border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
              recording
                ? "border-error/30 bg-error/10 text-error"
                : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
            }`}
          >
            <span
              className={`size-2 rounded-full ${recording ? "bg-error animate-pulse" : "bg-text-muted"}`}
              aria-hidden="true"
            />
            {recording ? t("recording") : t("paused")}
          </button>

          {/* Search */}
          <div className="relative min-w-[200px] flex-1">
            <span
              className="material-symbols-outlined pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[18px] text-text-muted"
              aria-hidden="true"
            >
              search
            </span>
            <input
              type="text"
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-control border border-border bg-surface ps-9 pe-3 text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {/* Status Filters (segmented look) */}
          <div className="inline-flex items-center gap-0.5 rounded-control border border-border bg-surface-2 p-0.5">
            {statusFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setActiveFilter(activeFilter === f.key ? "all" : f.key)}
                className={`inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
                  activeFilter === f.key
                    ? "border-border bg-surface text-text-main shadow-none"
                    : "border-transparent text-text-muted hover:text-text-main"
                }`}
              >
                {f.icon && (
                  <span
                    className={`material-symbols-outlined text-[14px] ${
                      activeFilter === f.key && f.key === "error"
                        ? "text-error"
                        : activeFilter === f.key && f.key === "ok"
                          ? "text-success"
                          : ""
                    }`}
                    aria-hidden="true"
                  >
                    {f.icon}
                  </span>
                )}
                {f.label}
              </button>
            ))}
          </div>

          {/* Filters disclosure */}
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 ${
              showFilters || activeAdvancedFilterCount > 0
                ? "border-primary/30 bg-primary/10 text-primary-text"
                : "border-border bg-surface text-text-main hover:bg-surface-2"
            }`}
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              tune
            </span>
            {tc("filters")}
            {activeAdvancedFilterCount > 0 && (
              <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-on-primary">
                {activeAdvancedFilterCount}
              </span>
            )}
          </button>

          {/* Column visibility */}
          <ColumnToggle columns={columns} visible={visibleColumns} onToggle={toggleColumn} />

          {/* Refresh */}
          <button
            onClick={() => fetchLogs(false)}
            className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-surface text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            title={t("refresh")}
            aria-label={t("refresh")}
          >
            <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
              refresh
            </span>
          </button>
        </div>

        {/* Advanced filters (hidden by default) */}
        {showFilters && (
          <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              {/* Provider Dropdown */}
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className={LOGGER_SELECT_CLASS}
              >
                <option value="">{t("allProviders")}</option>
                {uniqueProviders.map((p) => {
                  const compatLabel = getProviderDisplayLabel(p, providerNodes);
                  const pc = PROVIDER_COLORS[p];
                  return (
                    <option key={p} value={p}>
                      {compatLabel || pc?.label || p.toUpperCase()}
                    </option>
                  );
                })}
              </select>

              {/* Model Dropdown */}
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className={LOGGER_SELECT_CLASS}
              >
                <option value="">{t("allModels")}</option>
                {uniqueModels.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>

              {/* Account Dropdown */}
              <select
                value={selectedAccount}
                onChange={(e) => setSelectedAccount(e.target.value)}
                className={LOGGER_SELECT_CLASS}
              >
                <option value="">{t("allAccounts")}</option>
                {uniqueAccounts.map((a) => (
                  <option key={a} value={a}>
                    {emailsVisible ? a : `${maskAccount(a, false)} · #${stableAccountSuffix(a)}`}
                  </option>
                ))}
              </select>

              {/* API Key Dropdown */}
              <select
                value={selectedApiKey}
                onChange={(e) => setSelectedApiKey(e.target.value)}
                className={LOGGER_SELECT_CLASS}
              >
                <option value="">{t("allApiKeys")}</option>
                {uniqueApiKeys.map((value) => {
                  const matched = logs.find((l) => (l.apiKeyId || l.apiKeyName) === value);
                  const label = formatApiKeyLabel(matched?.apiKeyName, matched?.apiKeyId);
                  return (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  );
                })}
              </select>

              {/* Correlation ID Filter */}
              <div className="relative min-w-[180px]">
                <span
                  className="material-symbols-outlined pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-[16px] text-text-muted"
                  aria-hidden="true"
                >
                  tag
                </span>
                <input
                  type="text"
                  placeholder="Correlation ID"
                  value={correlationIdFilter}
                  onChange={(e) => setCorrelationIdFilter(e.target.value)}
                  className="h-8 w-full rounded-control border border-border bg-surface ps-8 pe-3 font-mono text-sm text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>

              {/* Group by CID toggle */}
              <button
                onClick={() => setGroupedView((v) => !v)}
                className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-sm font-medium transition-colors ${
                  groupedView
                    ? "border-primary/30 bg-primary/10 text-primary-text"
                    : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
                }`}
                title={groupedView ? t("showAllRows") : t("showLatestPerCorrelation")}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  {groupedView ? "unfold_less" : "unfold_more"}
                </span>
                {groupedView ? t("grouped") : t("allRows")}
              </button>

              {/* Sort Dropdown */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className={LOGGER_SELECT_CLASS}
                title={t("sortLogs")}
              >
                <option value="newest">{t("sortNewest")}</option>
                <option value="oldest">{t("sortOldest")}</option>
                <option value="tokens_desc">{t("sortTokensDesc")}</option>
                <option value="tokens_asc">{t("sortTokensAsc")}</option>
                <option value="duration_desc">{t("sortDurationDesc")}</option>
                <option value="duration_asc">{t("sortDurationAsc")}</option>
                <option value="status_desc">{t("sortStatusDesc")}</option>
                <option value="status_asc">{t("sortStatusAsc")}</option>
                <option value="model_asc">{t("sortModelAsc")}</option>
                <option value="model_desc">{t("sortModelDesc")}</option>
              </select>

              {/* Refresh interval */}
              <div
                className="inline-flex h-8 items-center gap-0.5 rounded-control border border-border bg-surface px-1"
                title={t("refreshIntervalSeconds")}
              >
                <span
                  className="material-symbols-outlined px-1 text-[16px] text-text-muted"
                  aria-hidden="true"
                >
                  timer
                </span>
                <button
                  onClick={() => updateRefreshIntervalSec((v) => v - 1)}
                  className="flex size-6 items-center justify-center rounded-md text-sm font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
                  title={t("decreaseInterval")}
                  aria-label={t("decreaseInterval")}
                >
                  −
                </button>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={refreshIntervalSec}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) updateRefreshIntervalSec(v);
                  }}
                  className="w-10 bg-transparent text-center text-xs tabular-nums text-text-main focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  title={t("refreshIntervalSeconds")}
                  aria-label={t("refreshIntervalSeconds")}
                />
                <button
                  onClick={() => updateRefreshIntervalSec((v) => v + 1)}
                  className="flex size-6 items-center justify-center rounded-md text-sm font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main"
                  title={t("increaseInterval")}
                  aria-label={t("increaseInterval")}
                >
                  +
                </button>
                <span className="pe-1 text-xs text-text-muted">s</span>
              </div>

              {/* Pipeline payload capture */}
              <button
                onClick={toggleDetailLogging}
                disabled={detailLoggingLoading}
                className={`inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-control border px-3 text-sm font-medium transition-colors disabled:opacity-60 ${
                  detailLoggingEnabled
                    ? "border-warning/30 bg-warning/10 text-warning"
                    : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
                }`}
                title={t("capturePipeline")}
              >
                <span
                  className={`size-2 rounded-full ${detailLoggingEnabled ? "bg-warning" : "bg-text-muted"}`}
                  aria-hidden="true"
                />
                {detailLoggingLoading
                  ? t("updatingPipelineLogs")
                  : detailLoggingEnabled
                    ? t("pipelineLogsOn")
                    : t("pipelineLogsOff")}
              </button>
            </div>
          </div>
        )}

        {/* Provider quick filters (from data): always visible, the most used filter */}
        {uniqueProviders.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {uniqueProviders.map((p) => {
              const compatLabel = getProviderDisplayLabel(p, providerNodes);
              const displayLabel = compatLabel || PROVIDER_COLORS[p]?.label || p.toUpperCase();
              const isActive = selectedProvider === p;
              return (
                <button
                  key={p}
                  onClick={() => setSelectedProvider(isActive ? "" : p)}
                  className={`inline-flex h-7 max-w-[220px] items-center truncate rounded-full border px-3 text-xs font-medium transition-colors ${
                    isActive
                      ? "border-primary/30 bg-primary/10 text-primary-text"
                      : "border-border bg-surface text-text-muted hover:bg-surface-2 hover:text-text-main"
                  }`}
                  title={displayLabel}
                >
                  {displayLabel}
                </button>
              );
            })}
          </div>
        )}
        {/* Pipeline capture is on: keep it visible even when filters are closed */}
        {!showFilters && detailLoggingEnabled && (
          <div className="-mt-2 flex items-center gap-2 text-xs text-warning">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
            {t("pipelineLogsOn")}
          </div>
        )}

        {/* Counters: one quiet line */}
        <div className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted tabular-nums">
          <span>
            <span className="font-medium text-text-main">{totalCount}</span> {t("total")}
          </span>
          {runningCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-warning">{runningCount} running</span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>
            <span className="font-medium text-text-main">{okCount}</span> {t("ok")}
          </span>
          {errorCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-error">
                <span className="font-medium">{errorCount}</span> {t("err")}
              </span>
            </>
          )}
          {comboCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                <span className="font-medium text-text-main">{comboCount}</span> {t("combo")}
              </span>
            </>
          )}
          {apiKeyCount > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                <span className="font-medium text-text-main">{apiKeyCount}</span> {t("keys")}
              </span>
            </>
          )}
          <span aria-hidden="true">·</span>
          <span>
            <span className="font-medium text-text-main">{sortedLogs.length}</span> {t("shown")}
          </span>
        </div>

        {/* Table */}
        <Card padding="none" className="min-h-[460px] resize-y overflow-auto bg-surface">
          <div
            ref={scrollContainerRef}
            className="p-0 overflow-x-auto overflow-y-auto h-full min-h-[460px]"
          >
            {loading && logs.length === 0 ? (
              <div className="p-8 text-center text-text-muted">{t("loadingLogs")}</div>
            ) : logs.length === 0 ? (
              <EmptyState icon="receipt_long" title={t("noLogs")} />
            ) : sortedLogs.length === 0 ? (
              <EmptyState icon="filter_alt_off" title={t("noMatchingLogs")} />
            ) : (
              <table className={LOG_TABLE_CLASS}>
                <thead className={LOG_TABLE_HEAD_CLASS} style={LOG_TABLE_HEADER_BG_STYLE}>
                  <tr className={LOG_TABLE_ROW_CLASS} style={LOG_TABLE_HEADER_BG_STYLE}>
                    {visibleColumns.status && (
                      <th
                        className={`${LOG_TABLE_HEADER_CELL_CLASS} cursor-pointer select-none`}
                        onClick={() => toggleSort("status")}
                      >
                        {t("columns.status")}
                        {getSortIndicator("status")}
                      </th>
                    )}
                    {visibleColumns.cacheSource && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.cacheSource")}</th>
                    )}
                    {visibleColumns.model && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.model")}</th>
                    )}
                    {visibleColumns.requestedModel && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.requested")}</th>
                    )}
                    {visibleColumns.provider && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.provider")}</th>
                    )}
                    {visibleColumns.protocol && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.protocol")}</th>
                    )}
                    {visibleColumns.account && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.account")}</th>
                    )}
                    {visibleColumns.apiKey && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.apiKey")}</th>
                    )}
                    {visibleColumns.combo && (
                      <th className={LOG_TABLE_HEADER_CELL_CLASS}>{t("columns.combo")}</th>
                    )}
                    {visibleColumns.tokens && (
                      <th
                        className={`${LOG_TABLE_HEADER_CELL_RIGHT_CLASS} cursor-pointer select-none`}
                        onClick={() => toggleSort("tokens")}
                      >
                        {t("columns.tokens")}
                        {getSortIndicator("tokens")}
                      </th>
                    )}
                    {visibleColumns.tps && (
                      <th
                        className={`${LOG_TABLE_HEADER_CELL_RIGHT_CLASS} cursor-pointer select-none`}
                        onClick={() => toggleSort("tps")}
                      >
                        {t("columns.tps")}
                        {getSortIndicator("tps")}
                      </th>
                    )}
                    {visibleColumns.duration && (
                      <th
                        className={`${LOG_TABLE_HEADER_CELL_RIGHT_CLASS} cursor-pointer select-none`}
                        onClick={() => toggleSort("duration")}
                      >
                        {t("columns.duration")}
                        {getSortIndicator("duration")}
                      </th>
                    )}
                    {visibleColumns.time && (
                      <th
                        className={`${LOG_TABLE_HEADER_CELL_RIGHT_CLASS} cursor-pointer select-none`}
                        onClick={() => toggleSort("time")}
                      >
                        {t("columns.time")}
                        {getSortIndicator("time")}
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30">
                  {groupedLogs.map((log) => {
                    const isActive = log.active === true;
                    const protocolKey = isActive ? null : log.sourceFormat || log.provider;
                    const protocol = protocolKey
                      ? getProtocolColor(protocolKey, log.provider)
                      : null;
                    const compatLabel = getProviderDisplayLabel(log.provider, providerNodes);
                    const providerLabel =
                      log.providerDisplay ||
                      compatLabel ||
                      PROVIDER_COLORS[log.provider]?.label ||
                      (log.provider || "-").toUpperCase();
                    const isError = !isActive && log.status >= 400;
                    const cacheSourceMeta = getCacheSourceMeta(log.cacheSource);
                    const isSemanticCache = cacheSourceMeta?.key === "semantic";
                    const accountLabel = maskAccount(log.account, emailsVisible);

                    return (
                      <tr
                        key={log.id}
                        onClick={() => openDetail(log)}
                        data-cid={log.correlationId || undefined}
                        onMouseEnter={() => log.correlationId && setHoveredCid(log.correlationId)}
                        onMouseLeave={() => setHoveredCid(null)}
                        className={
                          `cursor-pointer transition-colors ` +
                          `${isError ? "bg-error/5 hover:bg-error/15" : "hover:bg-primary/10"} ` +
                          `${log.isRetry ? "border-l-2 border-l-amber-500/50" : ""} ` +
                          `${hoveredCid && log.correlationId === hoveredCid ? "bg-primary/10 ring-1 ring-primary/20" : ""}`
                        }
                        style={
                          log.isRetry
                            ? {
                                backgroundColor:
                                  hoveredCid && log.correlationId === hoveredCid
                                    ? undefined
                                    : "rgba(245,158,11,0.03)",
                              }
                            : undefined
                        }
                      >
                        {visibleColumns.status && (
                          <td className="px-3 py-2">
                            {isActive ? (
                              <span
                                className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-warning/15 border border-warning/25"
                                title="In progress"
                              >
                                <span className="inline-block h-3 w-3 rounded-full border-2 border-warning border-t-transparent animate-spin" />
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                <span
                                  className={`inline-block min-w-[36px] rounded-control border px-2 py-0.5 text-center text-[11px] font-medium tabular-nums ${getStatusBadgeClass(log.status)}`}
                                >
                                  {log.status || "..."}
                                </span>
                                {log.groupStatus === "healed" &&
                                  !log.isRetry &&
                                  log.status >= 400 && (
                                    <span
                                      className="text-success text-[11px]"
                                      title="Recovered by retry"
                                    >
                                      ✓
                                    </span>
                                  )}
                                {log.isRetry && (
                                  <button
                                    className="inline-flex items-center text-warning hover:text-warning text-[11px] ml-0.5"
                                    title={t("goToParentRequest")}
                                    aria-label={t("goToParentRequest")}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const parent = groupedLogs.find(
                                        (g) => g.correlationId === log.correlationId && !g.isRetry
                                      );
                                      if (parent) openDetail(parent);
                                    }}
                                  >
                                    ↳
                                  </button>
                                )}
                              </span>
                            )}
                          </td>
                        )}
                        {visibleColumns.cacheSource && (
                          <td className="px-3 py-2">
                            {isActive ? (
                              <span className="text-text-muted text-[10px]">—</span>
                            ) : (
                              <span
                                className={`inline-block px-2 py-0.5 rounded-control text-[11px] font-medium ${cacheSourceMeta?.className || ""}`}
                                title={
                                  isSemanticCache ? t("semanticCacheHit") : t("upstreamResponse")
                                }
                              >
                                {isSemanticCache ? t("semantic") : t("upstream")}
                              </span>
                            )}
                          </td>
                        )}
                        {visibleColumns.model && (
                          <td className="px-3 py-2 font-medium text-text-main font-mono text-[11px]">
                            <div className="flex items-center gap-1.5">
                              <span>{log.model}</span>
                              {log.groupStatus === "healed" && !log.isRetry && (
                                <span
                                  className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[11px] font-medium bg-success/15 text-success border border-success/25"
                                  title={`Failed, recovered after ${log.groupSize - 1} retry`}
                                >
                                  healed
                                </span>
                              )}
                              {log.groupStatus === "failed" && !log.isRetry && (
                                <span
                                  className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[11px] font-medium bg-error/15 text-error border border-error/25"
                                  title={`All ${log.groupSize} attempts failed`}
                                >
                                  failed
                                </span>
                              )}
                              {log.modelPinned && (
                                <span
                                  className="inline-flex items-center gap-0.5 px-1 py-0 rounded text-[11px] font-medium bg-primary/15 text-primary-text border border-primary/25"
                                  title="Model selected via context-cache session pinning"
                                >
                                  pinned
                                </span>
                              )}
                            </div>
                            {log.correlationId && !log.isRetry && log.groupSize > 1 && (
                              <div
                                className="text-[10px] text-text-muted font-normal truncate max-w-[120px]"
                                title={log.correlationId}
                              >
                                {log.correlationId.slice(0, 12)}… · {log.groupSize} attempts
                              </div>
                            )}
                            {log.correlationId && !log.isRetry && log.groupSize <= 1 && (
                              <div
                                className="text-[10px] text-text-muted font-normal truncate max-w-[120px]"
                                title={log.correlationId}
                              >
                                {log.correlationId.slice(0, 12)}…
                              </div>
                            )}
                            {log.correlationId && log.isRetry && (
                              <div
                                className="text-[10px] text-warning font-normal truncate max-w-[120px]"
                                title={log.correlationId}
                              >
                                {log.correlationId.slice(0, 12)}…
                              </div>
                            )}
                          </td>
                        )}
                        {visibleColumns.requestedModel && (
                          <td className="px-3 py-2 font-mono text-[11px]">
                            {log.requestedModel ? (
                              <span
                                className={
                                  log.requestedModel !== log.model
                                    ? "text-warning"
                                    : "text-text-muted"
                                }
                                title={
                                  log.requestedModel !== log.model
                                    ? t("requestedRoutedTitle", {
                                        requested: log.requestedModel,
                                        routed: log.model,
                                      })
                                    : log.requestedModel
                                }
                              >
                                {log.requestedModel}
                              </span>
                            ) : (
                              <span className="text-text-muted text-[10px]">—</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.provider && (
                          <td className="px-3 py-2">
                            <span
                              className="inline-block max-w-[160px] truncate rounded-control border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-main"
                              title={providerLabel}
                            >
                              {providerLabel}
                            </span>
                          </td>
                        )}
                        {visibleColumns.protocol && (
                          <td className="px-3 py-2">
                            {isActive ? (
                              <span className="text-text-muted text-[10px]">—</span>
                            ) : (
                              <span className="inline-block rounded-control border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-muted">
                                {protocol?.label || "—"}
                              </span>
                            )}
                          </td>
                        )}
                        {visibleColumns.account && (
                          <td
                            className="px-3 py-2 text-text-muted truncate max-w-[120px]"
                            title={accountLabel}
                          >
                            {accountLabel}
                          </td>
                        )}
                        {visibleColumns.apiKey && (
                          <td
                            className="px-3 py-2 text-text-muted truncate max-w-[140px]"
                            title={log.apiKeyName || log.apiKeyId || t("noApiKey")}
                          >
                            {isActive ? (
                              <span className="text-text-muted text-[10px]">—</span>
                            ) : (
                              formatApiKeyLabel(log.apiKeyName, log.apiKeyId)
                            )}
                          </td>
                        )}
                        {visibleColumns.combo && (
                          <td className="px-3 py-2">
                            {isActive ? (
                              <span className="text-text-muted text-[10px]">—</span>
                            ) : log.comboName ? (
                              <span
                                className="inline-block max-w-[160px] truncate rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary-text"
                                title={log.comboName}
                              >
                                {log.comboName}
                              </span>
                            ) : (
                              <span className="text-text-muted text-[10px]">—</span>
                            )}
                          </td>
                        )}
                        {visibleColumns.tokens && (
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {isActive ? (
                              <span className="text-text-muted text-[10px]">—</span>
                            ) : (
                              <>
                                <span className="text-text-muted">TI:</span>{" "}
                                <span className="text-text-main">
                                  {log.tokens?.in?.toLocaleString() || 0}
                                </span>
                                <span className="mx-1 text-border">|</span>
                                <span className="text-text-muted">TO:</span>{" "}
                                <span className="text-text-main">
                                  {log.tokens?.out?.toLocaleString() || 0}
                                </span>
                                {log.tokens?.compressed != null && log.tokens.compressed > 0 && (
                                  <>
                                    <span className="mx-1 text-border">|</span>
                                    <span
                                      className="text-text-muted font-medium"
                                      title={`${log.tokens.compressed.toLocaleString()} tokens compressed`}
                                    >
                                      ↓{log.tokens.compressed.toLocaleString()}
                                    </span>
                                  </>
                                )}
                              </>
                            )}
                          </td>
                        )}
                        {visibleColumns.tps && (
                          <td className="px-3 py-2 text-right whitespace-nowrap font-mono">
                            {isActive ? (
                              <span className="text-text-muted text-[10px]">—</span>
                            ) : (
                              (() => {
                                const tps = getLogTps(log);
                                const color = tps <= 0 ? "text-text-muted" : "text-text-main";
                                return (
                                  <span className={color} title={`${tps.toFixed(2)} tokens/sec`}>
                                    {formatTps(tps)}
                                  </span>
                                );
                              })()
                            )}
                          </td>
                        )}
                        {visibleColumns.duration && (
                          <td className="px-3 py-2 text-right text-text-main tabular-nums">
                            {formatDuration(log.duration)}
                          </td>
                        )}
                        {visibleColumns.time && (
                          <td className="px-3 py-2 text-right text-text-muted">
                            {formatTime(log.timestamp)}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {hasMore && sortedLogs.length > 0 && (
              <div
                ref={loadMoreSentinelRef}
                className="flex justify-center py-3 border-t border-border/30"
              >
                <button
                  type="button"
                  onClick={loadMore}
                  className="h-7 rounded-control border border-border bg-surface px-3 text-xs font-medium text-text-main transition-colors hover:bg-surface-2"
                >
                  {loading ? t("loadingMore") : t("loadMore")}
                </button>
              </div>
            )}
          </div>
        </Card>

        <div className="text-xs text-text-muted">
          {t("callLogsInfo", {
            dataDir: "{DATA_DIR}/call_logs/",
            retentionDays: "CALL_LOG_RETENTION_DAYS",
            maxEntries: "CALL_LOG_MAX_ENTRIES",
          })}
        </div>

        {/* Detail Modal */}
        {selectedLog && (
          <RequestLoggerDetail
            log={selectedLog}
            detail={detailData}
            loading={detailLoading}
            debugEnabled={selectedLog.active ? true : detailLoggingEnabled}
            emailsVisible={emailsVisible}
            onClose={closeDetail}
            onCopy={copyToClipboard}
            onPrevious={handlePrev}
            onNext={handleNext}
            relatedLogs={
              selectedLog.correlationId
                ? groupedLogs.filter((l) => l.correlationId === selectedLog.correlationId)
                : []
            }
            onSelectRelated={(r) => {
              closeDetail();
              openDetail(r);
            }}
          />
        )}
      </div>
    );
  }
);

RequestLoggerV2.displayName = "RequestLoggerV2";

export default RequestLoggerV2;
