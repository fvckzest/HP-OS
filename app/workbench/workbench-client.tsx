"use client";

<<<<<<< HEAD
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { foundationWorkflow } from "@/src/workbench/catalog";
import { customEndpoint, explorerDomains, explorerEndpoints, type ExplorerEndpoint, type ExplorerField } from "@/src/workbench/explorer";
=======
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { foundationWorkflow, siteAccessWorkflow } from "@/src/workbench/catalog";
>>>>>>> 1d4ea0d9d27bcceb3f95e80d32223a521db91e59
import type { HistoryRecord, RequestExecution } from "@/src/workbench/types";

interface WorkbenchStatus {
  application: { state: string; capability: string };
  access: { state: string; origin: string };
  database: { ready: boolean; database: string | null; target: string; marker: string | null; message: string };
  generatedDatabaseApi: { state: string; reason: string };
  hposBusinessApi: { state: string; reason: string; siteKeyConfigured: boolean };
  lmnlIntegration: { state: string; reason: string };
  environment: string;
  dataset: string;
  revision: string;
  catalogue: Array<{ id: string; title: string; kind: string; availability: string; explanation: string; prerequisite?: string; expectedEvidence: string[]; requestTemplate?: { method: string; path: string; headers: Record<string, string>; body: string; expectedStatus: number } }>;
}

interface HistoryResponse { records: HistoryRecord[]; total: number }
interface SiteAccessCheckResult {
  result: "passed" | "failed";
  message: string;
  evidence: { executionMode: string; fixtureMode: string };
  steps: Array<{
    id: string;
    title: string;
    expected: string;
    statusCode: number | null;
    actual: string;
    request: { method: string; path: string; headers: Record<string, string> };
    observations: Array<{ label: string; source: string; value: string }>;
    executionMode: string;
    fixtureMode: string;
    result: "passed" | "failed";
    capture: "stored" | "incomplete";
  }>;
}

interface SessionValue {
  key: string;
  value: string | number | boolean;
  source: string;
  protected?: boolean;
}

const allEndpoints = [customEndpoint, ...explorerEndpoints];
const defaultHeaders = '{\n  "Accept": "application/json"\n}';

async function readJson<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value ? String(value.error) : "The request could not be completed.";
    throw new Error(message);
  }
  return value as T;
}

function formatValue(value: unknown): string {
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? String(value) : formatted;
}

function replacePathParameter(path: string, id: string, value: string): string {
  return path.replace(`{${id}}`, value ? encodeURIComponent(value) : `{${id}}`);
}

