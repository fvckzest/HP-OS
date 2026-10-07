let state;
let refreshTimer;
let refreshing = false;
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const profile = () => document.querySelector('#profile').value;
const message = text => { document.querySelector('#message').textContent = text; };
async function action(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Site-Token': state.csrf }, body: JSON.stringify(body) });
    const result = await r.json(); if (!r.ok) throw new Error(result.error); message('Action accepted. Refresh saved status to inspect progress.'); await refresh();
  } catch (e) { message(e.message); await refresh(); }
}
function button(text, fn, disabled = false) { const b = el('button', text); b.disabled = disabled; b.onclick = fn; return b; }
function link(text, url) { const a = el('a', text); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
function details(title, content) { const d = el('details'); d.append(el('summary', title), content); return d; }
function render() {
  const openDetails = new Set([...document.querySelectorAll('details[open]')].map(d => d.dataset.key ?? d.querySelector('summary')?.textContent));
  const paymentInputs = new Map([...document.querySelectorAll('input[data-run-id]')].map(input => [input.dataset.runId, input.value]));
  const current = profile();
  const progress = document.querySelector('#progress'); progress.replaceChildren();
  const active = state.runs.find(r => r.status === 'running');
  const latest = active ?? state.runs[0];
  if (latest) {
    const panel = el('div', undefined, 'notice');
    panel.append(el('p', `${latest.title} · ${latest.status}`, 'status'), el('p', latest.message));
    const step = latest.steps.at(-1);
    if (step) panel.append(el('p', `${step.method} ${step.path} · ${step.actual?.status ? 'HTTP ' + step.actual.status : step.actual?.errorCode ?? step.state ?? 'recorded'}`));
    if (active) panel.append(el('p', 'Saved progress refreshes every 2 seconds. Refresh and Interrupt remain available.'), button('Interrupt current run', () => action('/api/interrupt', { runId: active.id })));
    progress.append(panel);
  }
  document.querySelector('#environment').textContent = `${state.environment.container ? 'Docker container' : 'Host process'} → ${state.environment.origin} · source ${state.source.revision.slice(0,12)}${state.source.workingTree ? ' + working-tree changes' : ''} · snapshot ${state.source.capturedAt}. ${state.environment.revisionNote}`;
  const list = document.querySelector('#checklist'); list.replaceChildren();
  for (const group of state.groups) {
    list.append(el('h2', group.title));
    const table = el('table', undefined, 'workflow-table'), head = el('tr'), body = el('tbody');
    for (const label of ['Run / gate', 'Workflow', 'Description']) { const th = el('th', label); th.scope = 'col'; head.append(th); }
    const thead = el('thead'); thead.append(head); table.append(thead, body);
    const scroll = el('div', undefined, 'table-scroll'); scroll.append(table); list.append(scroll);
    for (const ticket of state.tickets.filter(t => t.number >= group.from && t.number <= group.to)) {
      const ticketWorkflows = state.workflows.filter(w => w.ticket === ticket.number);
      if (!ticketWorkflows.length) {
        const row = el('tr', undefined, 'ticket-only-row'), gate = el('span', ticket.gate, 'ticket-gate');
        const gateCell = el('td'); gateCell.append(gate); row.append(gateCell);
        const ticketCell = el('td'), ticketLink = link(`#${ticket.number} ${ticket.title}`, ticket.url); ticketCell.append(ticketLink, el('span', 'No local workflow', 'workflow-status')); row.append(ticketCell);
        const descriptionCell = el('td'), ticketDetails = el('details');
        ticketDetails.dataset.key = `ticket:${ticket.number}`;
        const ticketSummary = el('summary'); ticketSummary.append(el('span', ticket.reason, 'description-preview'), el('span', 'Details', 'expand-label'));
        const ticketContent = el('div', undefined, 'expanded-content');
        ticketContent.append(el('p', ticket.reason, 'muted'));
        if (ticket.criteria.length) { ticketContent.append(el('h4', 'Ticket acceptance criteria')); const criteria = el('ul'); for (const item of ticket.criteria) criteria.append(el('li', item)); ticketContent.append(criteria); }
        ticketDetails.append(ticketSummary, ticketContent); descriptionCell.append(ticketDetails); row.append(descriptionCell); body.append(row);
      }
      for (const w of ticketWorkflows) {
        const row = el('tr', undefined, 'workflow-row'), latest = state.runs.find(r => r.workflow === w.id && r.profile === current), reasons = w.blockers[current];
        const status = latest?.status ?? (reasons.length ? 'blocked' : 'not run');
        const run = button('Run', () => action('/api/run', { workflow: w.id, profile: current }), Boolean(reasons.length || state.runs.some(r => r.status === 'running')));
        run.setAttribute('aria-label', `Run workflow: ${w.title}`);
        const actionCell = el('td'); actionCell.append(run); row.append(actionCell);
        const workflowCell = el('td'), ticketLink = link(`#${ticket.number} ${ticket.title}`, ticket.url);
        ticketLink.className = 'workflow-ticket'; workflowCell.append(ticketLink, el('strong', w.title, 'workflow-name'), el('span', status, 'workflow-status')); row.append(workflowCell);
        const descriptionCell = el('td'), workflowDetails = el('details');
        workflowDetails.dataset.key = `workflow:${w.id}`;
        const summary = el('summary'); summary.append(el('span', w.scope ?? `${w.steps.length} documented checks`, 'description-preview'), el('span', 'Details', 'expand-label'));
        const content = el('div', undefined, 'expanded-content');
        if (w.scope) content.append(el('p', w.scope, 'muted'));
        content.append(el('h4', 'Workflow checks'));
        const steps = el('ol'); w.steps.forEach(s => steps.append(el('li', s))); content.append(steps);
        if (reasons.length) content.append(el('p', `Profile requirements: ${reasons.join(' ')}`, 'muted'));
        content.append(el('h4', 'Ticket context'), el('p', ticket.reason, 'muted'));
        if (ticket.criteria.length) { const criteria = el('ul'); for (const item of ticket.criteria) criteria.append(el('li', item)); content.append(criteria); }
        workflowDetails.append(summary, content); descriptionCell.append(workflowDetails); row.append(descriptionCell); body.append(row);
      }
    }
  }
  document.querySelector('#route-count').textContent = `All ${state.routes.length} documented API routes and ticket mappings`;
  const table = el('table'), head = el('tr'); ['Method and path', 'Tickets', 'Availability'].forEach(x => head.append(el('th', x))); table.append(head);
  for (const r of state.routes) { const tr = el('tr'); tr.append(el('td', r.route), el('td', r.tickets.map(n => '#' + n).join(', ')), el('td', `${r.implemented ? 'Implemented' : 'Unavailable'} · ${r.note}`)); table.append(tr); }
  document.querySelector('#routes').replaceChildren(table);
  const runs = document.querySelector('#runs'); runs.replaceChildren();
  for (const run of state.runs) {
    const row = el('article', undefined, 'run'); row.append(el('h3', `${run.title} · ${run.profile} · ${run.status}`), el('p', `${run.startedAt} · ${run.id}`), el('p', run.message), el('p', run.limitations.join(' '), 'muted'));
    row.dataset.run = run.id;
    if (run.hasCheckout) row.append(link('Open saved Square Sandbox checkout', '/api/checkout/' + run.id), el('br'));
    if (run.hasOrder) row.append(link('Open Fake LMNL Order page', '/buyer/order/' + run.id), el('br'));
    if (run.hasTicket) row.append(link('Open Fake LMNL Ticket page', '/buyer/ticket/' + run.id), el('br'));
    if (['interrupted', 'unknown outcome', 'blocked'].includes(run.status)) {
      if (run.canResume) {
        const payment = el('input'); payment.placeholder = 'Square Sandbox payment ID (when requested)'; payment.setAttribute('aria-label', 'Square Sandbox payment ID');
        payment.dataset.runId = run.id; payment.value = paymentInputs.get(run.id) ?? '';
        if (run.profile === 'sandbox') row.append(payment);
        row.append(button('Resume saved run', () => action('/api/resume', { runId: run.id, ...(payment.value ? { paymentId: payment.value } : {}) })));
      } else if (run.resumeUnavailableReason) row.append(el('p', run.resumeUnavailableReason, 'muted'));
    }
    if (run.status === 'running') row.append(button('Interrupt', () => action('/api/interrupt', { runId: run.id })));
    row.append(details('Redacted requests, responses and checks', el('pre', JSON.stringify(run, null, 2)))); runs.append(row);
  }
  if (!state.runs.length) runs.append(el('p', 'No workflow has been run.'));
  for (const d of document.querySelectorAll('details')) {
    d.dataset.key ??= `${d.closest('[data-ticket]')?.dataset.ticket ?? d.closest('[data-run]')?.dataset.run ?? 'global'}:${d.querySelector('summary')?.textContent}`;
    if (openDetails.has(d.dataset.key) || openDetails.has(d.querySelector('summary')?.textContent)) d.open = true;
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true; clearTimeout(refreshTimer);
  try { const r = await fetch('/api/status'); if (!r.ok) throw new Error('Status could not be read.'); state = await r.json(); render(); }
  catch(e) { message(e.message); }
  finally { refreshing = false; if (state?.runs.some(run => run.status === 'running')) refreshTimer = setTimeout(refresh, 2000); }
}
document.querySelector('#refresh').onclick = refresh;
document.querySelector('#profile').onchange = render;
document.querySelector('#export').onclick = () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), source: state.source, routes: state.routes, tickets: state.tickets, runs: state.runs }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'fake-lmnl-redacted-evidence.json'; a.click(); URL.revokeObjectURL(url);
};
await refresh();
