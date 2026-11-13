import { describe, expect, it } from "vitest";
import {
  actionVerbScore,
  averageRoleCompletion,
  bulletLengthScore,
  cappedDeduction,
  grammarScore,
  impactScore,
  keywordMatchScore,
  minimumBulletsScore,
  punctuationScore,
  quantifiedMetricScore,
  roleEntryCredit,
  shortResumePenalty,
  skillsRatioScore,
  uniqueSkillScore,
} from "./bands.js";
import { aggregate, evaluate } from "./evaluate.js";
import type { ResumeBlock, ResumeDocument, ResumeSection, RuleResult } from "./model.js";
import { CRITERION_MAXIMA, RUBRIC_VERSION } from "./rubric.js";

const options = { candidateType: null, candidateName: null, jobDescription: null };

describe("specified band arithmetic", () => {
  it("scores bullet-length bands, including the endpoints", () => {
    expect(scoreOf(bulletLengthScore(100))).toBe(7);
    expect(scoreOf(bulletLengthScore(95))).toBe(6);
    expect(scoreOf(bulletLengthScore(99))).toBe(6);
    expect(scoreOf(bulletLengthScore(85))).toBe(5);
    expect(scoreOf(bulletLengthScore(70))).toBe(4);
    expect(scoreOf(bulletLengthScore(55))).toBe(3);
    expect(scoreOf(bulletLengthScore(40))).toBe(2);
    expect(scoreOf(bulletLengthScore(25))).toBe(1);
    expect(scoreOf(bulletLengthScore(24.9))).toBe(0);
    expect(bulletLengthScore(99.4).status).toBe("withheld");
  });

  it("scores action-verb bands without inventing the missing odd scores", () => {
    expect(scoreOf(actionVerbScore(100))).toBe(10);
    expect(scoreOf(actionVerbScore(90))).toBe(9);
    expect(scoreOf(actionVerbScore(80))).toBe(8);
    expect(scoreOf(actionVerbScore(60))).toBe(6);
    expect(scoreOf(actionVerbScore(40))).toBe(4);
    expect(scoreOf(actionVerbScore(25))).toBe(2);
    expect(scoreOf(actionVerbScore(0))).toBe(0);
    expect([1, 3, 5, 7]).not.toContain(scoreOf(actionVerbScore(80)));
  });

  it("scores quantified bands and withholds the unnamed gap below 65%", () => {
    expect(scoreOf(quantifiedMetricScore(65))).toBe(6);
    expect(scoreOf(quantifiedMetricScore(55))).toBe(5);
    expect(scoreOf(quantifiedMetricScore(45))).toBe(4);
    expect(scoreOf(quantifiedMetricScore(35))).toBe(3);
    expect(scoreOf(quantifiedMetricScore(25))).toBe(2);
    expect(scoreOf(quantifiedMetricScore(15))).toBe(1);
    expect(scoreOf(quantifiedMetricScore(14.9))).toBe(0);
    expect(quantifiedMetricScore(64.5).status).toBe("withheld");
  });

  it("scores the impact matrix corners", () => {
    expect(scoreOf(impactScore(85, 85))).toBe(6);
    expect(scoreOf(impactScore(85, 60))).toBe(5);
    expect(scoreOf(impactScore(85, 40))).toBe(3);
    expect(scoreOf(impactScore(85, 20))).toBe(2);
    expect(scoreOf(impactScore(85, 19))).toBe(0);
    expect(scoreOf(impactScore(20, 85))).toBe(2);
    expect(scoreOf(impactScore(20, 84))).toBe(0);
    expect(scoreOf(impactScore(9.9, 100))).toBe(0);
  });

  it("converts role credits and averages, including a 1.5/3 entry", () => {
    expect(roleEntryCredit(4, 4)).toBe(1);
    expect(roleEntryCredit(4, 3)).toBeCloseTo(4 / 6);
    expect(roleEntryCredit(4, 2)).toBeCloseTo(2 / 6);
    expect(roleEntryCredit(4, 1)).toBeCloseTo(1 / 6);
    expect(roleEntryCredit(4, 0)).toBe(0);
    expect(roleEntryCredit(2, 2)).toBe(1);
    expect(roleEntryCredit(2, 1)).toBeCloseTo(1.5 / 3);
    expect(roleEntryCredit(2, 0)).toBe(0);
    expect(roleEntryCredit(1, 1)).toBe(1);
    expect(roleEntryCredit(1, 0)).toBe(0);
    const average = averageRoleCompletion([1, 1.5 / 3]);
    expect(average).toBe(75);
    expect(scoreOf(minimumBulletsScore(100))).toBe(6);
    expect(scoreOf(minimumBulletsScore(90))).toBe(5);
    expect(scoreOf(minimumBulletsScore(75))).toBe(4);
    expect(scoreOf(minimumBulletsScore(60))).toBe(3);
    expect(scoreOf(minimumBulletsScore(45))).toBe(2);
    expect(scoreOf(minimumBulletsScore(35))).toBe(1);
    expect(scoreOf(minimumBulletsScore(34.9))).toBe(0);
  });

  it("rounds the keyword example to 6 and cannot exceed 7", () => {
    expect(scoreOf(keywordMatchScore([6 / 8, 8 / 8, 2 / 2]))).toBe(6);
    expect(scoreOf(keywordMatchScore([1]))).toBe(7);
    expect(keywordMatchScore([]).status).toBe("withheld");
    expect(scoreOf(keywordMatchScore([2]))).toBe(7);
  });

  it("scores the skills-ratio formula without treating zero soft skills as division", () => {
    expect(skillsRatioScore(4, 0)).toBe(0);
    expect(skillsRatioScore(1, 1)).toBe(1);
    expect(skillsRatioScore(3, 2)).toBe(3);
    expect(skillsRatioScore(2, 1)).toBe(1);
  });

  it("scores unique-skill counts", () => {
    expect([0, 1, 4, 5, 7, 8, 9, 10].map(uniqueSkillScore)).toEqual([0, 1, 1, 3, 3, 4, 4, 5]);
  });

  it("keeps the grammar and punctuation drops", () => {
    expect(grammarScore(0)).toBe(10);
    expect(grammarScore(5)).toBe(5);
    expect(grammarScore(6)).toBe(3);
    expect(grammarScore(7)).toBe(1);
    expect(grammarScore(8)).toBe(0);
    expect(punctuationScore(0)).toBe(3);
    expect(punctuationScore(1)).toBe(2);
    expect(punctuationScore(3)).toBe(1);
    expect(punctuationScore(4)).toBe(0);
  });

  it("applies the short-resume boundaries and the stated deduction caps", () => {
    expect(shortResumePenalty(239)).toBe(15);
    expect(shortResumePenalty(240)).toBe(10);
    expect(shortResumePenalty(299)).toBe(10);
    expect(shortResumePenalty(300)).toBe(0);
    expect(cappedDeduction(9, 8)).toBe(8);
    expect(cappedDeduction(6, 5)).toBe(5);
    expect(cappedDeduction(3, 2)).toBe(2);
  });

  it("withholds fractional gaps until a rounding convention is approved", () => {
    expect(bulletLengthScore(99.5).status).toBe("withheld");
    expect(actionVerbScore(89.5).status).toBe("withheld");
    expect(quantifiedMetricScore(64.5).status).toBe("withheld");
    expect(minimumBulletsScore(89.5).status).toBe("withheld");
  });

  it("rejects non-finite, negative, and empty scoring inputs", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 101]) {
      expect(bulletLengthScore(value).status).toBe("withheld");
      expect(actionVerbScore(value).status).toBe("withheld");
      expect(quantifiedMetricScore(value).status).toBe("withheld");
      expect(impactScore(value, 50).status).toBe("withheld");
      expect(minimumBulletsScore(value).status).toBe("withheld");
    }
    expect(keywordMatchScore([]).status).toBe("withheld");
    expect(keywordMatchScore([Number.NaN]).status).toBe("withheld");
    expect(keywordMatchScore([Number.POSITIVE_INFINITY]).status).toBe("withheld");
    expect(keywordMatchScore([-0.1]).status).toBe("withheld");
    expect(averageRoleCompletion([])).toBeNull();
    expect(roleEntryCredit(4, -1)).toBeNull();
    expect(roleEntryCredit(4, Number.NaN)).toBeNull();
    expect(skillsRatioScore(Number.NaN, 1)).toBeNull();
    expect(skillsRatioScore(-1, 1)).toBeNull();
    expect(uniqueSkillScore(-1)).toBeNull();
    expect(grammarScore(Number.NaN)).toBeNull();
    expect(punctuationScore(Number.POSITIVE_INFINITY)).toBeNull();
    expect(shortResumePenalty(-1)).toBeNull();
    expect(cappedDeduction(-1, 8)).toBeNull();
  });
});

