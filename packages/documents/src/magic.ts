export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOC_MIME = "application/msword";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export type ContainerKind = "pdf" | "docx";

export function matchesMagic(bytes: Uint8Array, kind: ContainerKind): boolean {
  const magic = kind === "pdf" ? PDF_MAGIC : ZIP_MAGIC;
  if (bytes.length < magic.length) {
    return false;
  }
  return magic.every((byte, index) => bytes[index] === byte);
}

export function extensionOf(filename: string): string {
  const base = filename.split(/[/\\]/u).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

export function basenameOf(filename: string): string {
  const base = filename.split(/[/\\]/u).pop()?.trim() ?? "";
  return base.length > 255 ? base.slice(0, 255) : base;
}