function setQueryParameter(path: string, id: string, value: string): string {
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  if (value) params.set(id, value);
  else params.delete(id);
  const nextQuery = params.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

function coerceBodyValue(id: string, value: string): unknown {
  if (["quantity", "expected_version", "limit", "amount", "source_revision"].includes(id)) {
    const numberValue = Number(value);
    return value && Number.isFinite(numberValue) ? numberValue : value;
  }
  if (["provider_can_take_payment", "provider_checkout_closed", "is_archived", "is_canceled", "can_admit", "requires_verification"].includes(id)) {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (["kinds", "report", "totals"].includes(id)) {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

function setNestedJsonValue(raw: string, id: string, value: string): string {
  let parsed: Record<string, unknown> = {};
  if (raw.trim()) {
    try {
      const candidate: unknown = JSON.parse(raw);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = { ...(candidate as Record<string, unknown>) };
    } catch {
      return raw;
    }
  }
  const segments = id.split(".");
  let target = parsed;
  for (const segment of segments.slice(0, -1)) {
    const existing = target[segment];
    target[segment] = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
    target = target[segment] as Record<string, unknown>;
  }
  if (value) target[segments.at(-1) ?? id] = coerceBodyValue(id, value);
  else delete target[segments.at(-1) ?? id];
  return Object.keys(parsed).length ? JSON.stringify(parsed, null, 2) : "";
}

function isSensitiveKey(key: string): boolean {
  return /token|secret|password|authorization|api[_-]?key|idempotency|email|name|address|phone|qr[_-]?payload/i.test(key);
}

function maskJsonValue(value: unknown, parentKey?: string): unknown {
  if (parentKey && isSensitiveKey(parentKey)) return "[masked]";
  if (Array.isArray(value)) return value.map((item) => maskJsonValue(item, parentKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, maskJsonValue(nested, key)]));
  }
  return value;
}

function maskJsonForDisplay(raw: string): string {
  if (!raw.trim()) return raw;
  try {
    return JSON.stringify(maskJsonValue(JSON.parse(raw)), null, 2) ?? raw;
  } catch {
    return raw.replace(/((?:["']?)[\w-]*(?:token|email|secret|password|authorization|api[_-]?key|idempotency)[\w-]*(?:["']?\s*:\s*))(["'])(?:\\.|(?!\2).)*\2/gi, '$1"[masked]"');
  }
}

function mergeMaskedJsonValues(displayValue: unknown, previousValue: unknown, parentKey?: string): unknown {
  if (displayValue === "[masked]" && parentKey && isSensitiveKey(parentKey)) return previousValue;
  if (Array.isArray(displayValue)) {
    const previousArray = Array.isArray(previousValue) ? previousValue : [];
    return displayValue.map((item, index) => mergeMaskedJsonValues(item, previousArray[index], parentKey));
  }
  if (displayValue && typeof displayValue === "object" && !Array.isArray(displayValue)) {
    const previousObject = previousValue && typeof previousValue === "object" && !Array.isArray(previousValue) ? previousValue as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(displayValue).map(([key, nested]) => [key, mergeMaskedJsonValues(nested, previousObject[key], key)]));
  }
  return displayValue;
}

function unmaskJsonEdit(display: string, previousRaw: string): string {
  try {
    const displayValue = JSON.parse(display);
    let previousValue: unknown = null;
    try { previousValue = previousRaw.trim() ? JSON.parse(previousRaw) : null; } catch { /* Keep the new edit when the previous body was already invalid. */ }
    return JSON.stringify(mergeMaskedJsonValues(displayValue, previousValue), null, 2);
  } catch {
    return display;
  }
}

function maskPathForDisplay(rawPath: string, endpoint: ExplorerEndpoint): string {
  const [pathname, query] = rawPath.split("?", 2);
  const actualSegments = pathname.split("/");
  const matchingDocumentedEndpoint = endpoint.id === customEndpoint.id
    ? explorerEndpoints.find((candidate) => {
      const candidateSegments = candidate.path.split("?", 1)[0].split("/");
      return candidateSegments.length === actualSegments.length && candidateSegments.every((segment, index) => segment.startsWith("{") || segment === actualSegments[index]);
    })
    : endpoint;
  const templateSegments = matchingDocumentedEndpoint?.path.split("?", 1)[0].split("/") ?? [];
  if (matchingDocumentedEndpoint) matchingDocumentedEndpoint.fields.filter((field) => field.kind === "path" && field.protected).forEach((field) => {
    const index = templateSegments.findIndex((segment) => segment === `{${field.id}}`);
    if (index >= 0 && actualSegments[index] && actualSegments[index] !== `{${field.id}}`) actualSegments[index] = "[masked]";
  });
  const maskedQuery: string[][] | undefined = query === undefined ? undefined : [...new URLSearchParams(query).entries()].map(([key, value]) => [key, /token|email|secret|password|authorization|api[_-]?key|idempotency/i.test(key) ? "[masked]" : value]);
  if (maskedQuery === undefined) return actualSegments.join("/");
  const queryText = new URLSearchParams(maskedQuery).toString();
  return `${actualSegments.join("/")}?${queryText}`;
}

function unmaskPathEdit(displayPath: string, previousRawPath: string, endpoint: ExplorerEndpoint): string {
  const [displayPathname, displayQuery] = displayPath.split("?", 2);
  const [previousPathname, previousQuery = ""] = previousRawPath.split("?", 2);
  const displaySegments = displayPathname.split("/");
  const previousSegments = previousPathname.split("/");
  displaySegments.forEach((segment, index) => {
    if (segment === "[masked]" && previousSegments[index]) displaySegments[index] = previousSegments[index];
  });
  if (displayQuery === undefined) return displaySegments.join("/");
  const displayParams = new URLSearchParams(displayQuery);
  const previousParams = new URLSearchParams(previousQuery);
  for (const [key, value] of displayParams.entries()) if (value === "[masked]" && previousParams.has(key)) displayParams.set(key, previousParams.get(key) ?? value);
  return `${displaySegments.join("/")}?${displayParams.toString()}`;
}

function readNestedJsonValue(value: unknown, id: string): unknown {
  return id.split(".").reduce<unknown>((current, segment) => current && typeof current === "object" ? (current as Record<string, unknown>)[segment] : undefined, value);
}

function syncRepresentableFields(endpoint: ExplorerEndpoint, nextPath: string, nextBody: string): { values: Record<string, string>; warnings: Record<string, string>; message: string } {
  if (endpoint.id === customEndpoint.id) return { values: {}, warnings: {}, message: "" };
  const values: Record<string, string> = {};
  const warnings: Record<string, string> = {};
  const [pathname, query = ""] = nextPath.split("?", 2);
  const actualSegments = pathname.split("/");
  const templateSegments = endpoint.path.split("?", 1)[0].split("/");
  const pathMatches = actualSegments.length === templateSegments.length && templateSegments.every((segment, index) => segment.startsWith("{") || segment === actualSegments[index]);
  endpoint.fields.filter((field) => field.kind === "path").forEach((field) => {
    const index = templateSegments.findIndex((segment) => segment === `{${field.id}}`);
    if (!pathMatches || index < 0) warnings[field.id] = "Unavailable while the raw path does not match this endpoint.";
    else if (actualSegments[index] && actualSegments[index] !== `{${field.id}}` && actualSegments[index] !== "[masked]") {
      try { values[field.id] = decodeURIComponent(actualSegments[index]); } catch { warnings[field.id] = "Unavailable because this path value is not URL encoded correctly."; }
    }
  });
  const params = new URLSearchParams(query);
  endpoint.fields.filter((field) => field.kind === "query").forEach((field) => {
    const value = params.get(field.id);
    if (value !== null) values[field.id] = value;
  });
  const bodyFields = endpoint.fields.filter((field) => field.kind === "body");
  if (bodyFields.length && nextBody.trim()) {
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(nextBody); } catch { parsedBody = null; }
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      bodyFields.forEach((field) => { warnings[field.id] = "Unavailable while the raw body is not a JSON object."; });
    } else {
      bodyFields.forEach((field) => {
        const value = readNestedJsonValue(parsedBody, field.id);
        if (value !== undefined) values[field.id] = typeof value === "string" ? value : JSON.stringify(value);
      });
    }
  }
  const message = Object.keys(warnings).length ? "Some named inputs are unavailable because the raw request no longer matches the selected endpoint. Repair the raw details or use the Custom /v1 request mode." : "";
  return { values, warnings, message };
}

