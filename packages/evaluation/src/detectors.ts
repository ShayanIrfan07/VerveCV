import type { BoundingBox } from "./model.js";

/**
 * Evidence detectors for Phase 4. Nothing in this module changes a score.
 * evaluate() does not call these functions. Keyword lists are supplied by the
 * caller; this file does not contain a role vocabulary.
 */
export const DETECTOR_VERSION = "detector-2026-11-20-v1";

/** Proposed word count. Not applied to the short-resume penalty. */
export const TOKENIZER_VERSION = "tokenizer-2026-11-20-proposed-v1";

export type DetectionType =
  | "keyword"
  | "pronoun"
  | "email"
  | "linkedin"
  | "special-character"
  | "exact-duplicate"
  | "normalized-duplicate";

export type DetectionQuality = "high" | "insufficient_policy" | "protected" | "unclassified";

/**
 * Highlight coordinates are UTF-16 code-unit indexes into the original string
 * given to the detector. They are not indexes into an NFKC copy. NFKC is used
 * only to find a match, and the match is mapped back before it is returned.
 * `matchEntryBullets` joins the original bullet strings with one "\n" and uses
 * that joined string as its coordinate system. Duplicate-bullet offsets cover
 * the whole original bullet, from 0 through `text.length`.
 * `id` is stable for the same type, scope, identity, and original offsets.
 * Pass a distinct `scope` (entry id or block id) so the same match in two
 * entries does not share an id.
 */
export interface Detection {
  id: string;
  type: DetectionType;
  evidenceText: string;
  startOffset: number;
  endOffset: number;
  blockId?: string;
  sectionId?: string;
  page?: number;
  method: string;
  version: string;
  quality: DetectionQuality;
  canonical?: string;
  digitCount?: number;
}

export interface KeywordTerm {
  id: string;
  canonical: string;
  aliases: readonly string[];
  excludes?: readonly string[];
}

export interface KeywordDictionary {
  version: string;
  terms: readonly KeywordTerm[];
}

interface Span {
  start: number;
  end: number;
}

const PRONOUNS = ["i", "me", "my", "we"] as const;

export function matchEntryBullets(bullets: readonly string[], dictionary: KeywordDictionary, scope?: string): Detection[] {
  const joined = bullets.join("\n");
  return matchKeywords(joined, dictionary, scope).map((hit) => ({ ...hit, method: "entry-bullets" }));
}

export function matchKeywords(text: string, dictionary: KeywordDictionary, scope?: string): Detection[] {
  const aligned = alignNfkc(text);
  const protectedSpans = emailAndUrlSpans(aligned.normalized);
  const aliases = dictionary.terms.flatMap((term) =>
    [term.canonical, ...term.aliases]
      .map((alias) => alias.normalize("NFKC").trim())
      .filter((alias) => alias.length > 0)
      .map((alias) => ({ term, alias })),
  );
  aliases.sort((left, right) => right.alias.length - left.alias.length || left.alias.localeCompare(right.alias));

  const claimed: Span[] = [];
  const hits: Detection[] = [];
  const seenTerms = new Set<string>();
  for (const { term, alias } of aliases) {
    if (seenTerms.has(term.id)) {
      continue;
    }
    const pattern = boundedPattern(alias);
    for (const match of aligned.normalized.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) {
        continue;
      }
      const end = start + match[0].length;
      if (overlaps(claimed, start, end) || overlaps(protectedSpans, start, end) || excluded(aligned.normalized, term, start, end)) {
        continue;
      }
      const original = originalSpan(aligned, start, end);
      if (original === null) {
        continue;
      }
      claimed.push({ start, end });
      seenTerms.add(term.id);
      hits.push(
        detection(
          "keyword",
          "keyword-alias",
          text.slice(original.start, original.end),
          original.start,
          original.end,
          "high",
          { canonical: term.id },
          scope,
        ),
      );
      break;
    }
  }
  return hits.sort((left, right) => left.startOffset - right.startOffset || left.id.localeCompare(right.id));
}

export function tokenizeWords(text: string): string[] {
  const normalized = text
    .normalize("NFKC")
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/gu, "-");
  return tokenizeSegments(normalized);
}

