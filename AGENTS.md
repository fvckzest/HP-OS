# Working in HP-OS

- Start at [README.md](README.md) to find settled guidance and current work.
- Keep the README and affected feature or API documents current in the same change that adds a capability, settles a decision, or changes behavior. Update the README when a capability or documentation entry point is added; smaller internal changes need only update the affected technical document.
- Keep open questions and work in GitHub issues. Put settled rules in repository documents, with a brief reason and a link to the deciding issue. Do not copy full issue discussions into the documents.
- Do not perform visual review unless the user asks for it.
- Explain substantial changes in small, clear steps for a novice coder. Use standardized technical English.

## HP-OS and LMNL development

HP-OS is the active development target for the current ticketing work. Repository-wide, LMNL implementation and integration, hosted and external-provider/email/Wallet/device verification, and release/cutover proof are deferred until the user explicitly declares the cutover window. These deferred checks are not blockers to closing an HP-OS implementation issue once its HP-OS scope, local verification, and documentation are complete. Keep any prepared LMNL pull requests in Draft and unmerged. At the declared cutover window, after current LMNL Events are complete and public sales are closed, mark the changes ready for review, complete required review and acceptance, then merge them as part of the controlled switch. Merging does not open sales; follow the [release and cutover procedure](docs/release-and-cutover.md), agreed in [ticket #12](https://github.com/fvckzest/HP-OS/issues/12). This keeps live LMNL unchanged while its integration and release proof are deferred; see [issue #26](https://github.com/fvckzest/HP-OS/issues/26).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
