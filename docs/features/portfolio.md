# Portfolio

## Purpose and ownership

The Site-scoped portfolio API implements the Artwork, Collection, Photo, publication, and delivery-image rules settled in [#117](https://github.com/fvckzest/HP-OS/issues/117). The implementation is split across [#119](https://github.com/fvckzest/HP-OS/issues/119) through [#124](https://github.com/fvckzest/HP-OS/issues/124). HP-OS owns operational portfolio data and image processing. The Site backend authenticates its staff, calls HP-OS with its private Site API key, and owns public page presentation, matching the existing [Event and ticketing ownership boundary](../ownership.md).

Portfolio writes use the existing `/v1` request boundary and Site-wide idempotency records. They carry the authenticated Site scope, an actor reference, and the relevant Artwork, Photo, or Collection version. Artwork and Collection updates retain the latest actor assertion; each accepted Photo upload, retry, or replacement retains its actor on the durable processing-attempt record. PostgreSQL transactions apply publication, membership, order, hero, and Photo lifecycle changes atomically. Database identifiers and media storage keys stay private. A missing resource and a resource belonging to another Site return the same `404 not_found` response.

The established HP-OS host is `hp-os.dev`; until a dedicated API hostname is configured, the intended API base URL is `https://hp-os.dev/v1`. The API continues to use the versioned `/v1` paths, so a later hostname change does not change the contract.

## Artwork and Collection records

- Each Artwork has a stable, Site-scoped API ID, a unique displayed Artwork ID, and an optional draft slug that must be present and unique before publication. Original-sale status is separate from publication status. A sold original remains visible as sold and does not imply print or edition availability.
- An Artwork may have multiple Photos and belong to multiple Collections. Membership order is maintained independently within each Collection. Deactivating a Collection preserves its memberships but hides it from public reads.
- Publishing requires a title, a valid unique slug, at least one active Collection, at least one Photo, two ready delivery variants for every Photo, and exactly one ready hero Photo. Archiving hides the published Artwork while preserving its data and relationships.
- Adding an incomplete Photo to an already-published Artwork does not block metadata edits or hide its existing ready Photos. Public projections omit the new Photo until both delivery variants are ready.
- Public reads include only published Artworks in at least one active Collection. A published Artwork with no active Collection is hidden from public reads and can appear again if it later belongs to an active Collection.
- Admin reads include drafts, archived Artworks, inactive Collections, and incomplete Photo processing states. They return complete Artwork projections, ordered Photos, replacement state, Collection membership, hero, and versions.

## Photo upload and delivery

- A Site uploads one complete JPEG, PNG, WebP, or TIFF source up to 50 MiB. HP-OS checks the decoded bytes rather than trusting the filename or declared media type. An accepted upload creates a stable Photo record and durable processing job; incomplete or invalid uploads do not create a Photo.
- Sharp `0.33.5` creates WebP `grid_400` and `artwork_1600` variants with maximum longest edges of 400 and 1,600 pixels. Both use the same aspect-preserving resize and fixed WebP quality 82, effort 4, and smart subsampling settings. A Photo becomes ready only after both variants have been written and recorded.
- The source stays available while its attempt is processing and is removed after success or failure. The Site keeps its own reliable source copy for future uploads. Replacing a ready Photo preserves the current images until both replacement variants are ready, then switches both together. Retired variants are queued for removal after a 24-hour grace period; deleting a Photo promotes all of its media to immediate durable cleanup.
- Failed initial processing can be retried on the same Photo ID with a new idempotency key. A replacement can likewise be retried on the same Photo ID. A repeated request key must carry identical bytes and canonical JSON metadata; the request fingerprint includes the file's SHA-256 and does not include its filename.
- Abandoned upload staging bytes and failed object cleanup remain recorded for bounded retry by the worker. Local development and verification use filesystem storage rooted at `HPOS_MEDIA_ROOT`, defaulting to `.local-media/`. Hosted object storage is not part of this local implementation.
- The existing local `/api/cron/process` entry point runs portfolio work after the current Event/payment recovery and Ticket issuance phases. Photo jobs and media cleanup use bounded batches, `SKIP LOCKED` claims, expiring leases, and fencing so overlapping workers cannot publish stale results. Empty queues do not access local media storage or claim work.

## Public-read boundary

- Site backends use their private Site API key for both management and public portfolio reads. The browser never receives that key; the Site serves its own public page and can use the stable API-relative image references.
- Public Artworks require published state, active Collection membership, one ready hero, and both active delivery variants for every visible Photo. Public responses expose approved Artwork fields, active Collection memberships, ready Photo ordering, and stable variant paths. They omit processing errors, replacement state, source images, credentials, database identifiers, actor/audit data, print/edition data, and transactional commerce data; the contracted `original_status` field remains public.
- Public pages and media reads use the same database eligibility rule and Site scope. Public projections use a repeatable-read transaction so pagination and nested memberships reflect one database snapshot. Signed cursors bind the Site, filters, order, and page size.
- Public delivery paths resolve the currently eligible variant without returning its storage key. An Artwork that becomes ineligible cannot be used to fetch its Photo variants.

## Verification and boundaries

The local portfolio checks exercise the authenticated `/v1` handlers against local PostgreSQL and deterministic local media storage:

- `pnpm verify:artwork-drafts` checks Artwork creation, edits, publication, archive, field validation, idempotency, versions, and Site isolation.
- `pnpm verify:collections` checks Collection lifecycle, ordering, membership changes, version guards, idempotency, and Site isolation.
- `pnpm verify:photo-processing` checks supported and rejected image bytes, WebP dimensions and quality, accepted processing, source cleanup, abandoned uploads, and fixture cleanup.
- `pnpm verify:photo-curation` checks processing failure and retry, atomic replacement, curation operations, published Photo-removal guards, and physical media deletion.
- `pnpm verify:photo-http` checks authenticated multipart upload and idempotent replay, HTTP retry and replacement, processing through the existing scheduler, cursor behavior, curation, Site isolation, media deletion, and published-Photo availability while a new Photo is processing.
- `pnpm verify:portfolio-public` checks public eligibility and privacy, pagination, stable media reads, publication changes, and Site isolation.

These checks prove local HP-OS behavior. They do not import the existing ZEST catalog, switch public Site pages, configure hosted media storage, or prove hosted scheduling, external integrations, or cutover readiness. The existing ZEST catalog and image URLs remain available through transition and rollback under [#112](https://github.com/fvckzest/HP-OS/issues/112).

See the exact routes, fields, statuses, retries, and response shapes in the [full API contract](../api/api.md#site-scoped-portfolio-api) and [compact API reference](../api/api-ref.md). The settled API contract follows [#117](https://github.com/fvckzest/HP-OS/issues/117); local implementation decisions and evidence are recorded with issues [#119–#124](https://github.com/fvckzest/HP-OS/issues/119).
