# Portfolio

## Purpose and ownership

Issue [#117](https://github.com/fvckzest/HP-OS/issues/117) defines the Site-scoped portfolio API contract. Implementation is planned in [#119](https://github.com/fvckzest/HP-OS/issues/119) and its focused issues [#120](https://github.com/fvckzest/HP-OS/issues/120), [#121](https://github.com/fvckzest/HP-OS/issues/121), [#122](https://github.com/fvckzest/HP-OS/issues/122), [#123](https://github.com/fvckzest/HP-OS/issues/123), and [#124](https://github.com/fvckzest/HP-OS/issues/124). HP-OS owns each Site's Artwork, Collection, Photo, publication state, and delivery images. The Site authenticates its staff and owns public presentation. The decisions in [#111](https://github.com/fvckzest/HP-OS/issues/111), [#113](https://github.com/fvckzest/HP-OS/issues/113), [#114](https://github.com/fvckzest/HP-OS/issues/114), and [#115](https://github.com/fvckzest/HP-OS/issues/115) inform the contract; the separate [transition policy in #112](https://github.com/fvckzest/HP-OS/issues/112) governs existing catalog data. See the [domain glossary](../../CONTEXT.md) and [full API contract](../api/api.md#site-scoped-portfolio-api).

## Artwork and Collection records

- Each Artwork has a stable, Site-scoped API ID, a unique displayed Artwork ID, and an optional draft slug that must be present and unique before publication. Its original-sale status is separate from whether the Artwork is published or archived. A sold original remains visible as sold and does not imply print or edition availability.
- An Artwork may have multiple Photos and belong to multiple Collections. Membership order is maintained independently within each Collection. Deactivating a Collection preserves its Artwork memberships but hides it from public reads.
- Publishing requires a title, a valid unique slug, at least one active Collection, at least one Photo, both delivery sizes ready for every Photo, and exactly one ready Hero Photo. Archiving hides a published Artwork while preserving its data and relationships.
- Public reads include only published Artworks in at least one active Collection. A published Artwork without an active Collection is hidden from the public catalog and can reappear if it later belongs to an active Collection.

## Photo upload and delivery

- A Site uploads a complete JPEG, PNG, WebP, or TIFF source up to 50 MiB to HP-OS. An interrupted transfer creates no Photo; an accepted upload creates a stable Photo record and starts asynchronous processing.
- HP-OS produces two WebP variants: `grid_400` with a longest edge up to 400 px, and `artwork_1600` with a longest edge up to 1,600 px. Both preserve the source aspect ratio without forcing a crop. A Photo becomes ready only when both variants are ready.
- HP-OS keeps the source only while processing and deletes it when processing succeeds or fails. The Site keeps the reliable source copy outside HP-OS so it can upload again when needed.
- If an accepted initial upload fails processing, the failed Photo remains and the Site can reupload to the same Photo ID with a new idempotency key. If the response outcome is unknown, the Site replays identical bytes and metadata with the original key. Abandoned temporary upload bytes are removed within 24 hours.
- Replacing a ready Photo keeps its current public images available until both replacement sizes are ready, then switches both together. If replacement processing fails, the old images stay public; the Site can retry the replacement on the same Photo ID with a new key.
- A Photo in `processing` or `failed` state may be removed. Removing a Photo from a published Artwork must leave at least one ready Photo and exactly one ready hero. Removing the current hero requires selecting another ready Photo in the same atomic operation.
- Incomplete new Photos are not public. Adding a Photo to an already-published Artwork does not remove its other ready public Photos while the new Photo processes or fails.

These rules keep public images complete during upload and replacement while retaining a recoverable source with the Site.

## Site and public-read boundary

- Site backends use their private Site API key for management operations and for the published portfolio read path. The browser does not receive that key; the Site serves portfolio pages and image URLs through its own public site.
- Public responses contain only published Artwork metadata, active Collection memberships, ready Photos, the selected hero, and stable API-relative delivery references. They exclude processing failures, source images, credentials, internal database identifiers, print data, and sales data.
- HP-OS scopes every record lookup and write to the authenticated Site. Missing IDs and IDs owned by another Site return the same non-disclosing `404 not_found` response.

## Transition and implementation status

There is no automatic import or synchronization. Existing ZEST pages continue serving the current catalog, and the existing 2,600 px images and URLs remain available through transition and rollback. The portfolio contract authorizes no cutover or deletion. See the [transition policy](https://github.com/fvckzest/HP-OS/issues/112).

The portfolio API routes and image processing are not implemented yet. Issue [#119](https://github.com/fvckzest/HP-OS/issues/119) and its focused issues #120–124 track that work; #119 also records the remaining object storage, encoder, worker, and API hostname choices. The [compact API reference](../api/api-ref.md) is a lookup sheet; the [full contract](../api/api.md#site-scoped-portfolio-api) defines exact routes, payloads, errors, and lifecycle behavior.
