import { apiFailure } from "./api-response";
import { getBusinessPool } from "./database";
import { defaultMediaStorage } from "./photo-media";
import type { AuthenticatedSite } from "./site-auth";
import { readPublicMediaVariant } from "./portfolio-projection";

/** Serve one complete variant only while its Photo remains publicly eligible. */
export async function handlePublicPhotoMediaGet(
  site: AuthenticatedSite,
  path: string[],
): Promise<Response | null> {
  if (path.length !== 5 || path[0] !== "public" || path[1] !== "media" || path[3] !== "variants") return null;

  const client = await getBusinessPool().connect();
  let media: { storageKey: string; byteSize: number } | null;
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    media = await readPublicMediaVariant(client, site.siteId, path[2], path[4]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (!media) return apiFailure(404, "not_found", "The requested Photo variant is not available to this Site.");
  try {
    const bytes = await defaultMediaStorage().get(media.storageKey);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch {
    // A database row that points to a missing or unreadable stored object is a
    // dependency inconsistency. Keep provider details and object keys private.
    return apiFailure(503, "service_unavailable", "The requested Photo variant is temporarily unavailable.");
  }
}