function collectSessionValues(value: unknown, source: string, parentKey?: string): SessionValue[] {
  if (Array.isArray(value)) return value.flatMap((item) => collectSessionValues(item, source, parentKey));
  if (!value || typeof value !== "object") {
    if (parentKey && (typeof value === "string" || typeof value === "number" || typeof value === "boolean") && !String(value).startsWith("[REDACTED")) {
      return [{ key: parentKey, value, source, protected: isSensitiveKey(parentKey) }];
    }
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => collectSessionValues(nested, source, key));
}

function matchingValues(field: ExplorerField, values: SessionValue[]): SessionValue[] {
  const keys = new Set([field.id, ...(field.aliases ?? [])]);
  return values.filter((value) => keys.has(value.key));
}

export default function WorkbenchClient() {
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyCount, setHistoryCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [requestError, setRequestError] = useState("");
  const [execution, setExecution] = useState<RequestExecution | null>(null);
  const [siteAccessResult, setSiteAccessResult] = useState<SiteAccessCheckResult | null>(null);
  const [siteAccessRunning, setSiteAccessRunning] = useState(false);
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("");
  const [headers, setHeaders] = useState(defaultHeaders);
  const [body, setBody] = useState("");
  const [expectedStatus, setExpectedStatus] = useState("");
<<<<<<< HEAD
  const [pathDetailsDraft, setPathDetailsDraft] = useState("");
  const [headersDetailsDraft, setHeadersDetailsDraft] = useState(defaultHeaders);
  const [bodyDetailsDraft, setBodyDetailsDraft] = useState("");
  const [requestDetailsOpen, setRequestDetailsOpen] = useState(true);
  const [selectedEndpointId, setSelectedEndpointId] = useState(customEndpoint.id);
  const [searchTerm, setSearchTerm] = useState("");
  const [hoveredFieldId, setHoveredFieldId] = useState<string | null>(null);
  const [clickedFieldId, setClickedFieldId] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [fieldWarnings, setFieldWarnings] = useState<Record<string, string>>({});
  const [requestMismatchMessage, setRequestMismatchMessage] = useState("");
  const [sessionValues, setSessionValues] = useState<SessionValue[]>([]);

  const selectedEndpoint = useMemo<ExplorerEndpoint>(() => allEndpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? customEndpoint, [selectedEndpointId]);
  const filteredEndpoints = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return explorerEndpoints;
    return explorerEndpoints.filter((endpoint) => `${endpoint.title} ${endpoint.method} ${endpoint.path} ${endpoint.domain}`.toLowerCase().includes(query));
  }, [searchTerm]);
  const groupedEndpoints = useMemo(() => explorerDomains.map((domain) => ({ domain, endpoints: filteredEndpoints.filter((endpoint) => endpoint.domain === domain) })).filter((group) => group.endpoints.length > 0), [filteredEndpoints]);
  const activeFieldId = hoveredFieldId ?? clickedFieldId;
  const activeField = selectedEndpoint.fields.find((field) => field.id === activeFieldId) ?? null;
  const relevantValues = selectedEndpoint.fields.flatMap((field) => matchingValues(field, sessionValues).map((value) => ({ field, value })));
=======
  const siteAccessCapability = status?.catalogue.find((entry) => entry.id === "site-payment-configuration");
  const siteAccessReady = Boolean(status?.database.ready
    && status.hposBusinessApi.state === "available"
    && siteAccessCapability?.availability === "available");
  const siteAccessBlockReason = status && !siteAccessReady
    ? !status.database.ready ? status.database.message : siteAccessCapability?.prerequisite ?? status.hposBusinessApi.reason
    : "";
