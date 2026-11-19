import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { formattingConsistencyRule } from "./formatting.js";
import type { ResumeBlock, ResumeDocument, ResumeSection } from "./model.js";

const options = { candidateType: null, candidateName: null, jobDescription: null };

describe("formatting observations", () => {
  it("notes a proven bullet font-size difference without scoring it", () => {
    const plain = workBullets([
      { text: "Shipped the API.", style: { fontSize: 11 } },
      { text: "Cut the latency.", style: { fontSize: 11 } },
    ]);
    const mixed = workBullets([
      { text: "Shipped the API.", style: { fontSize: 11 } },
      { text: "Cut the latency.", style: { fontSize: 12 } },
    ]);
    const without = evaluate(plain, options);
    const withDifference = evaluate(mixed, options);

    expect(formattingConsistencyRule(plain).findings).toEqual([]);
    const rule = formattingConsistencyRule(mixed);
    expect(rule.status).toBe("withheld");
    expect(rule.score).toBeNull();
    expect(rule.reasonCode).toBe("OPEN_DECISION");
    expect(rule.findings.map((finding) => finding.message)).toEqual([
      "Bullets in this section do not share the same font size.",
    ]);
    expect(rule.findings[0]?.evidence[0]).toMatchObject({ blockId: "bullet-0", startOffset: 0, endOffset: 16 });
    expect(withDifference.baseScore).toBe(without.baseScore);
    expect(withDifference.denominator).toBe(without.denominator);
    expect(withDifference.criteria.find((item) => item.ruleId === "readability")?.status).toBe("withheld");
    expect(withDifference.criteria.find((item) => item.ruleId === "formatting-consistency")?.status).toBe("withheld");
  });

  it("does not treat a missing style property as an inconsistency", () => {
    const document = workBullets([
      { text: "Shipped the API.", style: { fontSize: 11 } },
      { text: "Cut the latency." },
    ]);
    const messages = formattingConsistencyRule(document).findings.map((finding) => finding.message);
    expect(messages).toEqual([]);
  });

  it("ignores font names, including subset prefixes", () => {
    const document = workBullets([
      { text: "Shipped the API.", style: { fontFamily: "ABCDEF+Calibri", fontSize: 11 } },
      { text: "Cut the latency.", style: { fontFamily: "GHIJKL+Times", fontSize: 11 } },
    ]);
    expect(formattingConsistencyRule(document).findings).toEqual([]);
  });

  it("notes mixed section-heading capitalization and shared heading weight", () => {
    const document = documentWith([
      heading("Experience", { bold: true }),
      heading("SKILLS", { bold: false }),
    ]);
    const messages = formattingConsistencyRule(document).findings.map((finding) => finding.message);
    expect(messages).toEqual([
      "Section headings do not use the same capitalization.",
      "Section headings do not share the same bold styling.",
    ]);
  });
});

function workBullets(items: Array<{ text: string; style?: Record<string, unknown> }>): ResumeDocument {
  return documentWith(items.map((item, index) => bullet(index, item.text, item.style)));
}

function documentWith(blocks: ResumeBlock[]): ResumeDocument {
  const section: ResumeSection = {
    id: "work",
    kind: "WORK_EXPERIENCE",
    heading: "Experience",
    blockIds: blocks.map((block) => block.id),
  };
  return {
    id: "resume",
    version: 1,
    filename: "Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [section],
    blocks,
    metadata: {},
  };
}

function bullet(index: number, text: string, style?: Record<string, unknown>): ResumeBlock {
  return block(`bullet-${index}`, "bullet", text, style);
}

function heading(text: string, style?: Record<string, unknown>): ResumeBlock {
  return block(`heading-${text}`, "heading", text, style);
}

function block(id: string, type: string, text: string, style?: Record<string, unknown>): ResumeBlock {
  return {
    id,
    sectionId: "work",
    type,
    text,
    startOffset: 0,
    endOffset: text.length,
    ...(style ? { style } : {}),
  };
}
