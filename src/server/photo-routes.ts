import type { AuthenticatedSite } from "./site-auth";

function isPhotoPath(path: string[]): boolean {
  return path.length >= 4 && path[0] === "admin" && path[1] === "artworks"
    && (path[3] === "photos" || (path.length === 4 && (path[3] === "hero" || path[3] === "photo-order")));
}

function isPublicPhotoMediaPath(path: string[]): boolean {
  return path.length === 5 && path[0] === "public" && path[1] === "media" && path[3] === "variants";
}

/** Keep Sharp and local media access out of ordinary /v1 requests until a Photo route is used. */
export async function handlePhotoGet(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (isPublicPhotoMediaPath(path)) return (await import("./public-photo-media")).handlePublicPhotoMediaGet(site, path);
  if (!isPhotoPath(path)) return null;
  return (await import("./photos")).handlePhotoGet(request, site, path);
}

export async function handlePhotoPost(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (!isPhotoPath(path)) return null;
  return (await import("./photos")).handlePhotoPost(request, site, path);
}

export async function handlePhotoPut(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (!isPhotoPath(path)) return null;
  return (await import("./photos")).handlePhotoPut(request, site, path);
}

export async function handlePhotoDelete(request: Request, site: AuthenticatedSite, path: string[]): Promise<Response | null> {
  if (!isPhotoPath(path)) return null;
  return (await import("./photos")).handlePhotoDelete(request, site, path);
}
