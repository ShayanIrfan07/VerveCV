import { describe, expect, it } from "vitest";
import { assessBulletQuality } from "./bullets.js";
import type { ResumeBlock, ResumeDocument, ResumeSectionKind } from "./model.js";

describe("phase 5A bullet measurement", () => {
  it("ignores headings and contact lines and keeps a short resume below the five-bullet unlock", () => {
    const document = resume([
      ["WORK_EXPERIENCE", "heading", "Work Experience"],
      ["WORK_EXPERIENCE", "bullet", "Shipped the export pipeline."],
      ["CONTACT", "bullet", "ada@example.com"],
      ["SKILLS", "bullet", "TypeScript"],
    ]);
    const result = assessBulletQuality(document);
    expect(result.eligibleCount).toBe(1);
    expect(result.unlock).toBe("below-minimum");
    expect(result.length.appliedToScore).toBe(false);
    expect(result.length.band).toBeNull();
    expect(result.length.readings).toEqual([{ blockId: "block-1", words: 4, meetsMinimum: false }]);
    expect(result.actionVerbs.reason).toBe("A3");
    expect(result.quantifiedMetrics.reason).toBe("A4");
    expect(result.impactMetrics.reason).toBe("A5");
    expect(result.bulletsPerRole.reason).toBe("A13");
  });

  it("counts a multiline bullet once and keeps technical tokens intact", () => {
    const text = "Built Node.js and C# services\nfor CI/CD across end\u2011to\u2011end payments.";
    const document = resume([["WORK_EXPERIENCE", "bullet", text]]);
    const reading = assessBulletQuality(document).length.readings[0];
    expect(reading?.words).toBe(10);
    expect(reading?.meetsMinimum).toBe(false);
  });

  it("prepares the length band for five clean bullets and does not apply it", () => {
    const long = "Reduced review time by shipping one shared pipeline for the export service team.";
    const document = resume(Array.from({ length: 5 }, () => ["WORK_EXPERIENCE", "bullet", long] as const));
    const result = assessBulletQuality(document);
    expect(result.unlock).toBe("open");
    expect(result.length.readings.every((item) => item.words >= 12 && item.meetsMinimum)).toBe(true);
    expect(result.length.band).toEqual({ status: "scored", score: 7 });
    expect(result.length.appliedToScore).toBe(false);
  });

  it("drops a repeated extraction of the same paragraph before counting words", () => {
    const document = resume([
      ["WORK_EXPERIENCE", "bullet", "Shipped the export pipeline for the billing service this quarter."],
      ["WORK_EXPERIENCE", "bullet", "Shipped the export pipeline for the billing service this quarter."],
    ]);
    const first = document.blocks[0];
    const second = document.blocks[1];
    if (first && second) {
      first.paragraphId = "p-1";
      second.paragraphId = "p-1";
    }
    const result = assessBulletQuality(document);
    expect(result.eligibleCount).toBe(1);
    expect(result.unlock).toBe("below-minimum");
    expect(result.length.excludedBlockIds).toEqual(["block-1"]);
    expect(result.length.readings).toHaveLength(1);
    expect(result.length.band).toBeNull();
  });
});

function resume(rows: ReadonlyArray<readonly [ResumeSectionKind, ResumeBlock["type"], string]>): ResumeDocument {
  const sections = new Map<ResumeSectionKind, { id: string; kind: ResumeSectionKind; heading: string; blockIds: string[] }>();
  const blocks: ResumeBlock[] = [];
  rows.forEach(([kind, type, text], index) => {
    const section = sections.get(kind) ?? { id: `section-${kind}`, kind, heading: kind, blockIds: [] };
    sections.set(kind, section);
    const id = `block-${index}`;
    section.blockIds.push(id);
    blocks.push({ id, sectionId: section.id, type, text, startOffset: 0, endOffset: text.length });
  });
  return {
    id: "resume",
    version: 1,
    filename: "Ada_Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [...sections.values()],
    blocks,
    metadata: {},
  };
}
