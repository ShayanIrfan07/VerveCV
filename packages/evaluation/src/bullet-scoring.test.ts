import { describe, expect, it } from "vitest";
import { opensWithActionVerb } from "./action-verbs.js";
import { evaluate } from "./evaluate.js";
import { hasMeasurableImpact } from "./impact.js";
import type { ResumeBlock, ResumeDocument, ResumeSectionKind } from "./model.js";
import { hasMeaningfulQuantity } from "./quantities.js";
import { CRITERION_MAXIMA, RUBRIC_VERSION } from "./rubric.js";

const options = { candidateType: null, candidateName: null, jobDescription: null };
const STRONG = "Reduced review latency by 18 percent for the nightly export pipeline this quarter.";

describe("activated bullet-quality scoring", () => {
  it("keeps every bullet check at zero below five bullets", () => {
    const result = evaluate(workResume(["Northwind", "Engineer", "Jan 2020 - Present"], [STRONG, STRONG, STRONG, STRONG]), options);
    for (const ruleId of ["bullet-length", "action-verbs", "quantified-metrics", "impact-metrics", "minimum-bullets-per-role"]) {
      expect(scoreOf(result, ruleId)).toBe(0);
    }
    expect(result.finalScore).toBeNull();
  });

  it("awards the full 35 bullet points for five measurable outcomes in one dated role", () => {
    const result = evaluate(workResume(["Northwind", "Engineer", "Jan 2020 - Present"], Array.from({ length: 5 }, () => STRONG)), options);
    expect(scoreOf(result, "bullet-length")).toBe(7);
    expect(scoreOf(result, "action-verbs")).toBe(10);
    expect(scoreOf(result, "quantified-metrics")).toBe(6);
    expect(scoreOf(result, "impact-metrics")).toBe(6);
    expect(scoreOf(result, "minimum-bullets-per-role")).toBe(6);
    const bulletTotal = ["bullet-length", "action-verbs", "quantified-metrics", "impact-metrics", "minimum-bullets-per-role"]
      .reduce((sum, ruleId) => sum + (scoreOf(result, ruleId) ?? 0), 0);
    expect(bulletTotal).toBe(CRITERION_MAXIMA.bulletLength + CRITERION_MAXIMA.actionVerbs + CRITERION_MAXIMA.quantifiedMetrics + CRITERION_MAXIMA.impactMetrics + CRITERION_MAXIMA.minimumBulletsPerRole);
    expect(bulletTotal).toBe(35);
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
    expect(result.finalScore).toBeNull();
    expect(result.scoreStatus).toBe("PROVISIONAL");
    expect(JSON.stringify(result)).not.toContain("action-verbs-2026-11-26-v1");
    expect(JSON.stringify(result)).not.toContain("quantities-2026-11-26-v1");
  });

  it("counts a wrapped technical bullet once and keeps a genuine repeat", () => {
    const wrapped = "Built Node.js and C# services\nfor the CI/CD platform across payments.";
    const repeated = "Delivered the same weekly finance report for the audit team this quarter.";
    const result = evaluate(workResume(
      ["Northwind", "Engineer", "Jan 2020 - Present"],
      [wrapped, repeated, repeated, STRONG, STRONG],
    ), options);
    expect(scoreOf(result, "action-verbs")).toBe(10);
    expect(result.criteria.find((item) => item.ruleId === "bullet-length")?.status).toBe("scored");
    expect(scoreOf(result, "bullet-length")).toBeLessThan(7);
  });

  it("drops an extraction duplicate and still scores the remaining bullets", () => {
    const document = workResume(["Northwind", "Engineer", "Jan 2020 - Present"], Array.from({ length: 5 }, () => STRONG));
    const original = document.blocks.find((block) => block.type === "bullet");
    const copy = document.blocks.find((block) => block.type === "bullet" && block !== original);
    if (original && copy) {
      original.paragraphId = "same-paragraph";
      copy.paragraphId = "same-paragraph";
    }
    const result = evaluate(document, options);
    expect(scoreOf(result, "bullet-length")).toBe(7);
    expect(result.criteria.find((item) => item.ruleId === "bullet-length")?.findings).toEqual([]);
  });

  it("accepts listed verbs and inflections, and rejects a verb that appears later", () => {
    expect(opensWithActionVerb("Developed REST APIs")).toBe(true);
    expect(opensWithActionVerb("Optimized SQL queries")).toBe(true);
    expect(opensWithActionVerb("Developing the billing service")).toBe(true);
    expect(opensWithActionVerb("Manages the quarterly close")).toBe(true);
    expect(opensWithActionVerb("Leading the research review")).toBe(true);
    expect(opensWithActionVerb("Responsible for developing APIs")).toBe(false);
    expect(opensWithActionVerb("Familiar with Spring Boot")).toBe(false);
    const result = evaluate(workResume(
      ["Northwind", "Engineer", "Jan 2020 - Present"],
      ["Responsible for developing APIs in the billing platform this year.", STRONG, STRONG, STRONG, STRONG],
    ), options);
    expect(scoreOf(result, "action-verbs")).toBe(8);
    expect(result.criteria.find((item) => item.ruleId === "action-verbs")?.findings[0]?.message).toBe("Start this bullet with an action verb.");
  });

  it("counts one quantity per bullet and ignores versions, dates, phones, and addresses", () => {
    expect(hasMeaningfulQuantity("Reduced response time by 18%")).toBe(true);
    expect(hasMeaningfulQuantity("Developed 12+ microservices")).toBe(true);
    expect(hasMeaningfulQuantity("Managed 8 engineers")).toBe(true);
    expect(hasMeaningfulQuantity("Increased revenue by ₹5 lakh")).toBe(true);
    expect(hasMeaningfulQuantity("Saved $50K and 200ms")).toBe(true);
    expect(hasMeaningfulQuantity("Raised throughput 2.5x")).toBe(true);
    expect(hasMeaningfulQuantity("Processed 10,000 transactions")).toBe(true);
    expect(hasMeaningfulQuantity("Migrated to Java 22")).toBe(false);
    expect(hasMeaningfulQuantity("Used PostgreSQL 16")).toBe(false);
    expect(hasMeaningfulQuantity("Implemented OAuth 2.0")).toBe(false);
    expect(hasMeaningfulQuantity("Called +1 415 555 0134 from 2020")).toBe(false);
    expect(hasMeaningfulQuantity("Deployed 10.0.0.8 on port 443")).toBe(false);
    const result = evaluate(workResume(
      ["Northwind", "Engineer", "Jan 2020 - Present"],
      ["Migrated to Java 22 for the billing platform this quarter.", STRONG, STRONG, STRONG, STRONG],
    ), options);
    expect(scoreOf(result, "quantified-metrics")).toBe(6);
    expect(result.criteria.find((item) => item.ruleId === "quantified-metrics")?.findings).toEqual([]);
  });

  it("requires an outcome before a quantity becomes impact", () => {
    expect(hasMeasurableImpact("Reduced API latency by 18%")).toBe(true);
    expect(hasMeasurableImpact("Increased revenue by ₹5 lakh")).toBe(true);
    expect(hasMeasurableImpact("Reduced processing time from 5 minutes to 2 minutes")).toBe(true);
    expect(hasMeasurableImpact("Developed 12 APIs")).toBe(false);
    expect(hasMeasurableImpact("Managed a team of 8 engineers")).toBe(false);
    expect(hasMeasurableImpact("Improved performance")).toBe(false);
    expect(hasMeasurableImpact("Increased latency by 18%")).toBe(false);
    const result = evaluate(workResume(
      ["Northwind", "Engineer", "Jan 2020 - Present"],
      ["Developed 12 APIs for the finance platform this quarter.", "Improved performance across the billing platform this quarter.", STRONG, STRONG, STRONG],
    ), options);
    expect(scoreOf(result, "quantified-metrics")).toBe(6);
    expect(scoreOf(result, "impact-metrics")).toBeLessThan(6);
    expect(result.criteria.find((item) => item.ruleId === "impact-metrics")?.findings.some((finding) => finding.message === "This bullet does not state a measurable outcome.")).toBe(true);
  });

  it("scores two dated roles at one employer and withholds an ambiguous header", () => {
    const clear = documentFrom([
      ["WORK_EXPERIENCE", [
        ["paragraph", "Northwind"],
        ["paragraph", "Engineer"],
        ["paragraph", "Jan 2020 - Present"],
        ...Array.from({ length: 4 }, () => ["bullet", STRONG] as const),
        ["paragraph", "Northwind"],
        ["paragraph", "Analyst"],
        ["paragraph", "Jan 2018 - Dec 2019"],
        ["bullet", "Maintained the ledger for the regional finance team this quarter."],
        ["bullet", STRONG],
      ]],
    ]);
    expect(scoreOf(evaluate(clear, options), "minimum-bullets-per-role")).toBe(6);

    const ambiguous = documentFrom([
      ["WORK_EXPERIENCE", [
        ["paragraph", "Northwind"],
        ["paragraph", "Globex"],
        ["paragraph", "Remote"],
        ...Array.from({ length: 5 }, () => ["bullet", STRONG] as const),
      ]],
    ]);
    expect(evaluate(ambiguous, options).criteria.find((item) => item.ruleId === "minimum-bullets-per-role")?.status).toBe("withheld");
    expect(scoreOf(evaluate(ambiguous, options), "bullet-length")).toBe(7);
  });

  it("withholds a length percentage that falls between named bands", () => {
    const bullets = [
      ...Array.from({ length: 18 }, () => STRONG),
      "Led the migration.",
    ];
    const result = evaluate(workResume(["Northwind", "Engineer", "Jan 2020 - Present"], bullets), options);
    expect(result.criteria.find((item) => item.ruleId === "bullet-length")?.status).toBe("withheld");
    expect(result.criteria.find((item) => item.ruleId === "bullet-length" && item.status === "withheld" && item.reasonCode === "UNRESOLVED_BAND")).toBeTruthy();
    expect(result.finalScore).toBeNull();
  });
});

