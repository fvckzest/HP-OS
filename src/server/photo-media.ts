import { createHash } from "node:crypto";
import { mkdir, opendir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

export const MAX_PHOTO_BYTES = 50 * 1024 * 1024;
export const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const ABANDONED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export const PHOTO_VARIANTS = {
  grid_400: { longestEdge: 400 },
  artwork_1600: { longestEdge: 1_600 },
} as const;

export type PhotoVariant = keyof typeof PHOTO_VARIANTS;
export type SupportedPhotoFormat = "jpeg" | "png" | "webp" | "tiff";

export interface DecodedPhoto {
  format: SupportedPhotoFormat;
  width: number;
  height: number;
}

export interface EncodedPhotoVariant {
  bytes: Buffer;
  width: number;
  height: number;
  contentType: "image/webp";
}

export interface PhotoEncoder {
  inspect(source: Buffer): Promise<DecodedPhoto>;
  encode(source: Buffer, variant: PhotoVariant): Promise<EncodedPhotoVariant>;
}

/**
 * Sharp is kept behind this small interface so local verification can inject a
 * deterministic failure or an in-memory encoder without changing the domain
 * transaction. The production default uses fixed WebP settings.
 */
export class SharpPhotoEncoder implements PhotoEncoder {
  async inspect(source: Buffer): Promise<DecodedPhoto> {
    const metadata = await sharp(source, { failOn: "error" }).metadata();
    const format = metadata.format;
    if (format !== "jpeg" && format !== "png" && format !== "webp" && format !== "tiff") {
      throw new PhotoMediaError(415, "unsupported_media_type", "The image format is not supported.");
    }
    if (!metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1) {
      throw new PhotoMediaError(422, "image_invalid", "The image has no usable dimensions.");
    }
    return { format, width: metadata.width, height: metadata.height };
  }

  async encode(source: Buffer, variant: PhotoVariant): Promise<EncodedPhotoVariant> {
    const size = PHOTO_VARIANTS[variant].longestEdge;
    const output = await sharp(source, { failOn: "error" })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    if (!output.info.width || !output.info.height || Math.max(output.info.width, output.info.height) > size) {
      throw new PhotoMediaError(503, "service_unavailable", "The image encoder returned an invalid delivery size.");
    }
    return {
      bytes: output.data,
      width: output.info.width,
      height: output.info.height,
      contentType: "image/webp",
    };
  }
}

export interface MediaStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  list(prefix?: string, limit?: number, cursor?: string | null): Promise<{
    objects: Array<{ key: string; modifiedAt: Date }>;
    cursor: string | null;
  }>;
}

function safeStorageKey(key: string): string {
  const normalized = key.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Invalid media storage key.");
  }
  return normalized;
}

/** Local deterministic storage used by the HTTP verifier and the development worker. */
export class FilesystemMediaStorage implements MediaStorage {
  readonly root: string;

  constructor(root = process.env.HPOS_MEDIA_ROOT ?? path.join(process.cwd(), ".local-media")) {
    this.root = root;
  }

  private filePath(key: string): string {
    const normalized = safeStorageKey(key);
    return path.join(this.root, normalized);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const filePath = this.filePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, bytes, { flag: "wx" }).catch(async (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await writeFile(filePath, bytes);
    });
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.filePath(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.filePath(key), { force: true });
  }

  async list(prefix = "", limit = 200, cursor: string | null = null): Promise<{
    objects: Array<{ key: string; modifiedAt: Date }>;
    cursor: string | null;
  }> {
    const base = prefix ? this.filePath(prefix) : this.root;
    const pageLimit = Math.max(1, Math.floor(limit));
    const output: Array<{ key: string; modifiedAt: Date }> = [];
    const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    const visit = async function* (directory: string, relativeDirectory: string): AsyncGenerator<{ key: string; modifiedAt: Date }> {
      let handle;
      try {
        handle = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const entries = [];
      for await (const entry of handle) entries.push(entry);
      entries.sort((left, right) => compare(left.name, right.name));
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const key = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const subtreePrefix = `${key}/`;
          if (cursor !== null && compare(subtreePrefix, cursor) < 0 && !cursor.startsWith(subtreePrefix)) continue;
          yield* visit(fullPath, key);
        } else {
          if (cursor !== null && key <= cursor) continue;
          yield { key, modifiedAt: (await stat(fullPath)).mtime };
        }
      }
    };
    const rootRelative = prefix ? safeStorageKey(prefix) : "";
    for await (const object of visit(base, rootRelative)) {
      output.push(object);
      if (output.length > pageLimit) break;
    }
    const hasMore = output.length > pageLimit;
    const objects = output.slice(0, pageLimit);
    return { objects, cursor: hasMore ? objects.at(-1)?.key ?? null : null };
  }
}

export class PhotoMediaError extends Error {
  readonly status: 413 | 415 | 422 | 503;
  readonly code: "request_too_large" | "unsupported_media_type" | "image_invalid" | "service_unavailable";

  constructor(status: 413 | 415 | 422 | 503, code: "request_too_large" | "unsupported_media_type" | "image_invalid" | "service_unavailable", message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "PhotoMediaError";
  }
}

/** Use local filesystem storage for development and the local scheduler. */
export function defaultMediaStorage(): MediaStorage {
  return new FilesystemMediaStorage();
}

function detectedFormat(source: Buffer): SupportedPhotoFormat | "unsupported" {
  if (source.length >= 3 && source[0] === 0xff && source[1] === 0xd8 && source[2] === 0xff) return "jpeg";
  if (source.length >= 8 && source.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (source.length >= 12 && source.toString("ascii", 0, 4) === "RIFF" && source.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (source.length >= 4 && ((source[0] === 0x49 && source[1] === 0x49 && source[2] === 0x2a && source[3] === 0x00)
    || (source[0] === 0x4d && source[1] === 0x4d && source[2] === 0x00 && source[3] === 0x2a))) return "tiff";
  return "unsupported";
}

export async function validatePhotoSource(source: Buffer, encoder: PhotoEncoder = new SharpPhotoEncoder()): Promise<DecodedPhoto> {
  if (source.byteLength > MAX_PHOTO_BYTES) {
    throw new PhotoMediaError(413, "request_too_large", "The image exceeds the 50 MiB limit.");
  }
  if (detectedFormat(source) === "unsupported") {
    throw new PhotoMediaError(415, "unsupported_media_type", "Upload a complete JPEG, PNG, WebP, or TIFF image.");
  }
  try {
    return await encoder.inspect(source);
  } catch (error) {
    if (error instanceof PhotoMediaError) throw error;
    throw new PhotoMediaError(422, "image_invalid", "The image bytes are corrupt or cannot be decoded.");
  }
}

export function mediaSha256(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

export function sourceStorageKey(siteId: string, artworkId: string, privatePhotoId: string, attemptNumber: number): string {
  return `sites/${siteId}/artworks/${artworkId}/photos/${privatePhotoId}/attempt-${attemptNumber}/source`;
}

export function variantStorageKey(
  siteId: string,
  artworkId: string,
  privatePhotoId: string,
  attemptNumber: number,
  variant: PhotoVariant,
  leaseFence?: number,
): string {
  const leasePath = leaseFence === undefined ? "" : `/lease-${leaseFence}`;
  return `sites/${siteId}/artworks/${artworkId}/photos/${privatePhotoId}/attempt-${attemptNumber}${leasePath}/${variant}.webp`;
}

export function stagingStorageKey(siteId: string, uploadId: string): string {
  return `staging/${siteId}/${uploadId}/source`;
}
