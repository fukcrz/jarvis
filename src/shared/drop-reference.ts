const ATTACHABLE_IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|heic|heif)$/i;
export const MAX_DROPPED_IMAGE_BYTES = 15 * 1024 * 1024;

export function quoteDropReference(path: string): string {
  return /\s/.test(path) ? `"${path.replaceAll("\"", "\\\"")}"` : path;
}

/** Workspace-relative reference, matching composer `@` completion. Directories keep a trailing slash. */
export function formatWorkspaceDropReference(relativePosix: string, isDirectory: boolean): string {
  const trimmed = relativePosix.replace(/\/+$/, "");
  const body = trimmed === "" ? "./" : isDirectory ? `${trimmed}/` : trimmed;
  return `@${quoteDropReference(body)}`;
}

/** Absolute path outside the workspace. Slashes are normalized so a trailing directory marker cannot escape a quote. */
export function formatExternalDropReference(absolutePath: string, isDirectory: boolean): string {
  const display = absolutePath.replaceAll("\\", "/").replace(/\/+$/, "");
  return quoteDropReference(isDirectory ? `${display}/` : display);
}

export function isAttachableImagePath(path: string): boolean {
  return ATTACHABLE_IMAGE_EXTENSION.test(path);
}

export function shouldAttachDroppedImage(path: string, size: number, isFile: boolean): boolean {
  return isFile && size <= MAX_DROPPED_IMAGE_BYTES && isAttachableImagePath(path);
}