function scoreOf(result: ReturnType<typeof evaluate>, ruleId: string): number | null {
  const rule = result.criteria.find((item) => item.ruleId === ruleId);
  return rule?.status === "scored" ? rule.score : null;
}

function workResume(header: readonly string[], bullets: readonly string[]): ResumeDocument {
  return documentFrom([["WORK_EXPERIENCE", [...header.map((line) => ["paragraph", line] as const), ...bullets.map((line) => ["bullet", line] as const)]]]);
}

function documentFrom(sections: ReadonlyArray<readonly [ResumeSectionKind, ReadonlyArray<readonly [ResumeBlock["type"], string]>]>): ResumeDocument {
  const document: ResumeDocument = {
    id: "resume",
    version: 1,
    filename: "Ada_Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [],
    blocks: [],
    metadata: {},
  };
  sections.forEach(([kind, rows], sectionIndex) => {
    const sectionId = `section-${sectionIndex}`;
    const blockIds: string[] = [];
    rows.forEach(([type, text], blockIndex) => {
      const id = `block-${sectionIndex}-${blockIndex}`;
      blockIds.push(id);
      document.blocks.push({ id, sectionId, type, text, startOffset: 0, endOffset: text.length });
    });
    document.sections.push({ id: sectionId, kind, heading: kind, blockIds });
  });
  return document;
}