describe("evaluate", () => {
  it("scores zero for every bullet criterion when fewer than five bullets exist", () => {
    const result = evaluate(resumeWithBullets(4, "Shipped the export pipeline and reduced review time by 30 percent today."), options);
    for (const ruleId of ["bullet-length", "action-verbs", "quantified-metrics", "impact-metrics", "minimum-bullets-per-role"]) {
      const rule = result.criteria.find((item) => item.ruleId === ruleId);
      expect(rule?.status).toBe("scored");
      expect(rule?.status === "scored" ? rule.score : null).toBe(0);
    }
  });

  it("withholds bullet criteria once five bullets exist because the recognizers are not approved", () => {
    const result = evaluate(resumeWithBullets(5, "Led the migration."), options);
    const rule = result.criteria.find((item) => item.ruleId === "bullet-length");
    expect(rule?.status).toBe("withheld");
  });

  it("awards one contact point per present field", () => {
    const full = evaluate(withText("Ada Lovelace\nada@example.com\n+1 415 555 0134\nhttps://linkedin.com/in/ada"), {
      ...options,
      candidateName: "Ada Lovelace",
    });
    expect(ruleScore(full, "contact-information")).toBe(4);
    const emailOnly = evaluate(withText("ada@example.com"), options);
    expect(ruleScore(emailOnly, "contact-information")).toBe(1);
  });

  it("scores required sections only after the candidate type is selected", () => {
    const document = withSections(["EDUCATION", "SKILLS", "PROJECTS"]);
    expect(evaluate(document, options).criteria.find((item) => item.ruleId === "required-sections")?.status).toBe("withheld");
    expect(ruleScore(evaluate(document, { ...options, candidateType: "FRESHER" }), "required-sections")).toBe(4);
    expect(ruleScore(evaluate(document, { ...options, candidateType: "EXPERIENCED" }), "required-sections")).toBe(0);
    expect(ruleScore(evaluate(withSections(["WORK_EXPERIENCE", "EDUCATION", "SKILLS"]), { ...options, candidateType: "EXPERIENCED" }), "required-sections")).toBe(4);
  });

  it("scores an approved filename, withholds a named mismatch, and scores zero when the name is absent", () => {
    const named = { ...options, candidateName: "Ada Lovelace" };
    expect(ruleScore(evaluate(namedFile("AdaLovelace_Resume.pdf"), named), "resume-filename")).toBe(2);
    expect(evaluate(namedFile("Ada_Lovelace_Resume.pdf"), named).criteria.find((item) => item.ruleId === "resume-filename")?.status).toBe("withheld");
    expect(ruleScore(evaluate(namedFile("Resume.pdf"), named), "resume-filename")).toBe(0);
  });

  it("counts React aliases once and ignores skills outside the skills section", () => {
    const document = withSections(["SKILLS", "PROJECTS"]);
    document.blocks.push(
      block("skills", "SKILLS", "React, React.js, ReactJS, Go, Rust, Java, Python, SQL, CSS, HTML"),
      block("projects", "PROJECTS", "React"),
    );
    const section = document.sections.find((item) => item.kind === "SKILLS");
    const project = document.sections.find((item) => item.kind === "PROJECTS");
    if (section) section.blockIds.push("skills");
    if (project) project.blockIds.push("projects");
    expect(ruleScore(evaluate(document, options), "unique-skills")).toBe(4);
  });

  it("keeps a job description from changing the base score and does not claim a match", () => {
    const document = withText("Ada Lovelace");
    const without = evaluate(document, options);
    const withDescription = evaluate(document, { ...options, jobDescription: "TypeScript" });
    expect(withDescription.baseScore).toBe(without.baseScore);
    expect(withDescription.finalScore).toBe(without.finalScore);
    expect(withDescription.penaltyTotal).toBe(without.penaltyTotal);
    expect(without.jdMatch).toBeNull();
    expect(withDescription.jdMatch).toEqual({ status: "not_implemented", appliedToScore: false });
  });

  it("stays provisional, withholds readability, and does not rescale the denominator", () => {
    const result = evaluate(emptyDocument(), options);
    expect(result.scoreStatus).toBe("PROVISIONAL");
    expect(result.rubricVersion).toBe(RUBRIC_VERSION);
    expect(result.criteria.find((item) => item.ruleId === "readability")?.status).toBe("withheld");
    const scoredMax = result.criteria.reduce((sum, rule) => sum + (rule.status === "scored" ? rule.maxScore : 0), 0);
    expect(result.denominator).toBe(scoredMax);
    expect(result.denominator).toBeLessThanOrEqual(100 - CRITERION_MAXIMA.readability);
    expect(result.penaltyStatus).toBe("not_evaluated");
    expect(result.penaltyTotal).toBeNull();
    expect(result.finalScore).toBeNull();
    expect(result.penalties.find((penalty) => penalty.penaltyId === "short-resume")?.deduction).toBeNull();
    for (const rule of result.criteria) {
      if (rule.status === "scored") {
        expect(rule.score).toBeGreaterThanOrEqual(0);
        expect(rule.score).toBeLessThanOrEqual(rule.maxScore);
      }
    }
    expect(evaluate(emptyDocument(), options)).toEqual(result);
  });

  it("reads contact details from the contact region and ignores them in project text", () => {
    const buried = withSections(["PROJECTS"]);
    buried.blocks.push(block("project", "section-0", "Email ada@example.com after the launch."));
    const projectSection = buried.sections[0];
    if (projectSection) projectSection.blockIds.push("project");
    expect(ruleScore(evaluate(buried, options), "contact-information")).toBe(0);
    const contact = withSections(["CONTACT"]);
    contact.blocks.push(block("mail", "section-0", "ada@example.com"));
    const contactSection = contact.sections[0];
    if (contactSection) contactSection.blockIds.push("mail");
    expect(ruleScore(evaluate(contact, options), "contact-information")).toBe(1);
  });

  it("splits common skill separators and skips sentences", () => {
    const document = withSections(["SKILLS"]);
    document.blocks.push(block("skills", "section-0", "Go | Rust / SQL; TypeScript\nBuilt reliable services for internal clients."));
    const section = document.sections[0];
    if (section) section.blockIds.push("skills");
    expect(ruleScore(evaluate(document, options), "unique-skills")).toBe(1);
  });

  it("clamps the aggregate and omits withheld maxima from the denominator", () => {
    const high = aggregate([synthetic("scored", 100, 100)], []);
    expect(high.finalScore).toBe(100);
    expect(high.penaltyTotal).toBe(0);
    expect(high.penaltyStatus).toBe("evaluated");
    expect(high.denominator).toBe(100);
    const buried = aggregate([synthetic("scored", 10, 10)], [
      { penaltyId: "sample", status: "scored", deduction: 40 },
    ]);
    expect(buried.finalScore).toBe(0);
    expect(buried.penaltyTotal).toBe(40);
    const pending = aggregate([synthetic("scored", 10, 10)], [
      { penaltyId: "short-resume", status: "not_evaluated", deduction: null, reasonCode: "OPEN_DECISION" },
    ]);
    expect(pending.penaltyTotal).toBeNull();
    expect(pending.finalScore).toBeNull();
    expect(pending.penaltyStatus).toBe("not_evaluated");
    const mixed = aggregate([synthetic("scored", 4, 4), synthetic("withheld", 7, null)], []);
    expect(mixed.baseScore).toBe(4);
    expect(mixed.denominator).toBe(4);
  });
});

