import type { SafeJson } from "./redaction";

export type CheckResult = "not_checked" | "passed" | "failed" | "unknown";
export type OutcomeState = "response_received" | "outcome_unknown";
export type CaptureState = "stored" | "incomplete";

export interface HistoryRecord {
  id: string;
  recorded_at: string;
  source: "manual" | "guided" | "local-lmnl";
  attempt: number;
  method: string;
  route: string;
  request_snapshot: SafeJson;
  expectation_snapshot: SafeJson | null;
  result_state: CheckResult;
  outcome_state: OutcomeState;
  status_code: number | null;
  response_snapshot: SafeJson | null;
  error_code: string | null;
  duration_ms: number | null;
  capture_state: CaptureState;
  environment: string;
  dataset_label: string;
  revision: string;
}

export interface RequestExecution {
  id: string | null;
  method: string;
  route: string;
  outcome: OutcomeState;
  statusCode: number | null;
  result: CheckResult;
  response: SafeJson | null;
  responseHeaders: Record<string, string>;
  redirectBlocked: boolean;
  capture: CaptureState;
  message?: string;
}