>>>>>>> 1d4ea0d9d27bcceb3f95e80d32223a521db91e59

  const refreshStatus = useCallback(async () => {
    const response = await fetch("/api/workbench/status", { cache: "no-store" });
    const nextStatus = await readJson<WorkbenchStatus>(response);
    setStatus(nextStatus);
    return nextStatus;
  }, []);

  const refreshHistory = useCallback(async () => {
    const response = await fetch("/api/workbench/history", { cache: "no-store" });
    const nextHistory = await readJson<HistoryResponse>(response);
    setHistory(nextHistory.records);
    setHistoryCount(nextHistory.total);
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const [nextStatus] = await Promise.all([refreshStatus(), refreshHistory()]);
      setMessage(nextStatus.database.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Local workbench status is unavailable.");
    } finally {
      setLoading(false);
    }
  }, [refreshHistory, refreshStatus]);

  useEffect(() => { void refreshAll(); }, [refreshAll]);

  const setNamedFieldValue = useCallback((field: ExplorerField, value: string) => {
    setFieldValues((previous) => ({ ...previous, [field.id]: value }));
    setFieldWarnings((previous) => {
      const next = { ...previous };
      delete next[field.id];
      return next;
    });
    setRequestMismatchMessage(selectedEndpoint.id !== customEndpoint.id && method !== selectedEndpoint.method
      ? "The raw method differs from the selected endpoint. Named inputs remain visible, but this request is customized."
      : "");
    if (field.kind === "path") setPath((previous) => {
      const next = replacePathParameter(previous, field.id, value);
      setPathDetailsDraft(maskPathForDisplay(next, selectedEndpoint));
      return next;
    });
    if (field.kind === "query") setPath((previous) => {
      const next = setQueryParameter(previous, field.id, value);
      setPathDetailsDraft(maskPathForDisplay(next, selectedEndpoint));
      return next;
    });
    if (field.kind === "body") setBody((previous) => {
      const next = setNestedJsonValue(previous, field.id, value);
      setBodyDetailsDraft(maskJsonForDisplay(next));
      return next;
    });
  }, [method, selectedEndpoint]);

  useEffect(() => {
    if (selectedEndpoint.id === customEndpoint.id) return;
    for (const field of selectedEndpoint.fields) {
      if (fieldValues[field.id]) continue;
      const matches = matchingValues(field, sessionValues);
      if (matches.length === 1) setNamedFieldValue(field, String(matches[0].value));
    }
  }, [fieldValues, selectedEndpoint, sessionValues, setNamedFieldValue]);

  function selectEndpoint(endpoint: ExplorerEndpoint) {
    setSelectedEndpointId(endpoint.id);
    setHoveredFieldId(null);
    setClickedFieldId(null);
    setFieldValues({});
    setFieldWarnings({});
    setRequestMismatchMessage("");
    setMethod(endpoint.method);
    setPath(endpoint.path);
    setPathDetailsDraft(maskPathForDisplay(endpoint.path, endpoint));
    setHeaders(defaultHeaders);
    setHeadersDetailsDraft(defaultHeaders);
    setBody("");
    setBodyDetailsDraft("");
    setExpectedStatus("");
    setRequestDetailsOpen(endpoint.id === customEndpoint.id);
    setRequestError("");
    setExecution(null);
  }

  function applyRawFieldSync(nextPath: string, nextBody: string) {
    const synced = syncRepresentableFields(selectedEndpoint, nextPath, nextBody);
    setFieldValues(synced.values);
    setFieldWarnings(synced.warnings);
    setRequestMismatchMessage(synced.message || (selectedEndpoint.id !== customEndpoint.id && method !== selectedEndpoint.method
      ? "The raw method differs from the selected endpoint. Named inputs remain visible, but this request is customized."
      : ""));
  }

  function handleRawMethodChange(nextMethod: string) {
    setMethod(nextMethod);
    setRequestMismatchMessage(selectedEndpoint.id !== customEndpoint.id && nextMethod !== selectedEndpoint.method
      ? "The raw method differs from the selected endpoint. Named inputs remain visible, but this request is customized."
      : "");
  }

  function handleRawPathChange(nextDisplayPath: string) {
    const nextPath = unmaskPathEdit(nextDisplayPath, path, selectedEndpoint);
    setPath(nextPath);
    setPathDetailsDraft(maskPathForDisplay(nextPath, selectedEndpoint));
    applyRawFieldSync(nextPath, body);
  }

  function handleRawHeadersChange(nextDisplayHeaders: string) {
    setHeadersDetailsDraft(nextDisplayHeaders);
    const nextHeaders = unmaskJsonEdit(nextDisplayHeaders, headers);
    setHeaders(nextHeaders);
    if (nextHeaders !== nextDisplayHeaders) setHeadersDetailsDraft(maskJsonForDisplay(nextHeaders));
  }

  function handleRawBodyChange(nextDisplayBody: string) {
    setBodyDetailsDraft(nextDisplayBody);
    const nextBody = unmaskJsonEdit(nextDisplayBody, body);
    setBody(nextBody);
    if (nextBody !== nextDisplayBody) setBodyDetailsDraft(maskJsonForDisplay(nextBody));
    applyRawFieldSync(path, nextBody);
  }

  async function runFoundationCheck() {
    setMessage("Checking local services and the PostgreSQL marker…");
    try {
      const nextStatus = await refreshStatus();
      const passed = nextStatus.application.state === "ready" && nextStatus.database.ready && nextStatus.access.state === "loopback-only";
      setMessage(passed ? "Passed: local foundation is ready. This check did not create business records." : `Blocked: ${nextStatus.database.message}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The local foundation check could not complete.");
    }
  }

  async function runSiteAccessCheck() {
    setSiteAccessRunning(true);
    setSiteAccessResult(null);
    setMessage("Running Site access and configuration checks through the HTTP API…");
    try {
      const response = await fetch("/api/workbench/site-access-check", { method: "POST" });
      const result = await readJson<SiteAccessCheckResult>(response);
      setSiteAccessResult(result);
      setMessage(result.message);
      await Promise.all([refreshHistory(), refreshStatus()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The Site access check could not complete.");
    } finally {
      setSiteAccessRunning(false);
    }
  }

  async function runRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError("");
    setExecution(null);
    let parsedHeaders: unknown;
    try { parsedHeaders = JSON.parse(headers); }
    catch { setRequestError("Headers must be valid JSON. Keep the value as a JSON object."); return; }

    try {
      const response = await fetch("/api/workbench/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, path, headers: parsedHeaders, body, expectedStatus: expectedStatus ? Number(expectedStatus) : null }),
      });
      const result = await readJson<RequestExecution>(response);
      setExecution(result);
      const freshValues = collectSessionValues(result.response, result.route);
      if (freshValues.length) setSessionValues((previous) => [...freshValues, ...previous].slice(0, 100));
      setMessage(result.id
        ? result.capture === "stored"
          ? "Request result was recorded in local PostgreSQL."
          : "Request result was recorded; omitted or truncated evidence is marked in history."
        : "The request result arrived, but history could not be saved. The operation was not retried.");
      await refreshHistory();
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "The request could not be completed.");
    }
  }

  function loadRequestTemplate(template: NonNullable<WorkbenchStatus["catalogue"][number]["requestTemplate"]>) {
    setMethod(template.method);
    setPath(template.path);
    setHeaders(JSON.stringify(template.headers, null, 2));
    setBody(template.body);
    setExpectedStatus(String(template.expectedStatus));
    document.getElementById("request-heading")?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("request-method")?.focus({ preventScroll: true });
    setMessage("Request template loaded. Review or edit it before sending; the configured Site key is added on the server.");
  }

  async function clearHistory() {
    if (!window.confirm("Clear local workbench history? This does not change business records.")) return;
    setMessage("");
    try {
      const response = await fetch("/api/workbench/history", { method: "DELETE" });
      const result = await readJson<{ message: string }>(response);
      setMessage(result.message);
      await refreshHistory();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "History could not be cleared.");
    }
  }

  const canSend = Boolean(status?.database.ready && selectedEndpoint.availability === "available" && path.trim() && Object.keys(fieldWarnings).length === 0);
  const sendDisabledReason = !status
    ? "Waiting for local service status."
    : !status.database.ready
      ? `Send unavailable: local PostgreSQL is not ready. ${status.database.message}`
      : selectedEndpoint.availability !== "available"
        ? "Send unavailable: this documented endpoint has not been implemented."
        : Object.keys(fieldWarnings).length > 0
          ? "Fix the raw request details before sending. Some named inputs cannot be mapped to this endpoint."
          : !path.trim()
            ? "Enter a local /v1 path before sending."
            : "Selection never sends a request. Unknown outcomes are never retried automatically.";

  return (
    <main className="page-shell workbench-page">
      <section className="workbench-status-strip" aria-label="Local service status">
        <div className="status-strip-heading"><span>Local services</span><button className="button-secondary" type="button" onClick={() => void refreshAll()} disabled={loading}>Refresh</button></div>
        {loading && <p className="status-loading">Checking the local application and PostgreSQL…</p>}
        {!loading && !status && <p className="status-blocked">Status unavailable. Check that the local database and application are running.</p>}
        {status && <div className="status-grid">
          <StatusItem label="Application" state={status.application.state} detail={status.application.capability} />
          <StatusItem label="Workbench access" state={status.access.state} detail={`Available only at ${status.access.origin}.`} />
          <StatusItem label="Local PostgreSQL" state={status.database.ready ? "ready" : "blocked"} detail={`${status.database.message} Target: ${status.database.target}.`} />
          <StatusItem label="Generated database API" state={status.generatedDatabaseApi.state} detail={status.generatedDatabaseApi.reason} intentionallyDisabled />
          <StatusItem label="HP-OS business API" state={status.hposBusinessApi.state} detail={`${status.hposBusinessApi.reason} Site API key ${status.hposBusinessApi.siteKeyConfigured ? "is configured on the server" : "is not configured"}.`} />
          <StatusItem label="Local LMNL integration" state={status.lmnlIntegration.state} detail={status.lmnlIntegration.reason} />
        </div>}
        {status && <div className="environment-meta" aria-label="Local dataset details"><span>Environment: {status.environment}</span><span>Dataset: {status.dataset}</span><span>Revision: <code>{status.revision}</code></span></div>}
      </section>

      {message && <p className={`notice workbench-message ${message.startsWith("Blocked") ? "notice-warning" : ""}`} role="status">{message}</p>}

      <section className="explorer-section" aria-labelledby="explorer-heading">
        <aside className="explorer-sidebar" aria-label="API Explorer endpoints">
          <div className="explorer-sidebar-heading"><h2 id="explorer-heading" className="sr-only">API Explorer endpoints</h2><span className="explorer-list-title">Endpoints</span><span>{explorerEndpoints.length} documented</span></div>
          <label className="search-field" htmlFor="endpoint-search"><span>Search endpoints</span><input id="endpoint-search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Name or path" /></label>
          <nav className="endpoint-nav" aria-label="Documented endpoints">
            <button className={`endpoint-item ${selectedEndpoint.id === customEndpoint.id ? "selected" : ""}`} type="button" onClick={() => selectEndpoint(customEndpoint)}><strong>{customEndpoint.title}</strong><code>{customEndpoint.method} /v1/…</code><small>Available</small></button>
            {groupedEndpoints.map((group) => <div className="endpoint-group" key={group.domain}><h3>{group.domain}</h3>{group.endpoints.map((endpoint) => <button className={`endpoint-item ${selectedEndpoint.id === endpoint.id ? "selected" : ""}`} type="button" key={endpoint.id} onClick={() => selectEndpoint(endpoint)}><strong>{endpoint.title}</strong><code>{endpoint.method} {endpoint.path}</code><small>Unavailable · contract only</small></button>)}</div>)}
            {groupedEndpoints.length === 0 && <p className="empty-state">No endpoints match this search.</p>}
          </nav>
        </aside>

        <div className="explorer-console">
          <div className="console-heading"><div><h2>Request console</h2><p>{selectedEndpoint.description}</p></div><span className={`availability-label ${selectedEndpoint.availability}`}>{selectedEndpoint.availability === "available" ? "Available" : "Unavailable"}</span></div>
          {selectedEndpoint.availability === "unavailable" && <p className="endpoint-unavailable">This endpoint is documented in the API contract but is not implemented in the current HP-OS foundation. Select Custom /v1 request to send a local request.</p>}
          {selectedEndpoint.fields.length > 0 && <div className="named-fields"><div className="subheading-row"><h3>Inputs</h3><span>Examples are hints only.</span></div><div className="named-fields-grid">{selectedEndpoint.fields.map((field) => {
            const matches = matchingValues(field, sessionValues);
            const value = fieldValues[field.id] ?? "";
            const source = matches.length === 1 ? matches[0].source : matches.length > 1 ? `${matches.length} current-session matches` : "";
            return <div className={`field named-field ${fieldWarnings[field.id] ? "field-unavailable" : ""}`} key={field.id}><div className="field-label-row"><button type="button" className="glossary-term" title={field.description} onMouseEnter={() => setHoveredFieldId(field.id)} onMouseLeave={() => setHoveredFieldId(null)} onFocus={() => setHoveredFieldId(field.id)} onClick={() => { setHoveredFieldId(field.id); setClickedFieldId(field.id); }}>{field.label}</button><span className="field-kind">{field.kind}</span></div><input type={field.protected ? "password" : "text"} value={value} onChange={(event) => setNamedFieldValue(field, event.target.value)} onFocus={() => setHoveredFieldId(field.id)} placeholder={field.example ?? "Enter a value"} autoComplete="off" disabled={Boolean(fieldWarnings[field.id])} />{(source || field.protected) && <small className="field-source">Source: {source || "entered in this field"}{field.protected ? " · masked" : ""}</small>}{fieldWarnings[field.id] && <small className="field-warning">{fieldWarnings[field.id]}</small>}<small className="field-help">{field.description}</small></div>;
          })}</div></div>}

          <form className="stack request-form" onSubmit={(event) => void runRequest(event)}>
            <details className="request-details" open={requestDetailsOpen} onToggle={(event) => setRequestDetailsOpen((event.currentTarget as HTMLDetailsElement).open)}>
              <summary>Request details</summary>
              <div className="request-controls-grid">
                <div className="field"><label htmlFor="request-method">Method</label><select id="request-method" value={method} onChange={(event) => handleRawMethodChange(event.target.value)}>{["GET", "POST", "PATCH", "PUT", "DELETE"].map((value) => <option key={value}>{value}</option>)}</select></div>
                <div className="field"><label htmlFor="request-path">Path</label><input id="request-path" value={pathDetailsDraft} onChange={(event) => handleRawPathChange(event.target.value)} placeholder="/v1/implemented-route" required /><small className="field-help">Protected path and query values are masked when the route can be classified. Unknown Custom `/v1` routes remain editable and are not classified.</small></div>
                <div className="field"><label htmlFor="expected-status">Expected status <span className="label-optional">Optional</span></label><input id="expected-status" type="number" min="100" max="599" value={expectedStatus} onChange={(event) => setExpectedStatus(event.target.value)} placeholder="Any status" /></div>
              </div>
              <div className="field"><label htmlFor="request-headers">Headers <span className="label-optional">JSON · protected values masked</span></label><textarea className="code-input" id="request-headers" rows={3} value={headersDetailsDraft} onChange={(event) => handleRawHeadersChange(event.target.value)} spellCheck={false} /><small className="field-help">Allowed: Accept, Content-Type, If-Match, If-None-Match, and Idempotency-Key. Protected values stay masked in this editor; sending uses the retained raw value.</small></div>
              <div className="field"><label htmlFor="request-body">Request body <span className="label-optional">JSON · optional · protected values masked</span></label><textarea className="code-input body-input" id="request-body" rows={7} value={bodyDetailsDraft} onChange={(event) => handleRawBodyChange(event.target.value)} spellCheck={false} placeholder="Optional JSON body" /><small className="field-help">Protected values stay masked in this editor; sending uses the retained raw value. Invalid JSON is sent unchanged and omitted from saved history.</small></div>
            </details>
            {requestMismatchMessage && <p className="field-warning" role="status">{requestMismatchMessage}</p>}
            <div className="request-submit-row"><button className="button-primary" type="submit" disabled={!canSend}>Send request</button><span className="field-help">{sendDisabledReason}</span></div>
          </form>
          {requestError && <p className="status-blocked" role="alert">{requestError}</p>}
          {execution && <div className="result-panel stack" aria-live="polite"><h3>Response</h3><div className="result-summary"><p><strong>Outcome</strong>{execution.outcome === "outcome_unknown" ? "Outcome unknown" : `HTTP ${execution.statusCode}`}</p><p><strong>Check</strong>{execution.result.replaceAll("_", " ")}</p><p><strong>History capture</strong>{execution.capture}</p></div>{execution.message && <p className="notice">{execution.message}</p>}{execution.redirectBlocked && <p>A redirect was returned and blocked. The workbench did not follow it.</p>}<details><summary>Response headers</summary><pre className="code-block">{formatValue(execution.responseHeaders)}</pre></details><details open><summary>Response body</summary><pre className="code-block">{formatValue(execution.response)}</pre></details></div>}
        </div>

        <aside className="glossary-panel" aria-label="Glossary and endpoint details">
          <div className="glossary-heading"><span>Glossary</span><span className="glossary-hint">Hover or focus a field</span></div>
          <div className="glossary-content"><h2>{activeField ? activeField.label : selectedEndpoint.title}</h2><p>{activeField ? activeField.description : selectedEndpoint.description}</p>{activeField && clickedFieldId === activeField.id ? <p className="glossary-detail">{activeField.details}</p> : <p className="glossary-detail">Click the term for the full definition and rules.</p>}{!activeField && <p className="glossary-detail">The request is {selectedEndpoint.method} {selectedEndpoint.path || "/v1/…"}. {selectedEndpoint.availability === "unavailable" ? "The documented operation is not implemented yet." : "This manual request mode sends through the existing local workbench boundary."}</p>}</div>
          <details className="available-values"><summary>Available values</summary><p className="field-help">Current session only. Older History entries are not reused automatically.</p>{!activeField && <p className="field-help">Choose or focus a field to see values that can fill it.</p>}{activeField && relevantValues.filter(({ field }) => field.id === activeField.id).length === 0 && <p className="field-help">No current-session value matches this field.</p>}{activeField && relevantValues.filter(({ field }) => field.id === activeField.id).map(({ field, value }, index) => <button className="available-value" type="button" key={`${value.source}-${value.key}-${index}`} onClick={() => setNamedFieldValue(field, String(value.value))}><span>{value.protected || field.protected ? "[masked value]" : String(value.value)}</span><small>From {value.source}</small></button>)}</details>
          <div className="endpoint-summary"><span className="summary-label">Endpoint</span><code>{selectedEndpoint.method} {selectedEndpoint.path || "/v1/…"}</code><span className="summary-label">Status</span><span>{selectedEndpoint.availability === "available" ? "Ready for a local request" : "Documented; implementation pending"}</span></div>
        </aside>
      </section>

<<<<<<< HEAD
      <section className="workbench-section workflows-section" aria-labelledby="workflow-heading"><div className="section-heading"><div><h2 id="workflow-heading">Guided Workflows</h2><p className="section-description">Short local checks stay below the Explorer so the request console remains in place.</p></div></div><div className="workflow-card"><div className="workflow-step-copy"><strong>{foundationWorkflow.title}</strong><p>{foundationWorkflow.explanation} {foundationWorkflow.steps[0].expected}</p></div><button className="button-primary" type="button" onClick={() => void runFoundationCheck()}>Run check</button></div></section>
=======
      <section className="workbench-section" aria-labelledby="site-access-heading">
        <div className="section-heading">
          <h2 id="site-access-heading">{siteAccessWorkflow.title}</h2>
        </div>
        <p className="section-description">{siteAccessWorkflow.explanation}</p>
        <div className="workflow-card">
          {siteAccessWorkflow.steps.map((step) => <div key={step.id} className="workflow-step">
            <div className="workflow-step-copy">
              <strong>{step.title}</strong>
              <p>{step.expected}</p>
            </div>
          </div>)}
          <div className="workflow-step">
            <div className="workflow-step-copy">
              <strong>Run API checks</strong>
              <p>Each request uses generated test keys held only in server memory. No credential is shown in the browser or saved in history.</p>
              {siteAccessBlockReason && <p className="field-help">Blocked: {siteAccessBlockReason}</p>}
            </div>
            <button className="button-primary" type="button" onClick={() => void runSiteAccessCheck()} disabled={!siteAccessReady || siteAccessRunning}>
              {siteAccessRunning ? "Running checks…" : "Run Site access checks"}
            </button>
          </div>
        </div>
        {siteAccessResult && <div className="result-panel stack" aria-live="polite">
          <h3>Site access check: {siteAccessResult.result}</h3>
          <p>Evidence: {siteAccessResult.evidence.executionMode.replaceAll("_", " ")} using {siteAccessResult.evidence.fixtureMode} records.</p>
          <div className="history-list">{siteAccessResult.steps.map((step) => <article key={step.id} className="history-record">
            <div className="history-record-heading"><strong>{step.title}</strong><span>{step.result}</span><span>{step.statusCode === null ? "Outcome unknown" : `HTTP ${step.statusCode}`}</span><span>Capture: {step.capture}</span></div>
            <p><strong>Expected:</strong> {step.expected}</p>
            <p><strong>Observed:</strong> {step.actual}</p>
            <details><summary>Request and observation sources</summary>
              <pre className="code-block">{formatValue(step.request)}</pre>
              <ul>{step.observations.map((observation) => <li key={`${observation.label}-${observation.source}`}><strong>{observation.label}:</strong> {observation.value} · Source: {observation.source}</li>)}</ul>
            </details>
          </article>)}</div>
        </div>}
      </section>

      <section className="workbench-section" aria-labelledby="catalogue-heading">
        <div className="section-heading"><h2 id="catalogue-heading">Capability catalogue</h2></div>
        <div className="status-grid">{(status?.catalogue ?? []).map((entry) => <article key={entry.id} className="status-card">
          <div className="status-card-heading"><strong>{entry.title}</strong><span>{entry.availability}</span></div>
          <p>{entry.explanation}</p>
          {entry.prerequisite && <p className="field-help">Next: {entry.prerequisite}</p>}
          <details><summary>Expected evidence</summary><ul>{entry.expectedEvidence.map((item) => <li key={item}>{item}</li>)}</ul></details>
          {entry.requestTemplate && <div className="stack"><details><summary>Request template</summary><pre className="code-block">{formatValue(entry.requestTemplate)}</pre><p className="field-help">Authorization is added from the server environment and is not shown in the browser.</p></details><button className="button-secondary" type="button" onClick={() => loadRequestTemplate(entry.requestTemplate!)}>Edit this request</button></div>}
        </article>)}</div>
      </section>

      <section className="workbench-section request-section" aria-labelledby="request-heading">
        <div className="section-heading">
          <h2 id="request-heading">HTTP request</h2>
        </div>
        <p className="request-description">Loopback <code>/v1/</code> requests only. Redirects are blocked. Server-side credentials stay on the server.</p>
        <form className="stack" onSubmit={(event) => void runRequest(event)}>
          <div className="request-controls-grid">
            <div className="field"><label htmlFor="request-method">Method</label><select id="request-method" value={method} onChange={(event) => setMethod(event.target.value)}>{["GET", "POST", "PATCH", "PUT", "DELETE"].map((value) => <option key={value}>{value}</option>)}</select></div>
            <div className="field"><label htmlFor="request-path">Path</label><input id="request-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/v1/implemented-route" required /></div>
            <div className="field"><label htmlFor="expected-status">Expected status <span className="label-optional">Optional</span></label><input id="expected-status" type="number" min="100" max="599" value={expectedStatus} onChange={(event) => setExpectedStatus(event.target.value)} placeholder="Any status" /></div>
          </div>
          <div className="field"><label htmlFor="request-headers">Headers <span className="label-optional">JSON</span></label><textarea className="code-input" id="request-headers" rows={3} value={headers} onChange={(event) => setHeaders(event.target.value)} spellCheck={false} /><details className="field-help"><summary>Allowed headers</summary><p>Accept, Content-Type, If-Match, If-None-Match, and Idempotency-Key. Credentials and browser security headers are rejected.</p></details></div>
          <div className="field"><label htmlFor="request-body">Request body <span className="label-optional">JSON · optional</span></label><textarea className="code-input body-input" id="request-body" rows={5} value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} placeholder="Optional JSON body" /><small className="field-help">Invalid JSON is sent unchanged and omitted from saved history.</small></div>
          <div className="request-submit-row"><button className="button-primary" type="submit" disabled={!status?.database.ready}>Send request</button><span className="field-help">Unknown outcomes are never retried automatically.</span></div>
        </form>
        {requestError && <p className="status-blocked" role="alert">{requestError}</p>}
        {execution && <div className="result-panel stack" aria-live="polite">
          <h3>Request result</h3>
          <div className="result-summary">
            <p><strong>Outcome</strong>{execution.outcome === "outcome_unknown" ? "Outcome unknown" : `HTTP ${execution.statusCode}`}</p>
            <p><strong>Check</strong>{execution.result.replaceAll("_", " ")}</p>
            <p><strong>History capture</strong>{execution.capture}</p>
          </div>
          {execution.message && <p className="notice">{execution.message}</p>}
          {execution.redirectBlocked && <p>A redirect was returned and blocked. The workbench did not follow it.</p>}
          <pre className="code-block">{formatValue({ route: execution.route, headers: execution.responseHeaders, response: execution.response })}</pre>
        </div>}
      </section>
>>>>>>> 1d4ea0d9d27bcceb3f95e80d32223a521db91e59

      <section className="workbench-section history-section" aria-labelledby="history-heading"><div className="section-heading history-heading-row"><div><h2 id="history-heading">History</h2><p className="section-description">{history.length} of {historyCount} calls · sanitized and saved locally</p></div><div className="history-actions"><a className="button-secondary button-link" href="/api/workbench/export">Download masked JSON</a><button className="button-secondary" type="button" onClick={() => void clearHistory()}>Clear history</button></div></div>{history.length === 0 && <p className="empty-state">No local calls have been recorded yet.</p>}<div className="history-list">{history.map((record) => <article key={record.id} className="history-record"><div className="history-record-heading"><strong>{record.method} {record.route}</strong><span>{record.status_code === null ? "Outcome unknown" : `HTTP ${record.status_code}`}</span><span>{record.result_state.replaceAll("_", " ")}</span><span>Capture: {record.capture_state}</span></div><small className="field-help">{new Date(record.recorded_at).toLocaleString()} · Source: {record.source} · Attempt: {record.attempt} · Revision: {record.revision} · Dataset: {record.dataset_label}</small><details><summary>Inspect sanitized request and response</summary><pre className="code-block">{formatValue({ request: record.request_snapshot, expectation: record.expectation_snapshot, response: record.response_snapshot, errorCode: record.error_code, durationMs: record.duration_ms })}</pre></details></article>)}</div></section>
    </main>
  );
}

function StatusItem({ label, state, detail, intentionallyDisabled = false }: { label: string; state: string; detail: string; intentionallyDisabled?: boolean }) {
  const isIntentionallyDisabled = intentionallyDisabled && state === "disabled";
  const ready = state === "ready" || state === "available" || state === "loopback-only" || isIntentionallyDisabled;
  const labelText = isIntentionallyDisabled ? "Disabled by design" : statusLabel(state);
  return <details className="status-item"><summary><span className={`status-dot ${ready ? "filled" : "hollow"}`} aria-hidden="true" /><strong>{label}</strong><span className="status-item-label">{labelText}</span></summary><p>{detail}</p></details>;
}

function statusLabel(state: string): string {
  if (state === "loopback-only") return "Ready · loopback only";
  if (state === "ready") return "Ready";
  if (state === "available") return "Ready";
  if (state === "disabled") return "Needs work · disabled";
  if (state === "blocked") return "Needs work";
  return "Needs work · unavailable";
}
