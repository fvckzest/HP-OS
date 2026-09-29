export type CatalogAvailability = "available" | "unavailable" | "blocked";

export interface CatalogEntry {
  id: string;
  title: string;
  kind: "diagnostic" | "business-api" | "site-integration";
  availability: CatalogAvailability;
  explanation: string;
  expectedEvidence: string[];
  prerequisite?: string;
}

export const workbenchCatalog: CatalogEntry[] = [
  { id: "local-foundation-status", title: "Local foundation readiness", kind: "diagnostic", availability: "available", explanation: "Check that the loopback-only workbench can reach the marked local test database.", expectedEvidence: ["Application access check", "Direct PostgreSQL connection", "Local test marker"] },
  { id: "site-payment-configuration", title: "Site access and payment configuration", kind: "business-api", availability: "available", explanation: "Site-key authentication, Site-scoped payment-configuration reads, connection assignment history, and Site-wide request limits are implemented over PostgreSQL.", expectedEvidence: ["Hash-verified Site API key", "Rotation and revocation outcomes", "Shared and separate connection isolation", "Structured API responses and errors", "Site-wide request-limit response"] },
  { id: "hpos-ticketing-api", title: "Events and ticketing API", kind: "business-api", availability: "unavailable", explanation: "Event, Order, Ticket, Admission, payment-report, and durable-processing operations are not implemented in this slice.", expectedEvidence: ["Implemented API route with real local PostgreSQL state", "Normal HTTP authentication", "Success and expected-rejection evidence", "Duplicate-safe retries and concurrent-operation evidence", "Interruption and safe-recovery evidence"], prerequisite: "Complete the corresponding implementation tickets before running their API workflows." },
  { id: "local-lmnl-integration", title: "Local LMNL integration", kind: "site-integration", availability: "unavailable", explanation: "This repository does not yet include the local LMNL Site backend.", expectedEvidence: ["Site-authenticated request", "Site-owned integration behavior"], prerequisite: "A compatible local LMNL backend and its server-side configuration." },
];

export const foundationWorkflow = {
  id: "foundation-readiness",
  title: "Check foundation readiness",
  explanation: "This diagnostic workflow checks local setup only; it does not create business records.",
  steps: [{ id: "check-services", title: "Check local services", expected: "The app is local-only and the dedicated local PostgreSQL marker is present.", action: "refresh-status" }],
} as const;

export const siteAccessWorkflow = {
  id: "site-access-configuration",
  title: "Verify Site access and payment configuration",
  explanation: "Creates temporary synthetic Organizations, Sites, connections, and keys; sends normal HTTP requests through the Site API; saves sanitized outcomes in workbench history; and removes the fixtures after the check.",
  steps: [
    { id: "key-lifecycle", title: "Key lifecycle", expected: "Missing, rotated, and revoked keys are rejected; a replacement key succeeds." },
    { id: "site-isolation", title: "Site isolation", expected: "A Site reads only its assigned connection, including when Sites share an Organization or connection." },
    { id: "request-limit", title: "Site-wide request limit", expected: "The configured request budget is shared across active keys for one Site." },
  ],
} as const;