export interface TokenBlock {
  text: string;
  id?: string;
  paragraphId?: string;
  page?: number;
  boxes?: BoundingBox[];
}

export function tokenizeBlocks(blocks: readonly TokenBlock[]): string[] {
  const skip = skippedTokenIndexes(blocks);
  const tokens: string[] = [];
  blocks.forEach((block, index) => {
    if (!skip.has(index) && block.text.trim().length > 0) {
      tokens.push(...tokenizeWords(block.text));
    }
  });
  return tokens;
}

export function detectPronouns(text: string, scope?: string): Detection[] {
  const aligned = alignNfkc(text);
  const blocked = [...emailAndUrlSpans(aligned.normalized), ...quotedSpans(aligned.normalized)];
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${PRONOUNS.join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const hits: Detection[] = [];
  for (const match of aligned.normalized.matchAll(pattern)) {
    const start = match.index;
    const word = match[1];
    if (start === undefined || word === undefined) {
      continue;
    }
    const end = start + word.length;
    if (overlaps(blocked, start, end) || isIeAbbreviation(aligned.normalized, start)) {
      continue;
    }
    const original = originalSpan(aligned, start, end);
    if (original === null) {
      continue;
    }
    hits.push(
      detection(
        "pronoun",
        "whole-token",
        text.slice(original.start, original.end),
        original.start,
        original.end,
        "high",
        { canonical: word.toLowerCase() },
        scope,
      ),
    );
  }
  return hits;
}

export function observeAddresses(text: string, scope?: string): Detection[] {
  const aligned = alignNfkc(text);
  const hits: Detection[] = [];
  for (const match of aligned.normalized.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    const address = match[0];
    const original = originalSpan(aligned, start, start + address.length);
    if (original === null) {
      continue;
    }
    const evidence = text.slice(original.start, original.end);
    const local = address.split("@")[0] ?? "";
    hits.push(
      detection("email", "address-parse", evidence, original.start, original.end, "insufficient_policy", {
        digitCount: digitCount(local),
      }, scope),
    );
  }
  const linkedIn = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|pub)\/([A-Za-z0-9_%-]+)/giu;
  for (const match of aligned.normalized.matchAll(linkedIn)) {
    const start = match.index;
    const slug = match[1];
    if (start === undefined || slug === undefined) {
      continue;
    }
    const url = match[0];
    const original = originalSpan(aligned, start, start + url.length);
    if (original === null) {
      continue;
    }
    hits.push(
      detection(
        "linkedin",
        "address-parse",
        text.slice(original.start, original.end),
        original.start,
        original.end,
        "insufficient_policy",
        { digitCount: digitCount(slug) },
        scope,
      ),
    );
  }
  return hits;
}

