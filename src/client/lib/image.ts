import type { ImageAttachment } from "../../shared/protocol";

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_GIF_BYTES = 8 * 1024 * 1024;
const MAX_DIMENSION = 1920;
const PASSTHROUGH_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/heic", "image/heif"]);

export class ImagePrepareError extends Error {}

/**
 * Turns a picked/pasted image File into a base64 ImageAttachment.
 *
 * Photos (JPEG/HEIC) are always re-encoded to a downscaled JPEG so mobile
 * camera output stays small and HEIC is converted to a provider-friendly
 * format. Small PNG/WebP images pass through untouched; larger ones are
 * downscaled (WebP when the browser supports encoding it, otherwise PNG so
 * transparency survives). GIFs pass through as-is (no animation in canvas).
 * When the browser cannot decode the file at all, the original bytes are
 * passed through so nothing is silently lost.
 */
export async function prepareImage(file: File): Promise<ImageAttachment> {
  const mimeType = imageMimeType(file);
  if (mimeType === "image/gif") {
    if (file.size > MAX_GIF_BYTES) throw new ImagePrepareError(`GIF 图片不能超过 ${String(MAX_GIF_BYTES / 1024 / 1024)}MB`);
    return { mimeType, data: await fileToData(file) };
  }
  if (file.size > MAX_ATTACHMENT_BYTES) throw new ImagePrepareError(`单张图片不能超过 ${String(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB`);

  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await decodeImage(file);
  } catch {
    // Undecodable in this browser (e.g. exotic HEIC on desktop) — send as-is.
    return { mimeType, data: await fileToData(file) };
  }

  try {
    const data = await fileToData(file);
    if (!PHOTO_TYPES.has(mimeType) && file.size <= PASSTHROUGH_BYTES && source.width <= MAX_DIMENSION && source.height <= MAX_DIMENSION) {
      return { mimeType, data };
    }
    const encoded = await reencode(source, mimeType);
    // Prefer the original when re-encoding did not shrink it and it is small.
    if (encoded.data.length > data.length && file.size <= PASSTHROUGH_BYTES) return { mimeType, data };
    return encoded;
  } finally {
    closeSource(source);
  }
}

function imageMimeType(file: File): string {
  const declared = file.type.toLocaleLowerCase();
  if (declared.startsWith("image/")) return declared;
  const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  const byExtension: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
  };
  const fromExtension = byExtension[extension];
  if (fromExtension !== undefined) return fromExtension;
  throw new ImagePrepareError("仅支持图片文件（PNG/JPEG/WebP/GIF/HEIC）");
}

async function decodeImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the <img> decoder; Safari's bitmap decoder is picky.
    }
  }
  return loadViaImageElement(file);
}

function loadViaImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    image.src = url;
  });
}

function closeSource(source: ImageBitmap | HTMLImageElement): void {
  if (typeof ImageBitmap !== "undefined" && source instanceof ImageBitmap) source.close();
}

async function reencode(source: ImageBitmap | HTMLImageElement, originalMime: string): Promise<ImageAttachment> {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(source.width, source.height));
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new ImagePrepareError("无法处理这张图片");
  context.drawImage(source, 0, 0, width, height);

  if (PHOTO_TYPES.has(originalMime)) {
    const data = await canvasToData(canvas, "image/jpeg", 0.8);
    if (data === null || data === "") throw new ImagePrepareError("无法处理这张图片");
    return { mimeType: "image/jpeg", data };
  }

  const webp = await canvasToData(canvas, "image/webp", 0.85);
  if (webp !== null) return { mimeType: "image/webp", data: webp };
  const png = await canvasToData(canvas, "image/png");
  if (png !== null && png !== "") return { mimeType: "image/png", data: png };
  throw new ImagePrepareError("无法处理这张图片");
}

function canvasToData(canvas: HTMLCanvasElement, mimeType: string, quality?: number): Promise<string | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => {
    if (blob === null) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? stripDataUrlPrefix(reader.result) : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  }, mimeType, quality));
}

function fileToData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? stripDataUrlPrefix(reader.result) : "");
    reader.onerror = () => reject(new ImagePrepareError("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function stripDataUrlPrefix(value: string): string {
  const commaIndex = value.indexOf(",");
  return commaIndex === -1 ? value : value.slice(commaIndex + 1);
}

export function imageDataUrl(attachment: ImageAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}
