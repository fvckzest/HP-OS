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
  { id: "hpos-business-api", title: "HP-OS business API", kind: "business-api", availability: "unavailable", explanation: "No /v1 business operations are implemented in the local foundation slice.", expectedEvidence: ["An implemented API route", "Normal HTTP authentication", "Real local PostgreSQL state"], prerequisite: "The corresponding HP-OS foundation and capability issues must implement the API routes." },
  { id: "local-lmnl-integration", title: "Local LMNL integration", kind: "site-integration", availability: "unavailable", explanation: "This repository does not yet include the local LMNL Site backend.", expectedEvidence: ["Site-authenticated request", "Site-owned integration behavior"], prerequisite: "A compatible local LMNL backend and its server-side configuration." },
];

export const foundationWorkflow = {
  id: "foundation-readiness",
  title: "Check foundation readiness",
  explanation: "This diagnostic workflow checks local setup only; it does not create business records.",
  steps: [{ id: "check-services", title: "Check local services", expected: "The app is local-only and the dedicated local PostgreSQL marker is present.", action: "refresh-status" }],
} as const;
