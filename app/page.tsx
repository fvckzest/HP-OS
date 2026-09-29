import Link from "next/link";

export default function HomePage() {
  return (
    <main className="page-shell stack">
      <header>
        <p className="eyebrow">Operational engine for LMNL-built sites</p>
        <h1>HP-OS</h1>
        <p>
          The first implementation slice provides a private local PostgreSQL foundation and a
          testing workbench. Ticketing and Event business operations are not implemented yet.
        </p>
      </header>
      <section className="panel stack" aria-labelledby="capability-heading">
        <h2 id="capability-heading">Current capability</h2>
        <ul>
          <li>Version-controlled SQL migrations and direct PostgreSQL access.</li>
          <li>A loopback-only local workbench with sanitized, persistent diagnostic history.</li>
          <li>Business API operations and local LMNL integration remain unavailable.</li>
        </ul>
        <p><Link href="/workbench">Open the local testing workbench</Link></p>
      </section>
      <p className="muted">Local testing results do not establish hosted, provider, device, or production readiness.</p>
    </main>
  );
}
