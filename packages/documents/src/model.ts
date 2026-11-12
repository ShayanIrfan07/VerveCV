import type { BoundingBox, ResumeBlock, ResumeDocument, ResumeSection, ResumeSectionKind } from "@vervecv/evaluation";
import { classifyHeading } from "./headings.js";

export const PARSER_VERSION = "pdfjs-dist@6.5.438+mammoth@1.13.0";

export interface SourceBlock {
  text: string;
  type: "paragraph" | "bullet";
  page?: number;
  boxes?: BoundingBox[];
  paragraphId?: string;
  style?: Record<string, unknown>;
}

export interface DocumentMeta {
  filename: string;
  mimeType: string;
  sourceHash: string;
  metadata: Record<string, unknown>;
}

export function toResumeDocument(meta: DocumentMeta, sourceBlocks: SourceBlock[]): ResumeDocument {
  const sections: ResumeSection[] = [];
  const blocks: ResumeBlock[] = [];
  let current: ResumeSection | null = null;
  let cursor = 0;

  const openSection = (kind: ResumeSectionKind, heading: string): ResumeSection => {
    const section: ResumeSection = {
      id: `section-${sections.length}`,
      kind,
      heading,
      blockIds: [],
    };
    sections.push(section);
    current = section;
    return section;
  };

  for (const source of sourceBlocks) {
    const text = source.text.replace(/\s+$/u, "");
    if (text.trim().length === 0) {
      continue;
    }
    const kind = classifyHeading(text);
    if (kind) {
      openSection(kind, text.trim());
    }
    const section = current ?? openSection("OTHER", "");
    const startOffset = cursor;
    const endOffset = startOffset + text.length;
    const block: ResumeBlock = {
      id: `block-${blocks.length}`,
      sectionId: section.id,
      type: kind ? "heading" : source.type,
      text,
      startOffset,
      endOffset,
      ...(source.page === undefined ? {} : { page: source.page }),
      ...(source.boxes && source.boxes.length > 0 ? { boxes: source.boxes } : {}),
      ...(source.paragraphId === undefined ? {} : { paragraphId: source.paragraphId }),
      ...(source.style && Object.keys(source.style).length > 0 ? { style: source.style } : {}),
    };
    blocks.push(block);
    section.blockIds.push(block.id);
    cursor = endOffset + 1;
  }

  return {
    id: meta.sourceHash,
    version: 1,
    filename: meta.filename,
    mimeType: meta.mimeType,
    sourceHash: meta.sourceHash,
    parserVersion: PARSER_VERSION,
    sections,
    blocks,
    metadata: { ...meta.metadata, nonTextContentRead: false, textJoin: "\n" },
  };
}