export function observeSpecialCharacters(text: string, scope?: string): Detection[] {
  const aligned = alignNfkc(text);
  const protectedSpans = [...emailAndUrlSpans(aligned.normalized), ...technicalSymbolSpans(aligned.normalized)];
  const hits: Detection[] = [];
  for (const match of aligned.normalized.matchAll(/[#=^!]/gu)) {
    const start = match.index;
    const symbol = match[0];
    if (start === undefined || symbol === undefined) {
      continue;
    }
    const original = originalSpan(aligned, start, start + 1);
    if (original === null) {
      continue;
    }
    const protectedUse = overlaps(protectedSpans, start, start + 1);
    hits.push(
      detection(
        "special-character",
        "symbol-scan",
        text.slice(original.start, original.end),
        original.start,
        original.end,
        protectedUse ? "protected" : "unclassified",
        {},
        scope,
      ),
    );
  }
  return hits;
}

export interface DuplicateBullet {
  id: string;
  text: string;
  sectionId?: string;
  paragraphId?: string;
  page?: number;
  boxes?: BoundingBox[];
}

export function findDuplicateBullets(bullets: readonly DuplicateBullet[]): Detection[] {
  const exactSeen = new Map<string, DuplicateBullet>();
  const normalizedSeen = new Map<string, DuplicateBullet>();
  const hits: Detection[] = [];
  for (const bullet of bullets) {
    const exact = bullet.text.normalize("NFKC");
    const normalized = exact.replace(/\s+/gu, " ").trim().toLowerCase();
    if (normalized.length === 0) {
      continue;
    }
    const priorExact = exactSeen.get(exact);
    if (priorExact !== undefined) {
      if (!sameExtractedSource(priorExact, bullet)) {
        hits.push(
          detection("exact-duplicate", "exact-text", bullet.text, 0, bullet.text.length, "high", {
            blockId: bullet.id,
            canonical: priorExact.id,
            ...(bullet.sectionId === undefined ? {} : { sectionId: bullet.sectionId }),
          }),
        );
      }
      continue;
    }
    exactSeen.set(exact, bullet);
    const priorNormalized = normalizedSeen.get(normalized);
    if (priorNormalized !== undefined && !sameExtractedSource(priorNormalized, bullet)) {
      hits.push(
        detection("normalized-duplicate", "case-and-whitespace", bullet.text, 0, bullet.text.length, "high", {
          blockId: bullet.id,
          canonical: priorNormalized.id,
          ...(bullet.sectionId === undefined ? {} : { sectionId: bullet.sectionId }),
        }),
      );
    }
    normalizedSeen.set(normalized, bullet);
  }
  return hits;
}

function tokenizeSegments(text: string): string[] {
  const protectedSpans = emailAndUrlSpans(text).sort((left, right) => left.start - right.start);
  const tokens: string[] = [];
  let cursor = 0;
  for (const span of protectedSpans) {
    if (span.start < cursor) {
      continue;
    }
    tokens.push(...splitWords(text.slice(cursor, span.start)));
    const raw = text.slice(span.start, span.end);
    if (/[\p{L}\p{N}]/u.test(raw)) {
      tokens.push(raw);
    }
    cursor = span.end;
  }
  tokens.push(...splitWords(text.slice(cursor)));
  return tokens;
}

function splitWords(segment: string): string[] {
  const tokens: string[] = [];
  for (const piece of segment.split(/\s+/u)) {
    const trimmed = piece.replace(/^[^\p{L}\p{N}#+.]+|[^\p{L}\p{N}#+./-]+$/gu, "").replace(/\.$/u, "");
    if (/[\p{L}\p{N}]/u.test(trimmed)) {
      tokens.push(trimmed);
    }
  }
  return tokens;
}

function detection(
  type: DetectionType,
  method: string,
  evidenceText: string,
  startOffset: number,
  endOffset: number,
  quality: DetectionQuality,
  extra: { canonical?: string; digitCount?: number; blockId?: string; sectionId?: string; page?: number } = {},
  scope?: string,
): Detection {
  const identity = extra.blockId ?? extra.canonical ?? type;
  const scopePart = scope === undefined || scope.length === 0 ? "" : `${scope}:`;
  return {
    id: `${type}:${scopePart}${identity}:${startOffset}:${endOffset}`,
    type,
    evidenceText,
    startOffset,
    endOffset,
    method,
    version: DETECTOR_VERSION,
    quality,
    ...(extra.blockId === undefined ? {} : { blockId: extra.blockId }),
    ...(extra.sectionId === undefined ? {} : { sectionId: extra.sectionId }),
    ...(extra.page === undefined ? {} : { page: extra.page }),
    ...(extra.canonical === undefined ? {} : { canonical: extra.canonical }),
    ...(extra.digitCount === undefined ? {} : { digitCount: extra.digitCount }),
  };
}

function boundedPattern(alias: string): RegExp {
  const body = alias
    .toLowerCase()
    .split(/\s+/u)
    .map((part) => escapeRegExp(part))
    .join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}#+/]|[.-][\\p{L}\\p{N}])`, "giu");
}

function excluded(text: string, term: KeywordTerm, start: number, end: number): boolean {
  for (const phrase of term.excludes ?? []) {
    const pattern = boundedPattern(phrase);
    for (const match of text.matchAll(pattern)) {
      const phraseStart = match.index;
      if (phraseStart === undefined) {
        continue;
      }
      const phraseEnd = phraseStart + match[0].length;
      if (start >= phraseStart && end <= phraseEnd) {
        return true;
      }
    }
  }
  return false;
}

function emailAndUrlSpans(text: string): Span[] {
  const spans: Span[] = [];
  const add = (pattern: RegExp): void => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start === undefined) {
        continue;
      }
      const trimmed = match[0].replace(/[.,;:!?)\]]+$/u, "");
      if (trimmed.length > 0) {
        spans.push({ start, end: start + trimmed.length });
      }
    }
  };
  add(/https?:\/\/[^\s<>"]+|www\.[^\s<>"]+/giu);
  add(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu);
  return spans;
}

function technicalSymbolSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])(?:[CFQ]#|[CG]\+\+)(?![\p{L}\p{N}])/giu)) {
    if (match.index !== undefined) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

function quotedSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const pattern of [/"([^"\n]*)"/gu, /\u201C([^\u201D\n]*)\u201D/gu, /\u00AB([^\u00BB\n]*)\u00BB/gu]) {
    for (const match of text.matchAll(pattern)) {
      if (match.index !== undefined) {
        spans.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  return spans;
}

export function extractionArtifactIds(blocks: readonly TokenBlock[]): Set<string> {
  return idsAt(blocks, artifactIndexes(blocks));
}

export function runningHeaderIds(blocks: readonly TokenBlock[]): Set<string> {
  return idsAt(blocks, runningHeaderIndexes(blocks, artifactIndexes(blocks)));
}

function skippedTokenIndexes(blocks: readonly TokenBlock[]): Set<number> {
  const artifacts = artifactIndexes(blocks);
  const skip = new Set<number>(artifacts);
  for (const indexes of headerGroups(blocks, artifacts)) {
    for (const index of indexes.slice(1)) {
      skip.add(index);
    }
  }
  return skip;
}

function artifactIndexes(blocks: readonly TokenBlock[]): Set<number> {
  const skip = new Set<number>();
  const seenParagraph = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block.paragraphId === undefined) {
      return;
    }
    const prior = seenParagraph.get(block.paragraphId);
    if (prior === undefined) {
      seenParagraph.set(block.paragraphId, index);
    } else {
      skip.add(index);
    }
  });
  const groups = new Map<string, number[]>();
  for (let index = 0; index < blocks.length; index += 1) {
    if (skip.has(index)) {
      continue;
    }
    const block = blocks[index];
    if (!block) {
      continue;
    }
    const text = block.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
    const page = unionBox(block.boxes)?.page;
    const key = `${page ?? "none"}\0${text}`;
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  }
  for (const indexes of groups.values()) {
    const kept: number[] = [];
    for (const index of indexes) {
      if (kept.some((earlier) => samePaintedLine(blocks[earlier], blocks[index]))) {
        skip.add(index);
        continue;
      }
      kept.push(index);
    }
  }
  return skip;
}

interface AlignedText {
  original: string;
  normalized: string;
  originalIndex: number[];
}

function alignNfkc(text: string): AlignedText {
  const normalized = text.normalize("NFKC");
  const originalIndex: number[] = [];
  let originalCursor = 0;
  let normalizedCursor = 0;
  while (originalCursor < text.length && normalizedCursor < normalized.length) {
    let originalEnd = originalCursor + utf16Width(text, originalCursor);
    let piece = text.slice(originalCursor, originalEnd).normalize("NFKC");
    while (piece.length === 0 && originalEnd < text.length) {
      originalCursor = originalEnd;
      originalEnd = originalCursor + utf16Width(text, originalCursor);
      piece = text.slice(originalCursor, originalEnd).normalize("NFKC");
    }
    while (originalEnd < text.length && !normalized.startsWith(piece, normalizedCursor)) {
      originalEnd += utf16Width(text, originalEnd);
      piece = text.slice(originalCursor, originalEnd).normalize("NFKC");
    }
    if (!normalized.startsWith(piece, normalizedCursor) || piece.length === 0) {
      break;
    }
    for (let index = 0; index < piece.length; index += 1) {
      originalIndex.push(originalCursor);
    }
    originalCursor = originalEnd;
    normalizedCursor += piece.length;
  }
  return {
    original: text,
    normalized: normalizedCursor === normalized.length ? normalized : normalized.slice(0, normalizedCursor),
    originalIndex,
  };
}

