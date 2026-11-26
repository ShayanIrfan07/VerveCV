import { describe, expect, it } from "vitest";
import { assessBulletQuality } from "./bullets.js";
import { aggregate, evaluate } from "./evaluate.js";
import { hasMeasurableImpact } from "./impact.js";
import type { ResumeBlock, ResumeDocument } from "./model.js";
import { hasMeaningfulQuantity } from "./quantities.js";
import { measureRoles } from "./roles.js";

const options = { candidateType: null, candidateName: null, jobDescription: null };
const STRONG = "Reduced review latency by 18 percent for the nightly export pipeline this quarter.";

describe("review fixes", () => {
  it("unlocks five distinct bullets and withholds scoring when one of five is an extraction duplicate", () => {
    const distinct = resume(Array.from({ length: 5 }, (_, index) => bullet(`Delivered the weekly finance report ${index} for the audit team this quarter.`, `p-${index}`)));
    expect(assessBulletQuality(distinct).unlock).toBe("open");
    expect(assessBulletQuality(distinct).eligibleCount).toBe(5);

    const duplicated = resume([
      bullet("Delivered the weekly finance report for the audit team this quarter.", "same"),
      bullet("Delivered the weekly finance report for the audit team this quarter.", "same"),
      bullet("Built the billing service for the finance platform this quarter.", "p-2"),
      bullet("Shipped the audit export for the finance platform this quarter.", "p-3"),
      bullet("Closed the quarterly reconciliation for the finance platform.", "p-4"),
    ]);
    const measured = assessBulletQuality(duplicated);
    expect(measured.eligibleCount).toBe(4);
    expect(measured.unlock).toBe("below-minimum");
    const scored = evaluate(duplicated, options);
    for (const ruleId of ["bullet-length", "action-verbs", "quantified-metrics", "impact-metrics", "minimum-bullets-per-role"]) {
      expect(scored.criteria.find((item) => item.ruleId === ruleId)?.status).toBe("scored");
      expect(scoreOf(scored, ruleId)).toBe(0);
    }
  });

  it("counts five genuine repeats and ignores a running header", () => {
    const repeats = resume(Array.from({ length: 5 }, (_, index) => bullet("Delivered the same weekly finance report for the audit team this quarter.", `repeat-${index}`, 1, 180 + index * 24)));
    expect(assessBulletQuality(repeats).eligibleCount).toBe(5);
    expect(assessBulletQuality(repeats).unlock).toBe("open");

    const header = "Confidential resume header";
    const withHeader = resume([
      boxed(header, 1, 4),
      boxed(header, 2, 4),
      { ...boxed("Experience continued", 2, 400), type: "paragraph" },
      ...Array.from({ length: 4 }, (_, index) => bullet(`Delivered project ${index} for the finance platform this quarter.`, `body-${index}`, 1, 200 + index * 20)),
    ]);
    expect(assessBulletQuality(withHeader).unlock).toBe("below-minimum");
    expect(assessBulletQuality(withHeader).eligibleCount).toBe(4);
  });

  it("accepts an outcome quantity and rejects scale, negation, plans, and a separate headcount", () => {
    expect(hasMeasurableImpact("Reduced latency by 18%.")).toBe(true);
    expect(hasMeasurableImpact("Increased revenue by 30%.")).toBe(true);
    expect(hasMeasurableImpact("Developed 12 APIs.")).toBe(false);
    expect(hasMeasurableImpact("Managed a team of 8 engineers.")).toBe(false);
    expect(hasMeasurableImpact("Increased latency by 18%.")).toBe(false);
    expect(hasMeasurableImpact("Failed to reduce costs by 20%.")).toBe(false);
    expect(hasMeasurableImpact("Planned to increase revenue by 30%.")).toBe(false);
    expect(hasMeasurableImpact("Attempted to reduce downtime by 15%.")).toBe(false);
    expect(hasMeasurableImpact("Reduced costs while managing 12 engineers.")).toBe(false);
    expect(hasMeasurableImpact("Reduced costs by 20% while managing 12 engineers.")).toBe(true);
  });

  it("keeps currency and stated counts, and skips years, versions, phones, and identifiers", () => {
    for (const text of ["$2025", "₹2025", "$2,000", "2024 transactions", "50 invoices", "200 patients", "30 candidates", "12 shipments", "5 lakh in revenue", "10-20", "2.5x", "200 req/s"]) {
      expect(hasMeaningfulQuantity(text), text).toBe(true);
    }
    for (const text of ["2025", "Java 22", "OAuth 2.0", "Jan 12, 2024", "+91 98765 43210", "09876543210", "9876543210", "10.0.0.8", "port 443", "ID 10,000", "serial number SN-44921"]) {
      expect(hasMeaningfulQuantity(text), text).toBe(false);
    }
  });

  it("keeps the employer beside a multi-word title and does not merge or split companies", () => {
    expect(employers(["Senior Software Engineer Acme Technologies", "Jan 2024 – Present"])).toEqual(["acme technologies"]);
    expect(employers(["Acme Technologies Senior Software Engineer", "Jan 2024 – Present"])).toEqual(["acme technologies"]);
    expect(employers(["Senior Software Engineer | Acme Technologies", "Jan 2024 – Present"])).toEqual(["acme technologies"]);
    expect(employers(["Finance Manager — Bright Financial Services", "Jan 2024 – Present"])).toEqual(["bright financial services"]);
    expect(employers(["Acme Technologies — Software Engineer", "Jan 2024 – Present"])).toEqual(["acme technologies"]);
    expect(employers(["Engineer Solutions", "Consultant", "Jan 2024 – Present"])).toEqual(["engineer solutions"]);

    const sameEmployer = resume([
      paragraph("Acme Technologies"),
      paragraph("Senior Software Engineer"),
      paragraph("Jan 2024 – Present"),
      bullet(STRONG, "a", 1, 320),
      paragraph("Analyst"),
      paragraph("Jan 2018 – Dec 2019"),
      bullet("Maintained the ledger for the regional finance team this quarter.", "b", 1, 180),
    ]);
    expect(measureRoles(sameEmployer)?.organizations).toEqual(["acme technologies"]);

    const separate = resume([
      paragraph("Northwind"),
      paragraph("Engineer"),
      paragraph("Jan 2020 - Present"),
      bullet(STRONG, "a", 1, 320),
      paragraph("Globex"),
      paragraph("Analyst"),
      paragraph("Jan 2018 - Dec 2019"),
      bullet("Maintained the ledger for the regional finance team this quarter.", "b", 1, 180),
    ]);
    expect(measureRoles(separate)?.organizations).toEqual(["northwind", "globex"]);
    expect(measureRoles(resume([paragraph("Client: Northwind"), paragraph("Engineer"), paragraph("Jan 2020 - Present"), bullet(STRONG, "a")]))).toBeNull();
    expect(measureRoles(resume([
      paragraph("Northwind"),
      paragraph("Engineer"),
      paragraph("San Francisco"),
      paragraph("Jan 2020 - Present"),
      bullet(STRONG, "a"),
    ]))).toBeNull();
  });

  it("scores zero below the deduplicated minimum and keeps a withheld criterion out of the final score", () => {
    const result = evaluate(resume(Array.from({ length: 4 }, (_, index) => bullet(STRONG, `p-${index}`))), options);
    expect(scoreOf(result, "bullet-length")).toBe(0);
    expect(result.criteria.find((item) => item.ruleId === "grammar-and-spelling")?.status).toBe("withheld");
    expect(result.finalScore).toBeNull();
    const guarded = aggregate(
      [
        { ruleId: "bullet-length", maxScore: 7, status: "scored", score: 0, findings: [], version: "rubric-2026-11-12-provisional" },
        { ruleId: "grammar-and-spelling", maxScore: 10, status: "withheld", score: null, reasonCode: "OPEN_DECISION", findings: [], version: "rubric-2026-11-12-provisional" },
      ],
      [{ penaltyId: "sample", status: "scored", deduction: 0 }],
    );
    expect(guarded.penaltyStatus).toBe("evaluated");
    expect(guarded.finalScore).toBeNull();
  });
});

