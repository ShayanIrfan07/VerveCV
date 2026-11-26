import { extractionArtifactIds, runningHeaderIds, tokenizeWords } from "./detectors.js";
import type { ResumeBlock, ResumeDocument, ResumeSection, ResumeSectionKind } from "./model.js";

const ENTRY_SECTIONS = new Set<ResumeSectionKind>(["WORK_EXPERIENCE", "LEADERSHIP_EXPERIENCE", "PROJECTS"]);

const DATE_PATTERN =
  /\b(?:(?:0?[1-9]|1[0-2])[/.](?:19|20)\d{2}|(?:19|20)\d{2}(?:[/.](?:0?[1-9]|1[0-2]))?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?:19|20)\d{2}|present|current)\b/iu;

export interface ParsedEntry {
  id: string;
  sectionId: string;
  sectionKind: ResumeSectionKind;
  status: "parsed";
  headerBlockIds: string[];
  bulletBlockIds: string[];
  dateText: string | null;
}

export interface EntryParseIssue {
  sectionId: string;
  status: "ambiguous" | "unsupported";
  reason: "uncertain-boundary" | "unassigned-bullets" | "header-without-bullets" | "missing-block";
  blockIds: string[];
}

export interface EntryParseResult {
  entries: ParsedEntry[];
  issues: EntryParseIssue[];
}

/**
 * Groups bullets under a preceding header only when every header line is a short
 * non-sentence line. A line of 12 or more words is prose even when it has no
 * sentence punctuation, and that line stays ambiguous instead of becoming a role.
 * Wrapped PDF lines join the previous bullet or header.
 * Prose, mixed geometry, and bullets with no header stay unassigned.
 */
export function parseEntries(document: ResumeDocument): EntryParseResult {
  const byId = new Map(document.blocks.map((block) => [block.id, block]));
  const ignored = new Set<string>([
    ...extractionArtifactIds(document.blocks),
    ...runningHeaderIds(document.blocks),
  ]);
  const entries: ParsedEntry[] = [];
  const issues: EntryParseIssue[] = [];
  for (const section of document.sections) {
    if (!ENTRY_SECTIONS.has(section.kind)) {
      continue;
    }
    const blocks: ResumeBlock[] = [];
    for (const id of section.blockIds) {
      const block = byId.get(id);
      if (!block) {
        issues.push({ sectionId: section.id, status: "unsupported", reason: "missing-block", blockIds: [id] });
        continue;
      }
      if (block.type === "heading" || ignored.has(block.id)) {
        continue;
      }
      blocks.push(block);
    }
    parseSection(section, blocks, entries, issues);
  }
  return { entries, issues };
}

function parseSection(
  section: ResumeSection,
  blocks: readonly ResumeBlock[],
  entries: ParsedEntry[],
  issues: EntryParseIssue[],
): void {
  let header: ResumeBlock[] = [];
  let bullets: ResumeBlock[] = [];
  let uncertain = false;

  const close = (): void => {
    const headerIds = header.map((block) => block.id);
    const bulletIds = bullets.map((block) => block.id);
    if (uncertain) {
      if (headerIds.length > 0 || bulletIds.length > 0) {
        issues.push({
          sectionId: section.id,
          status: "ambiguous",
          reason: "uncertain-boundary",
          blockIds: [...headerIds, ...bulletIds],
        });
      }
    } else if (header.length > 0 && bullets.length > 0) {
      const lines = header.map((block) => block.text);
      entries.push({
        id: `entry:${section.id}:${header[0]?.id ?? "unknown"}`,
        sectionId: section.id,
        sectionKind: section.kind,
        status: "parsed",
        headerBlockIds: headerIds,
        bulletBlockIds: bulletIds,
        dateText: dateText(lines),
      });
    } else if (bullets.length > 0) {
      issues.push({ sectionId: section.id, status: "unsupported", reason: "unassigned-bullets", blockIds: bulletIds });
    } else if (header.length > 0) {
      issues.push({ sectionId: section.id, status: "unsupported", reason: "header-without-bullets", blockIds: headerIds });
    }
    header = [];
    bullets = [];
    uncertain = false;
  };

  for (const block of blocks) {
    if (block.type === "bullet") {
      bullets.push(block);
      continue;
    }
    if (bullets.length > 0) {
      const previous = bullets[bullets.length - 1];
      if (previous && isBulletContinuation(previous, block)) {
        bullets.push(block);
        continue;
      }
      close();
    }
    if (header.length === 0) {
      header = [block];
      uncertain = isProse(block.text);
      continue;
    }
    const previous = header[header.length - 1];
    if (previous && joinsAsDate(previous, block)) {
      header.push(block);
      continue;
    }
    const joined = header.some((line) => canJoinHeader(line, block));
    if (!joined || isProse(block.text) || header.length >= 3) {
      uncertain = true;
    }
    header.push(block);
  }
  close();
}

function joinsAsDate(previous: ResumeBlock, next: ResumeBlock): boolean {
  if (!isDateLine(next.text) || isProse(next.text)) {
    return false;
  }
  return canJoinHeader(previous, next) || sameBaseline(previous, next);
}

function isDateLine(text: string): boolean {
  const stripped = text
    .replace(/\b(?:present|current|(?:19|20)\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/giu, " ")
    .replace(/[-–—/,]/gu, " ")
    .trim();
  return stripped.length === 0 && text.trim().length > 0;
}

function sameBaseline(previous: ResumeBlock, next: ResumeBlock): boolean {
  const above = previous.boxes?.[0];
  const below = next.boxes?.[0];
  if (!above || !below || above.page !== below.page) {
    return false;
  }
  return Math.abs(above.y - below.y) <= 3 && below.x >= above.x;
}

function canJoinHeader(previous: ResumeBlock, next: ResumeBlock): boolean {
  const previousBox = previous.boxes?.[0];
  const nextBox = next.boxes?.[0];
  if (previousBox && nextBox) {
    return isVerticalNeighbor(previous, next, 16);
  }
  if (previousBox || nextBox) {
    return false;
  }
  return !isProse(previous.text) && !isProse(next.text);
}

function isBulletContinuation(previous: ResumeBlock, next: ResumeBlock): boolean {
  return isVerticalNeighbor(previous, next, 72);
}

function isVerticalNeighbor(previous: ResumeBlock, next: ResumeBlock, maxIndent: number): boolean {
  const above = previous.boxes?.[0];
  const below = next.boxes?.[0];
  if (!above || !below || above.page !== below.page) {
    return false;
  }
  const rise = above.y - below.y;
  return rise >= 4 && rise <= 30 && below.x >= above.x - 8 && below.x - above.x <= maxIndent;
}

function isProse(text: string): boolean {
  const trimmed = text.trim();
  return tokenizeWords(trimmed).length >= 12;
}

function dateText(lines: readonly string[]): string | null {
  return lines.join(" ").match(DATE_PATTERN)?.[0] ?? null;
}