function originalSpan(aligned: AlignedText, start: number, end: number): Span | null {
  if (start < 0 || end <= start || end > aligned.originalIndex.length) {
    return null;
  }
  const originalStart = aligned.originalIndex[start];
  const lastOrigin = aligned.originalIndex[end - 1];
  if (originalStart === undefined || lastOrigin === undefined) {
    return null;
  }
  let cursor = end - 1;
  while (cursor + 1 < aligned.originalIndex.length && aligned.originalIndex[cursor + 1] === lastOrigin) {
    cursor += 1;
  }
  const originalEnd = cursor + 1 < aligned.originalIndex.length ? aligned.originalIndex[cursor + 1] : aligned.original.length;
  if (originalEnd === undefined || originalEnd <= originalStart) {
    return null;
  }
  return { start: originalStart, end: originalEnd };
}

function utf16Width(text: string, index: number): number {
  const code = text.codePointAt(index);
  if (code === undefined) {
    return 1;
  }
  return code > 0xffff ? 2 : 1;
}

function runningHeaderIndexes(blocks: readonly TokenBlock[], artifacts: ReadonlySet<number>): Set<number> {
  const indexes = new Set<number>();
  for (const group of headerGroups(blocks, artifacts)) {
    for (const index of group) {
      indexes.add(index);
    }
  }
  return indexes;
}

function headerGroups(blocks: readonly TokenBlock[], artifacts: ReadonlySet<number>): number[][] {
  const groups = new Map<string, number[]>();
  blocks.forEach((block, index) => {
    if (artifacts.has(index)) {
      return;
    }
    const key = block.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(index);
    groups.set(key, group);
  });
  const headers: number[][] = [];
  for (const indexes of groups.values()) {
    const pages = new Set(indexes.map((index) => blocks[index]?.page).filter((page): page is number => page !== undefined));
    if (pages.size >= 2 && indexes.every((index) => isPageEdge(blocks[index], blocks))) {
      headers.push(indexes);
    }
  }
  return headers;
}

function idsAt(blocks: readonly TokenBlock[], indexes: ReadonlySet<number>): Set<string> {
  const ids = new Set<string>();
  for (const index of indexes) {
    const id = blocks[index]?.id;
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids;
}

function sameExtractedSource(left: DuplicateBullet, right: DuplicateBullet): boolean {
  if (left.paragraphId !== undefined && left.paragraphId === right.paragraphId) {
    return true;
  }
  return samePaintedLine(left, right);
}

function samePaintedLine(left: TokenBlock | DuplicateBullet | undefined, right: TokenBlock | DuplicateBullet | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const leftText = left.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const rightText = right.text.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  const leftBox = unionBox(left.boxes);
  const rightBox = unionBox(right.boxes);
  if (leftText.length === 0 || leftText !== rightText || !leftBox || !rightBox || leftBox.page !== rightBox.page) {
    return false;
  }
  return overlapRatio(leftBox, rightBox) >= 0.8;
}

function isPageEdge(block: TokenBlock | undefined, blocks: readonly TokenBlock[]): boolean {
  const box = block ? unionBox(block.boxes) : null;
  if (!box) {
    return false;
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candidate of blocks) {
    for (const item of candidate.boxes ?? []) {
      if (item.page !== box.page) {
        continue;
      }
      min = Math.min(min, item.y);
      max = Math.max(max, item.y + item.height);
    }
  }
  if (!Number.isFinite(min) || max - min < 72) {
    return false;
  }
  return box.y + box.height >= max - 36 || box.y <= min + 36;
}

function unionBox(boxes: readonly BoundingBox[] | undefined): BoundingBox | null {
  const first = boxes?.[0];
  if (!first || !boxes) {
    return null;
  }
  if (boxes.some((box) => box.page !== first.page)) {
    return null;
  }
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const top = Math.max(...boxes.map((box) => box.y + box.height));
  return { page: first.page, x, y, width: right - x, height: top - y };
}

function overlapRatio(left: BoundingBox, right: BoundingBox): number {
  const width = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y);
  if (width <= 0 || height <= 0) {
    return 0;
  }
  const intersection = width * height;
  const minimum = Math.min(left.width * left.height, right.width * right.height);
  return minimum <= 0 ? 0 : intersection / minimum;
}

function isIeAbbreviation(text: string, start: number): boolean {
  return /^i\.e\.?/iu.test(text.slice(start, start + 4));
}

function digitCount(value: string): number {
  return value.replace(/\D/gu, "").length;
}

function overlaps(spans: readonly Span[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
