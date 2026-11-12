import { DocumentParseError } from "./errors.js";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD_HEADER = 0x06054b50;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;

export interface ZipLimits {
  entryCap: number;
  uncompressedBytes: number;
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
}

const ALLOWED = new Set(["[Content_Types].xml", "word/document.xml", "word/styles.xml", "word/numbering.xml"]);

export interface DocxPackage {
  files: Map<string, Uint8Array>;
  encrypted: boolean;
}

export async function readDocxPackage(bytes: Uint8Array, limits: ZipLimits | null): Promise<DocxPackage> {
  const entries = readCentralDirectory(bytes);
  if (limits && entries.length > limits.entryCap) {
    throw new DocumentParseError("ZIP_LIMIT_EXCEEDED");
  }
  const encrypted = entries.some((entry) => entry.name === "EncryptionInfo" || entry.name === "EncryptedPackage");
  const hasDocument = entries.some((entry) => entry.name === "word/document.xml");
  const hasContentTypes = entries.some((entry) => entry.name === "[Content_Types].xml");
  if (encrypted && !hasDocument) {
    throw new DocumentParseError("PASSWORD_PROTECTED");
  }
  if (!hasContentTypes) {
    throw new DocumentParseError("UNSUPPORTED_TYPE");
  }
  if (!limits) {
    return { files: new Map(), encrypted };
  }
  const declared = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declared > limits.uncompressedBytes) {
    throw new DocumentParseError("ZIP_LIMIT_EXCEEDED");
  }

  const files = new Map<string, Uint8Array>();
  let remaining = limits.uncompressedBytes;
  for (const entry of entries) {
    if (entry.name.endsWith("/")) {
      continue;
    }
    const inflated = await inflateEntry(bytes, entry, remaining);
    remaining -= inflated.byteLength;
    if (ALLOWED.has(entry.name)) {
      files.set(entry.name, inflated);
    }
  }
  if (!files.has("word/document.xml")) {
    throw new DocumentParseError("CORRUPT");
  }
  return { files, encrypted };
}

function readCentralDirectory(bytes: Uint8Array): ZipEntry[] {
  const eocd = findEocd(bytes);
  if (!eocd) {
    throw new DocumentParseError("CORRUPT");
  }
  if (eocd.totalEntries === ZIP64_MARKER_16 || eocd.cdSize === ZIP64_MARKER_32 || eocd.cdOffset === ZIP64_MARKER_32) {
    throw new DocumentParseError("CORRUPT");
  }
  if (eocd.cdOffset + eocd.cdSize > bytes.length) {
    throw new DocumentParseError("CORRUPT");
  }

  const entries: ZipEntry[] = [];
  let offset = eocd.cdOffset;
  const end = eocd.cdOffset + eocd.cdSize;
  for (let index = 0; index < eocd.totalEntries; index += 1) {
    if (offset + 46 > end || readU32(bytes, offset) !== CENTRAL_HEADER) {
      throw new DocumentParseError("CORRUPT");
    }
    const method = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const uncompressedSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const commentLength = readU16(bytes, offset + 32);
    const localOffset = readU32(bytes, offset + 42);
    if (compressedSize === ZIP64_MARKER_32 || uncompressedSize === ZIP64_MARKER_32 || localOffset === ZIP64_MARKER_32) {
      throw new DocumentParseError("CORRUPT");
    }
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > end) {
      throw new DocumentParseError("CORRUPT");
    }
    entries.push({
      name: normalizeZipName(new TextDecoder().decode(bytes.subarray(nameStart, nameEnd))),
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

async function inflateEntry(bytes: Uint8Array, entry: ZipEntry, maxOutput: number): Promise<Uint8Array> {
  if (entry.localOffset < 0 || entry.localOffset + 30 > bytes.length || readU32(bytes, entry.localOffset) !== LOCAL_HEADER) {
    throw new DocumentParseError("CORRUPT");
  }
  const nameLength = readU16(bytes, entry.localOffset + 26);
  const extraLength = readU16(bytes, entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) {
    throw new DocumentParseError("CORRUPT");
  }
  const compressed = bytes.subarray(dataStart, dataEnd);
  if (entry.method === 0) {
    if (compressed.byteLength > maxOutput) {
      throw new DocumentParseError("ZIP_LIMIT_EXCEEDED");
    }
    return compressed;
  }
  if (entry.method !== 8) {
    throw new DocumentParseError("CORRUPT");
  }
  return inflateRawLimited(compressed, maxOutput);
}

async function inflateRawLimited(compressed: Uint8Array, maxOutput: number): Promise<Uint8Array> {
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const step = await reader.read();
      if (step.done) {
        break;
      }
      total += step.value.byteLength;
      if (total > maxOutput) {
        await reader.cancel();
        throw new DocumentParseError("ZIP_LIMIT_EXCEEDED");
      }
      chunks.push(step.value);
    }
  } catch (error) {
    if (error instanceof DocumentParseError) {
      throw error;
    }
    throw new DocumentParseError("CORRUPT");
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function findEocd(bytes: Uint8Array): { totalEntries: number; cdSize: number; cdOffset: number } | null {
  const start = Math.max(0, bytes.length - 65557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (readU32(bytes, offset) !== EOCD_HEADER) {
      continue;
    }
    const commentLength = readU16(bytes, offset + 20);
    if (offset + 22 + commentLength !== bytes.length) {
      continue;
    }
    return {
      totalEntries: readU16(bytes, offset + 10),
      cdSize: readU32(bytes, offset + 12),
      cdOffset: readU32(bytes, offset + 16),
    };
  }
  return null;
}

function normalizeZipName(name: string): string {
  return name.replaceAll("\\", "/").replace(/^\/+/u, "");
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new DocumentParseError("CORRUPT");
  }
  return bytes[offset]! | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new DocumentParseError("CORRUPT");
  }
  return (
    (bytes[offset]! |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}
