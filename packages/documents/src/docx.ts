import { createStoredZip } from "./zip-write.js";
import { DocumentParseError, withTimeout } from "./errors.js";
import { matchesMagic } from "./magic.js";
import { toResumeDocument, type DocumentMeta, type SourceBlock } from "./model.js";
import { readDocxPackage, type ZipLimits } from "./zip.js";

export interface DocxLimits {
  entryCap: number;
  uncompressedBytes: number;
  timeoutMs: number;
}

interface MammothNode {
  type?: string;
  children?: MammothNode[];
  value?: string;
  styleId?: string | null;
  styleName?: string | null;
  numbering?: unknown;
  isBold?: boolean;
  isItalic?: boolean;
  isUnderline?: boolean;
  font?: string | null;
  fontSize?: number | null;
}

interface MammothApi {
  convertToHtml(
    input: { buffer: Uint8Array; arrayBuffer: ArrayBuffer },
    options?: { transformDocument?: (element: MammothNode) => MammothNode },
  ): Promise<{ value: string }>;
}

interface RunSlice {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  font?: string;
  fontSize?: number;
}

export async function extractDocx(
  bytes: Uint8Array,
  meta: DocumentMeta,
  limits: DocxLimits | null,
): Promise<ReturnType<typeof toResumeDocument>> {
  if (!matchesMagic(bytes, "docx")) {
    throw new DocumentParseError("UNSUPPORTED_TYPE");
  }
  const timeoutMs = limits?.timeoutMs ?? 0;
  const read = async (): Promise<ReturnType<typeof toResumeDocument>> => {
    const zipLimits: ZipLimits | null = limits
      ? { entryCap: limits.entryCap, uncompressedBytes: limits.uncompressedBytes }
      : null;
    const pack = await readDocxPackage(bytes, zipLimits);
    const payload = limits ? repackage(pack.files) : bytes;
    const blocks = await readParagraphs(payload);
    const document = toResumeDocument(meta, blocks);
    if (document.blocks.length === 0) {
      throw new DocumentParseError("NO_EXTRACTABLE_TEXT");
    }
    return document;
  };
  if (!limits) {
    return read();
  }
  return withTimeout(timeoutMs, async (signal) => {
    if (signal.aborted) {
      throw new DocumentParseError("PARSE_TIMEOUT");
    }
    return read();
  });
}

function repackage(files: Map<string, Uint8Array>): Uint8Array {
  return createStoredZip([...files.entries()].map(([name, data]) => ({ name, data })));
}

async function readParagraphs(bytes: Uint8Array): Promise<SourceBlock[]> {
  const mammoth = await loadMammoth();
  const blocks: SourceBlock[] = [];
  let paragraphIndex = 0;
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await mammoth.convertToHtml(
    // Node reads buffer. The browser build reads arrayBuffer.
    { buffer: bytes, arrayBuffer },
    {
      transformDocument(document) {
        walk(document, blocks, () => {
          const id = `p-${paragraphIndex}`;
          paragraphIndex += 1;
          return id;
        });
        return document;
      },
    },
  );
  return blocks;
}

function walk(node: MammothNode, blocks: SourceBlock[], nextId: () => string): void {
  if (node.type === "paragraph") {
    const runs = flattenRuns(node, {});
    const text = runs.map((run) => run.text).join("");
    const style = sharedRunStyle(runs.filter((run) => run.text.trim().length > 0));
    const bullet = node.numbering != null || /^[-*•●·]\s+/u.test(text.trim());
    blocks.push({
      text,
      type: bullet ? "bullet" : "paragraph",
      paragraphId: nextId(),
      ...(style ? { style } : {}),
    });
    return;
  }
  for (const child of node.children ?? []) {
    walk(child, blocks, nextId);
  }
}

function flattenRuns(node: MammothNode, inherited: Omit<RunSlice, "text">): RunSlice[] {
  if (node.type === "text") {
    return [{ text: node.value ?? "", ...inherited }];
  }
  if (node.type === "tab") {
    return [{ text: "\t", ...inherited }];
  }
  if (node.type === "break") {
    return [{ text: "\n", ...inherited }];
  }
  const next = node.type === "run" ? runStyle(node, inherited) : inherited;
  return (node.children ?? []).flatMap((child) => flattenRuns(child, next));
}

function runStyle(node: MammothNode, inherited: Omit<RunSlice, "text">): Omit<RunSlice, "text"> {
  return {
    ...inherited,
    ...(node.isBold === undefined ? {} : { bold: node.isBold }),
    ...(node.isItalic === undefined ? {} : { italic: node.isItalic }),
    ...(node.isUnderline === undefined ? {} : { underline: node.isUnderline }),
    ...(typeof node.font === "string" ? { font: node.font } : {}),
    ...(typeof node.fontSize === "number" ? { fontSize: node.fontSize } : {}),
  };
}

function sharedRunStyle(runs: RunSlice[]): Record<string, unknown> | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  const style: Record<string, unknown> = {};
  copyShared(style, "bold", runs.map((run) => run.bold));
  copyShared(style, "italic", runs.map((run) => run.italic));
  copyShared(style, "underline", runs.map((run) => run.underline));
  const fonts = runs.map((run) => run.font);
  if (fonts.every((font) => typeof font === "string" && font === fonts[0])) {
    style["fontFamily"] = fonts[0];
  }
  const sizes = runs.map((run) => run.fontSize);
  if (sizes.every((size) => typeof size === "number" && size === sizes[0])) {
    style["fontSize"] = sizes[0];
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function copyShared(style: Record<string, unknown>, key: string, values: (boolean | undefined)[]): void {
  if (values.every((value) => value === true)) {
    style[key] = true;
  } else if (values.every((value) => value === false)) {
    style[key] = false;
  }
}

async function loadMammoth(): Promise<MammothApi> {
  const imported = (await import("mammoth")) as {
    default?: MammothApi;
    convertToHtml?: MammothApi["convertToHtml"];
  };
  if (imported.convertToHtml) {
    return { convertToHtml: imported.convertToHtml };
  }
  if (imported.default?.convertToHtml) {
    return imported.default;
  }
  throw new DocumentParseError("CORRUPT");
}