function scoreOf(result: { status: string; score?: number }): number {
  if (result.status !== "scored" || result.score === undefined) {
    throw new Error("expected a scored band");
  }
  return result.score;
}

function ruleScore(result: ReturnType<typeof evaluate>, ruleId: string): number {
  const rule = result.criteria.find((item) => item.ruleId === ruleId);
  if (rule?.status !== "scored") throw new Error(`${ruleId} was not scored`);
  return rule.score;
}

function synthetic(status: "scored", maxScore: number, score: number): RuleResult;
function synthetic(status: "withheld", maxScore: number, score: null): RuleResult;
function synthetic(status: "scored" | "withheld", maxScore: number, score: number | null): RuleResult {
  if (status === "withheld") {
    return { ruleId: "sample", maxScore, status, score: null, reasonCode: "OPEN_DECISION", findings: [], version: RUBRIC_VERSION };
  }
  return { ruleId: "sample", maxScore, status, score: score ?? 0, findings: [], version: RUBRIC_VERSION };
}

function emptyDocument(): ResumeDocument {
  return {
    id: "resume",
    version: 1,
    filename: "Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [],
    blocks: [],
    metadata: {},
  };
}

function withText(text: string): ResumeDocument {
  const document = emptyDocument();
  document.blocks.push({ id: "block-0", sectionId: "section-0", type: "paragraph", text, startOffset: 0, endOffset: text.length });
  return document;
}

function namedFile(filename: string): ResumeDocument {
  return { ...emptyDocument(), filename };
}

function withSections(kinds: ResumeSection["kind"][]): ResumeDocument {
  const document = emptyDocument();
  kinds.forEach((kind, index) => {
    const section: ResumeSection = { id: `section-${index}`, kind, heading: kind, blockIds: [] };
    document.sections.push(section);
  });
  return document;
}

function resumeWithBullets(count: number, text: string): ResumeDocument {
  const document = withSections(["WORK_EXPERIENCE"]);
  const section = document.sections[0];
  if (!section) return document;
  for (let index = 0; index < count; index += 1) {
    const id = `bullet-${index}`;
    section.blockIds.push(id);
    document.blocks.push(block(id, section.id, text, "bullet"));
  }
  return document;
}

function block(id: string, sectionId: string, text: string, type = "paragraph"): ResumeBlock {
  return { id, sectionId, type, text, startOffset: 0, endOffset: text.length };
}