function scoreOf(result: ReturnType<typeof evaluate>, ruleId: string): number | null {
  const rule = result.criteria.find((item) => item.ruleId === ruleId);
  return rule?.status === "scored" ? rule.score : null;
}

function employers(lines: readonly string[]): string[] | undefined {
  return measureRoles(resume([...lines.map((line) => paragraph(line)), bullet(STRONG, "a")]))?.organizations;
}

function resume(rows: ResumeBlock[]): ResumeDocument {
  return {
    id: "resume",
    version: 1,
    filename: "Ada_Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [{ id: "section-0", kind: "WORK_EXPERIENCE", heading: "Experience", blockIds: rows.map((row) => row.id) }],
    blocks: rows,
    metadata: {},
  };
}

let nextBlock = 0;

function paragraph(text: string): ResumeBlock {
  nextBlock += 1;
  return { id: `p-${nextBlock}`, sectionId: "section-0", type: "paragraph", text, startOffset: 0, endOffset: text.length };
}

function bullet(text: string, paragraphId: string, page = 1, y = 200): ResumeBlock {
  return { ...boxed(text, page, y), type: "bullet", paragraphId };
}

function boxed(text: string, page: number, y: number): ResumeBlock {
  nextBlock += 1;
  return {
    id: `b-${nextBlock}`,
    sectionId: "section-0",
    type: "bullet",
    text,
    startOffset: 0,
    endOffset: text.length,
    page,
    boxes: [{ page, x: 72, y, width: 240, height: 12 }],
  };
}
