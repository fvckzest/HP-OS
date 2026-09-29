"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { foundationWorkflow, siteAccessWorkflow } from "@/src/workbench/catalog";
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

async function readJson<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value ? String(value.error) : "The request could not be completed.";
    throw new Error(message);
  }
  return value as T;
}

function formatValue(value: unknown): string { return JSON.stringify(value, null, 2); }

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
  const [headers, setHeaders] = useState('{\n  "Accept": "application/json"\n}');
  const [body, setBody] = useState("");
  const [expectedStatus, setExpectedStatus] = useState("");
  const siteAccessCapability = status?.catalogue.find((entry) => entry.id === "site-payment-configuration");
  const siteAccessReady = Boolean(status?.database.ready
    && status.hposBusinessApi.state === "available"
    && siteAccessCapability?.availability === "available");
  const siteAccessBlockReason = status && !siteAccessReady
    ? !status.database.ready ? status.database.message : siteAccessCapability?.prerequisite ?? status.hposBusinessApi.reason
    : "";

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

  return (
    <main className="page-shell workbench-page">
      <header className="workbench-header">
        <div className="workbench-header-meta"><p>HP-OS · Local only</p><Link href="/">Home</Link></div>
        <h1>Workbench</h1>
      </header>
      {message && <p className={`notice workbench-message ${message.startsWith("Blocked") ? "notice-warning" : ""}`} role="status">{message}</p>}

      <section className="workbench-section" aria-labelledby="service-status-heading">
        <div className="section-heading">
          <h2 id="service-status-heading">Service status</h2>
          <button className="button-secondary" type="button" onClick={() => void refreshAll()} disabled={loading}>Refresh status</button>
        </div>
        {loading && <p>Checking the local application and PostgreSQL…</p>}
        {!loading && !status && <p className="status-blocked">Status unavailable. Check that the local database and application are running.</p>}
        {status && <div className="status-grid">
          <StatusItem label="Application" state={status.application.state} detail={status.application.capability} />
          <StatusItem label="Workbench access" state={status.access.state} detail={status.access.origin} />
          <StatusItem label="Local PostgreSQL" state={status.database.ready ? "ready" : "blocked"} detail={`${status.database.message} Target: ${status.database.target}.`} />
          <StatusItem label="Generated database API" state={status.generatedDatabaseApi.state} detail={status.generatedDatabaseApi.reason} />
          <StatusItem label="HP-OS business API" state={status.hposBusinessApi.state} detail={`${status.hposBusinessApi.reason} Site API key ${status.hposBusinessApi.siteKeyConfigured ? "is configured on the server" : "is not configured"}.`} />
          <StatusItem label="Local LMNL integration" state={status.lmnlIntegration.state} detail={status.lmnlIntegration.reason} />
        </div>}
        {status && <div className="environment-meta" aria-label="Local dataset details">
          <span>Environment: {status.environment}</span>
          <span>Dataset: {status.dataset}</span>
          <span>Revision: <code>{status.revision}</code></span>
        </div>}
      </section>

      <section className="workbench-section" aria-labelledby="workflow-heading">
        <div className="section-heading">
          <h2 id="workflow-heading">Foundation check</h2>
        </div>
        <div className="workflow-card">
          {foundationWorkflow.steps.map((step) => <div key={step.id} className="workflow-step">
            <div className="workflow-step-copy">
              <strong>{step.title}</strong>
              <p>{step.expected}</p>
            </div>
            <button className="button-primary" type="button" onClick={() => void runFoundationCheck()}>Run check</button>
          </div>)}
        </div>
      </section>

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

      <section className="workbench-section" aria-labelledby="history-heading">
        <div className="section-heading history-heading-row">
          <div><h2 id="history-heading">History</h2><p className="section-description">{history.length} of {historyCount} calls · sanitized and saved locally</p></div>
          <div className="history-actions"><a className="button-secondary button-link" href="/api/workbench/export">Download masked JSON</a><button className="button-secondary" type="button" onClick={() => void clearHistory()}>Clear history</button></div>
        </div>
        {history.length === 0 && <p className="empty-state">No local calls have been recorded yet.</p>}
        <div className="history-list">{history.map((record) => <article key={record.id} className="history-record">
          <div className="history-record-heading"><strong>{record.method} {record.route}</strong><span>{record.status_code === null ? "Outcome unknown" : `HTTP ${record.status_code}`}</span><span>{record.result_state.replaceAll("_", " ")}</span><span>Capture: {record.capture_state}</span></div>
          <small className="field-help">{new Date(record.recorded_at).toLocaleString()} · Source: {record.source} · Attempt: {record.attempt} · Revision: {record.revision} · Dataset: {record.dataset_label}</small>
          <details><summary>Inspect sanitized request and response</summary><pre className="code-block">{formatValue({ request: record.request_snapshot, expectation: record.expectation_snapshot, response: record.response_snapshot, errorCode: record.error_code, durationMs: record.duration_ms })}</pre></details>
        </article>)}
        </div>
      </section>
    </main>
  );
}

function StatusItem({ label, state, detail }: { label: string; state: string; detail: string }) {
  return <article className="status-card">
    <div className="status-card-heading"><strong>{label}</strong><span>{statusLabel(state)}</span></div>
    <p>{detail}</p>
  </article>;
}

function statusLabel(state: string): string {
  if (state === "loopback-only") return "Loopback only";
  if (state === "ready") return "Ready";
  if (state === "available") return "Available";
  if (state === "disabled") return "Disabled";
  if (state === "blocked") return "Needs attention";
  return "Unavailable";
}
