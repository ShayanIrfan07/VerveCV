import type { EvaluationFinding, EvidenceReference, ResumeBlock, ResumeDocument, WithheldRuleResult } from "./model.js";
import { CRITERION_MAXIMA, RUBRIC_VERSION } from "./rubric.js";

const STYLE_PROPERTIES = [
  ["fontSize", "font size"],
  ["bold", "bold styling"],
  ["italic", "italic styling"],
  ["underline", "underlining"],
] as const;

/**
 * Reports formatting differences only when every block in the comparison has that
 * property recorded by the parser. The six points stay withheld: the source does
 * not define what one formatting place is, or how exactly two places score.
 */
export function formattingConsistencyRule(document: ResumeDocument): WithheldRuleResult {
  return {
    ruleId: "formatting-consistency",
    maxScore: CRITERION_MAXIMA.formattingConsistency,
    score: null,
    status: "withheld",
    reasonCode: "OPEN_DECISION",
    findings: collectFormattingFindings(document),
    version: RUBRIC_VERSION,
  };
}

function collectFormattingFindings(document: ResumeDocument): EvaluationFinding[] {
  const findings: EvaluationFinding[] = [];
  const headings = document.blocks.filter((block) => block.type === "heading");
  findings.push(...capitalizationFindings(headings));
  findings.push(...styleFindings(headings, "Section headings"));

  const bulletsBySection = new Map<string, ResumeBlock[]>();
  for (const block of document.blocks) {
    if (block.type !== "bullet") {
      continue;
    }
    const group = bulletsBySection.get(block.sectionId) ?? [];
    group.push(block);
    bulletsBySection.set(block.sectionId, group);
  }
  for (const group of bulletsBySection.values()) {
    findings.push(...styleFindings(group, "Bullets in this section"));
  }
  return findings;
}

function capitalizationFindings(headings: readonly ResumeBlock[]): EvaluationFinding[] {
  const classified = headings.flatMap((block) => {
    const kind = capitalization(block.text);
    return kind === null ? [] : [{ block, value: kind }];
  });
  return observations(
    classified,
    "formatting-capitalization",
    "Section headings do not use the same capitalization.",
  );
}

function styleFindings(blocks: readonly ResumeBlock[], scope: string): EvaluationFinding[] {
  const findings: EvaluationFinding[] = [];
  for (const [property, label] of STYLE_PROPERTIES) {
    const comparable = provenValues(blocks, property);
    if (comparable === null) {
      continue;
    }
    findings.push(
      ...observations(comparable, `formatting-${property}`, `${scope} do not share the same ${label}.`),
    );
  }
  return findings;
}

function observations(
  rows: ReadonlyArray<{ block: ResumeBlock; value: string | number | boolean }>,
  ruleId: string,
  message: string,
): EvaluationFinding[] {
  return representativeBlocks(rows).map((block) => ({
    id: `${ruleId}:${block.id}`,
    ruleId,
    category: "formatting",
    severity: "info",
    message,
    confidence: "high",
    evidence: [evidenceFor(block)],
    status: "active",
  }));
}

function representativeBlocks(
  rows: ReadonlyArray<{ block: ResumeBlock; value: string | number | boolean }>,
): ResumeBlock[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = String(row.value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size < 2) {
    return [];
  }
  let largest = 0;
  for (const count of counts.values()) {
    largest = Math.max(largest, count);
  }
  const leaders = [...counts.entries()].filter(([, count]) => count === largest).map(([key]) => key);
  const leader = leaders.length === 1 ? leaders[0] : undefined;
  const example = rows.find((row) => leader === undefined || String(row.value) !== leader);
  return example ? [example.block] : [];
}

function provenValues(
  blocks: readonly ResumeBlock[],
  property: (typeof STYLE_PROPERTIES)[number][0],
): Array<{ block: ResumeBlock; value: string | number | boolean }> | null {
  if (blocks.length < 2) {
    return null;
  }
  const rows: Array<{ block: ResumeBlock; value: string | number | boolean }> = [];
  for (const block of blocks) {
    const value = styleValue(block, property);
    if (value === undefined) {
      return null;
    }
    rows.push({ block, value });
  }
  return rows;
}

function styleValue(
  block: ResumeBlock,
  property: (typeof STYLE_PROPERTIES)[number][0],
): number | boolean | undefined {
  const style = block.style;
  if (!style || !Object.hasOwn(style, property)) {
    return undefined;
  }
  const value = style[property];
  if (property === "fontSize") {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  return typeof value === "boolean" ? value : undefined;
}

function capitalization(text: string): "upper" | "lower" | "mixed" | null {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (letters.length === 0) {
    return null;
  }
  if (letters.every((character) => character.toUpperCase() === character && character.toLowerCase() !== character)) {
    return "upper";
  }
  if (letters.every((character) => character.toLowerCase() === character && character.toUpperCase() !== character)) {
    return "lower";
  }
  return "mixed";
}

function evidenceFor(block: ResumeBlock): EvidenceReference {
  return {
    blockId: block.id,
    startOffset: 0,
    endOffset: block.text.length,
    ...(block.page === undefined ? {} : { page: block.page }),
  };
}
