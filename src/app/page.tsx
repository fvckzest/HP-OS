export default function HomePage() {
  return (
    <main className="page-shell stack">
      <header>
        <p className="eyebrow">Operational engine for LMNL-built sites</p>
        <h1>HP-OS</h1>
        <p>
          The first implementation slice provides Site-key authentication and Site-scoped payment
          configuration, with a private local PostgreSQL foundation. Event and ticketing operations
          are not implemented yet.
        </p>
      </header>
      <section className="panel stack" aria-labelledby="capability-heading">
        <h2 id="capability-heading">Current capability</h2>
        <ul>
          <li>Version-controlled SQL migrations and direct PostgreSQL access.</li>
          <li>Operator-managed Organizations, Sites, Site keys, and payment-connection assignments.</li>
          <li>Event and ticketing API operations and local LMNL integration remain unavailable.</li>
        </ul>
      </section>
      <p className="muted">Local testing results do not establish hosted, provider, device, or production readiness.</p>
    </main>
  );
}
