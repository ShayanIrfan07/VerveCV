import { bulletLengthScore, type BandScore } from "./bands.js";
import { extractionArtifactIds, runningHeaderIds, TOKENIZER_VERSION, tokenizeWords } from "./detectors.js";
import type { ResumeBlock, ResumeDocument, ResumeSectionKind } from "./model.js";

/**
 * Phase 5A length measurement. This function does not apply a score.
 * evaluate() reads the readings and applies the existing length band.
 */
export const BULLET_ASSESSMENT_VERSION = "bullet-assessment-2026-11-26-v1";

const BULLET_SECTIONS = new Set<ResumeSectionKind>(["WORK_EXPERIENCE", "LEADERSHIP_EXPERIENCE", "PROJECTS"]);
const MINIMUM_WORDS = 12;

export interface BulletLengthReading {
  blockId: string;
  words: number;
  meetsMinimum: boolean;
}

export interface BulletQualityAssessment {
  version: typeof BULLET_ASSESSMENT_VERSION;
  eligibleCount: number;
  unlock: "below-minimum" | "open";
  length: {
    tokenizerVersion: typeof TOKENIZER_VERSION;
    appliedToScore: false;
    reason: "A2";
    excludedBlockIds: string[];
    readings: BulletLengthReading[];
    band: BandScore | null;
  };
  actionVerbs: { appliedToScore: false; reason: "A3" };
  quantifiedMetrics: { appliedToScore: false; reason: "A4" };
  impactMetrics: { appliedToScore: false; reason: "A5" };
  bulletsPerRole: { appliedToScore: false; reason: "A13" };
}

export function assessBulletQuality(document: ResumeDocument): BulletQualityAssessment {
  const eligible = bulletBlocks(document);
  const excluded = excludedIds(eligible);
  const measured = eligible.filter((block) => !excluded.has(block.id));
  const readings = measured.map(readingFor);
  const open = eligible.length >= 5;
  const comparable = open && excluded.size === 0;
  const percent = readings.length === 0 ? 0 : (readings.filter((item) => item.meetsMinimum).length / readings.length) * 100;
  return {
    version: BULLET_ASSESSMENT_VERSION,
    eligibleCount: eligible.length,
    unlock: open ? "open" : "below-minimum",
    length: {
      tokenizerVersion: TOKENIZER_VERSION,
      appliedToScore: false,
      reason: "A2",
      excludedBlockIds: [...excluded].sort(),
      readings,
      band: comparable ? bulletLengthScore(percent) : null,
    },
    actionVerbs: { appliedToScore: false, reason: "A3" },
    quantifiedMetrics: { appliedToScore: false, reason: "A4" },
    impactMetrics: { appliedToScore: false, reason: "A5" },
    bulletsPerRole: { appliedToScore: false, reason: "A13" },
  };
}

function readingFor(block: ResumeBlock): BulletLengthReading {
  const words = tokenizeWords(block.text).length;
  return { blockId: block.id, words, meetsMinimum: words >= MINIMUM_WORDS };
}

function bulletBlocks(document: ResumeDocument): ResumeBlock[] {
  const sections = new Map(document.sections.map((section) => [section.id, section.kind]));
  return document.blocks.filter((block) => {
    if (block.type !== "bullet") {
      return false;
    }
    const kind = sections.get(block.sectionId);
    return kind !== undefined && BULLET_SECTIONS.has(kind);
  });
}

function excludedIds(blocks: readonly ResumeBlock[]): Set<string> {
  const tokenBlocks = blocks.map((block) => ({
    text: block.text,
    id: block.id,
    ...(block.paragraphId === undefined ? {} : { paragraphId: block.paragraphId }),
    ...(block.page === undefined ? {} : { page: block.page }),
    ...(block.boxes === undefined ? {} : { boxes: block.boxes }),
  }));
  return new Set([...extractionArtifactIds(tokenBlocks), ...runningHeaderIds(tokenBlocks)]);
}
