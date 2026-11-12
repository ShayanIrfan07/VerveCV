interface ZipInput {
  name: string;
  data: Uint8Array;
  method?: "store" | "deflate";
  declaredUncompressedSize?: number;
}

export function createStoredZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  return createZip(files.map((file) => ({ ...file, method: "store" as const })));
}

export function createZip(files: ZipInput[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const method = file.method ?? "store";
    if (method === "deflate") {
      throw new Error("Deflate zips are built by the Node test helper");
    }
    const compressed = file.data;
    const declared = file.declaredUncompressedSize ?? file.data.byteLength;
    const name = new TextEncoder().encode(file.name);
    const local = new Uint8Array(30 + name.byteLength + compressed.byteLength);
    writeU32(local, 0, 0x04034b50);
    writeU16(local, 4, 20);
    writeU16(local, 8, 0);
    writeU32(local, 14, crc32(file.data));
    writeU32(local, 18, compressed.byteLength);
    writeU32(local, 22, declared);
    writeU16(local, 26, name.byteLength);
    local.set(name, 30);
    local.set(compressed, 30 + name.byteLength);
    locals.push(local);

    const entry = new Uint8Array(46 + name.byteLength);
    writeU32(entry, 0, 0x02014b50);
    writeU16(entry, 4, 20);
    writeU16(entry, 6, 20);
    writeU16(entry, 10, 0);
    writeU32(entry, 16, crc32(file.data));
    writeU32(entry, 20, compressed.byteLength);
    writeU32(entry, 24, declared);
    writeU16(entry, 28, name.byteLength);
    writeU32(entry, 42, offset);
    entry.set(name, 46);
    central.push(entry);
    offset += local.byteLength;
  }

  const cdSize = central.reduce((total, entry) => total + entry.byteLength, 0);
  const eocd = new Uint8Array(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 8, files.length);
  writeU16(eocd, 10, files.length);
  writeU32(eocd, 12, cdSize);
  writeU32(eocd, 16, offset);
  return concat([...locals, ...central, eocd]);
}

const CRC_TABLE = buildCrcTable();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}
