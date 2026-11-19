import { describe, expect, it } from "vitest";
import { presentEvaluation, presentFindings, presentHistoryItem } from "./presentation.js";

const PRIVATE_TEXT = [
  "OPEN_DECISION",
  "UNRESOLVED_BAND",
  "DICTIONARY_UNAVAILABLE",
  "MISSING_CANDIDATE_TYPE",
  "rubric-2026-11-12-provisional",
  "not_implemented",
  "not_evaluated",
  "appliedToScore",
  "CRITERION_MAXIMA",
];

describe("public evaluation presentation", () => {
  it("returns area status and plain explanations without scoring metadata", () => {
    const evaluation = presentEvaluation({
      id: "eval-1",
      resumeId: "resume-1",
      resumeVersionId: "version-1",
      originalFilename: "MinaKapoor_CV.pdf",
      mimeType: "application/pdf",
      scoreStatus: "PROVISIONAL",
      baseScore: 11,
      finalScore: null,
      criteria: [
        { ruleId: "required-sections", maxScore: 4, status: "scored", score: 4 },
        { ruleId: "contact-information", maxScore: 4, status: "scored", score: 2 },
        { ruleId: "unique-skills", maxScore: 5, status: "scored", score: 5 },
        { ruleId: "resume-filename", maxScore: 2, status: "withheld", score: null, reasonCode: "UNRESOLVED_BAND" },
        { ruleId: "readability", maxScore: 7, status: "withheld", score: null, reasonCode: "OPEN_DECISION" },
      ],
      jdMatch: { status: "not_implemented", appliedToScore: false },
      createdAt: "2026-11-17T00:00:00.000Z",
    });
    const findings = presentFindings(evaluationInput().criteria, [
      {
        id: "phone",
        ruleId: "contact-phone",
        message: "A phone number was not found.",
        suggestion: null,
        evidence: [{ blockId: "block-1", startOffset: 0, endOffset: 4, ruleId: "contact-phone" }],
      },
      {
        id: "spell",
        ruleId: "grammar-spelling",
        message: 'Possible misspelling "Recieve".',
        suggestion: "Receive",
        evidence: [{ blockId: "block-2", startOffset: 1, endOffset: 8 }],
      },
      {
        id: "filename",
        ruleId: "resume-filename",
        message: "Filename withheld.",
        suggestion: null,
        evidence: [],
      },
    ]);

    expect(evaluation).toEqual({
      id: "eval-1",
      resumeId: "resume-1",
      resumeVersionId: "version-1",
      originalFilename: "MinaKapoor_CV.pdf",
      mimeType: "application/pdf",
      status: "provisional",
      score: 11,
      notice: "This result is provisional and is not a complete 100-point score.",
      areas: [
        { label: "Required sections", state: "passed" },
        { label: "Contact information", state: "review" },
        { label: "Unique skills", state: "passed" },
      ],
      unavailable: [
        {
          label: "Resume filename",
          explanation:
            "The filename contains the candidate name, but it does not match an approved pattern, so these points are not available.",
        },
        {
          label: "Readability",
          explanation: "Readability is not available yet because no scoring method has been approved.",
        },
        {
          label: "Job description comparison",
          explanation: "The description was received. Comparison is not available yet and does not change this score.",
        },
      ],
      createdAt: "2026-11-17T00:00:00.000Z",
    });
    expect(findings).toEqual([
      {
        id: "phone",
        kind: "issue",
        message: "A phone number was not found.",
        suggestion: null,
        evidence: [{ blockId: "block-1", startOffset: 0, endOffset: 4 }],
      },
      {
        id: "spell",
        kind: "note",
        message: 'Possible misspelling "Recieve".',
        suggestion: "Receive",
        evidence: [{ blockId: "block-2", startOffset: 1, endOffset: 8 }],
      },
    ]);
    const serialized = JSON.stringify({ evaluation, findings });
    for (const token of PRIVATE_TEXT) {
      expect(serialized).not.toContain(token);
    }
    const keys = [...collectKeys({ evaluation, findings })];
    for (const key of ["ruleId", "maxScore", "reasonCode", "penaltyId", "denominator", "rubricVersion"]) {
      expect(keys).not.toContain(key);
    }
  });

  it("shows a formatting observation as a note and does not score it", () => {
    const findings = presentFindings(
      [{ ruleId: "formatting-consistency", maxScore: 6, status: "withheld", score: null, reasonCode: "OPEN_DECISION" }],
      [
        {
          id: "font",
          ruleId: "formatting-fontSize",
          message: "Bullets in this section do not share the same font size.",
          suggestion: null,
          evidence: [{ blockId: "bullet-1", startOffset: 0, endOffset: 15 }],
        },
      ],
    );
    expect(findings).toEqual([
      {
        id: "font",
        kind: "note",
        message: "Bullets in this section do not share the same font size.",
        suggestion: null,
        evidence: [{ blockId: "bullet-1", startOffset: 0, endOffset: 15 }],
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("formatting-fontSize");
    expect(JSON.stringify(findings)).not.toContain("OPEN_DECISION");
  });

  it("keeps a complete score only when the stored result is final", () => {
    const history = presentHistoryItem({
      id: "eval-2",
      resumeId: "resume-1",
      resumeVersionId: "version-1",
      originalFilename: "AdaLovelace_Resume.pdf",
      mimeType: "application/pdf",
      scoreStatus: "FINAL",
      baseScore: 80,
      finalScore: 75,
      createdAt: "2026-11-17T00:00:00.000Z",
    });
    expect(history).toMatchObject({ status: "complete", score: 75 });
    expect(history).not.toHaveProperty("denominator");
    expect(history).not.toHaveProperty("rubricVersion");
  });
});

function evaluationInput() {
  return {
    criteria: [
      { ruleId: "contact-information", maxScore: 4, status: "scored", score: 2 },
    ],
  };
}

function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, found);
    }
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      collectKeys(child, found);
    }
  }
  return found;
}
