"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { foundationWorkflow, workbenchCatalog } from "@/src/workbench/catalog";
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
}

interface HistoryResponse { records: HistoryRecord[]; total: number }

async function readJson<T>(response: Response): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === "object" && "error" in value ? String(value.error) : "The request could not be completed.";
    throw new Error(message);
  }
  return value as T;
}

function statusClass(state: string): string {
  if (state === "ready" || state === "available" || state === "loopback-only") return "status-ready";
  if (state === "blocked") return "status-blocked";
  return "status-unavailable";
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
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("");
  const [headers, setHeaders] = useState('{\n  "Accept": "application/json"\n}');
  const [body, setBody] = useState("");
  const [expectedStatus, setExpectedStatus] = useState("");

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
    <main className="page-shell stack">
      <header className="stack">
        <p className="eyebrow">HP-OS · local testing only</p>
        <h1>Local testing workbench</h1>
        <p>Inspect local service readiness, prepare an editable HTTP request, and keep a private history of its sanitized result.</p>
        <p><Link href="/">Back to HP-OS</Link></p>
      </header>
      {message && <p className="notice" role="status">{message}</p>}

      <section className="panel stack" aria-labelledby="service-status-heading">
        <div className="row"><h2 id="service-status-heading">Service and configuration status</h2><button type="button" onClick={() => void refreshAll()} disabled={loading}>Refresh</button></div>
        {loading && <p>Checking the local application and PostgreSQL…</p>}
        {!loading && !status && <p className="status-blocked">Status unavailable. Check that the local database and application are running.</p>}
        {status && <div className="grid">
          <StatusItem label="Application" state={status.application.state} detail={status.application.capability} />
          <StatusItem label="Workbench access" state={status.access.state} detail={status.access.origin} />
          <StatusItem label="Local PostgreSQL" state={status.database.ready ? "ready" : "blocked"} detail={`${status.database.message} Target: ${status.database.target}.`} />
          <StatusItem label="Generated database API" state={status.generatedDatabaseApi.state} detail={status.generatedDatabaseApi.reason} />
          <StatusItem label="HP-OS business API" state={status.hposBusinessApi.state} detail={`${status.hposBusinessApi.reason} Site API key ${status.hposBusinessApi.siteKeyConfigured ? "is configured on the server" : "is not configured"}.`} />
          <StatusItem label="Local LMNL integration" state={status.lmnlIntegration.state} detail={status.lmnlIntegration.reason} />
        </div>}
        {status && <p className="muted">Environment: {status.environment} · Dataset: {status.dataset} · Revision: {status.revision}</p>}
      </section>

      <section className="grid" aria-label="Guided workflow and capability catalogue">
        <article className="panel stack">
          <h2>{foundationWorkflow.title}</h2>
          <p>{foundationWorkflow.explanation}</p>
          {foundationWorkflow.steps.map((step, index) => <div key={step.id} className="stack">
            <h3>Step {index + 1}: {step.title}</h3><p><strong>Expected:</strong> {step.expected}</p>
            <button type="button" onClick={() => void runFoundationCheck()}>Run this step</button>
          </div>)}
        </article>
        <article className="panel stack">
          <h2>Shared request catalogue</h2>
          {workbenchCatalog.map((entry) => <section key={entry.id} className="history-item">
            <p className={statusClass(entry.availability)}>{entry.availability.toUpperCase()} · {entry.title}</p>
            <p>{entry.explanation}</p>
            {entry.prerequisite && <p><strong>Prerequisite:</strong> {entry.prerequisite}</p>}
            <p><strong>Expected evidence:</strong> {entry.expectedEvidence.join("; ")}</p>
          </section>)}
        </article>
      </section>

      <section className="panel stack" aria-labelledby="request-heading">
        <h2 id="request-heading">Manual HTTP request</h2>
        <p className="muted">Requests are limited to this workbench’s loopback origin and the existing <code>/v1/</code> API path. Redirects are not followed. Site authentication, if configured, is added by the server and never returned to this page.</p>
        <form className="stack" onSubmit={(event) => void runRequest(event)}>
          <div className="grid">
            <div className="field"><label htmlFor="request-method">Method</label><select id="request-method" value={method} onChange={(event) => setMethod(event.target.value)}>{["GET", "POST", "PATCH", "PUT", "DELETE"].map((value) => <option key={value}>{value}</option>)}</select></div>
            <div className="field"><label htmlFor="request-path">Path</label><input id="request-path" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/v1/implemented-route" required /></div>
            <div className="field"><label htmlFor="expected-status">Expected HTTP status (optional)</label><input id="expected-status" type="number" min="100" max="599" value={expectedStatus} onChange={(event) => setExpectedStatus(event.target.value)} placeholder="No check" /></div>
          </div>
          <div className="field"><label htmlFor="request-headers">Headers (JSON)</label><textarea id="request-headers" value={headers} onChange={(event) => setHeaders(event.target.value)} spellCheck={false} /><small className="muted">Allowed: Accept, Content-Type, If-Match, If-None-Match, and Idempotency-Key. Credentials and browser security headers are not accepted here.</small></div>
          <div className="field"><label htmlFor="request-body">JSON body</label><textarea id="request-body" value={body} onChange={(event) => setBody(event.target.value)} spellCheck={false} placeholder="Optional. Deliberately invalid JSON is preserved for the request but omitted from history." /></div>
          <div className="row"><button type="submit" disabled={!status?.database.ready}>Send one request</button><span className="muted">Unknown outcomes are never retried automatically.</span></div>
        </form>
        {requestError && <p className="status-blocked" role="alert">{requestError}</p>}
        {execution && <div className="result stack" aria-live="polite">
          <h3>Request result</h3>
          <p><strong>Outcome:</strong> {execution.outcome === "outcome_unknown" ? "Outcome unknown" : `HTTP ${execution.statusCode}`}</p>
          <p><strong>Check:</strong> {execution.result.replaceAll("_", " ")}</p>
          <p><strong>History capture:</strong> {execution.capture}</p>
          {execution.message && <p className="notice">{execution.message}</p>}
          {execution.redirectBlocked && <p>A redirect was returned and blocked. The workbench did not follow it.</p>}
          <pre className="code-block">{formatValue({ route: execution.route, headers: execution.responseHeaders, response: execution.response })}</pre>
        </div>}
      </section>

      <section className="panel stack" aria-labelledby="history-heading">
        <div className="row"><h2 id="history-heading">Shared diagnostic history</h2><a href="/api/workbench/export">Download masked JSON</a><button type="button" onClick={() => void clearHistory()}>Clear history</button></div>
        <p className="muted">The viewer shows the latest {history.length} of {historyCount} saved calls. The export includes all saved calls. History contains sanitized evidence and is stored separately from business records.</p>
        {history.length === 0 && <p>No local calls have been recorded yet.</p>}
        {history.map((record) => <article key={record.id} className="history-item stack">
          <div className="row"><strong>{record.method} {record.route}</strong><span>{record.status_code === null ? "Outcome unknown" : `HTTP ${record.status_code}`}</span><span>{record.result_state.replaceAll("_", " ")}</span><span>Capture: {record.capture_state}</span></div>
          <small className="muted">{new Date(record.recorded_at).toLocaleString()} · Source: {record.source} · Attempt: {record.attempt} · Revision: {record.revision} · Dataset: {record.dataset_label}</small>
          <details><summary>Inspect sanitized request and response</summary><pre className="code-block">{formatValue({ request: record.request_snapshot, expectation: record.expectation_snapshot, response: record.response_snapshot, errorCode: record.error_code, durationMs: record.duration_ms })}</pre></details>
        </article>)}
      </section>
    </main>
  );
}

function StatusItem({ label, state, detail }: { label: string; state: string; detail: string }) {
  return <div><strong>{label}</strong><p className={statusClass(state)}>{state.toUpperCase()}</p><p>{detail}</p></div>;
}
