import { describe, expect, it } from "vitest";
import { CATEGORY_MAXIMA, CRITERION_MAXIMA, RUBRIC_VERSION, sumValues } from "./rubric.js";

describe("rubric weights", () => {
  it("keeps the locked 100-point category total", () => {
    expect(sumValues(CATEGORY_MAXIMA)).toBe(100);
  });

  it("keeps each category equal to its criteria", () => {
    expect(
      CRITERION_MAXIMA.bulletLength +
        CRITERION_MAXIMA.actionVerbs +
        CRITERION_MAXIMA.quantifiedMetrics +
        CRITERION_MAXIMA.impactMetrics +
        CRITERION_MAXIMA.minimumBulletsPerRole,
    ).toBe(CATEGORY_MAXIMA.bulletQuality);
    expect(
      CRITERION_MAXIMA.sectionOrdering +
        CRITERION_MAXIMA.reverseChronology +
        CRITERION_MAXIMA.filename +
        CRITERION_MAXIMA.formattingConsistency,
    ).toBe(CATEGORY_MAXIMA.formatting);
    expect(
      CRITERION_MAXIMA.grammarAndSpelling +
        CRITERION_MAXIMA.readability +
        CRITERION_MAXIMA.punctuation,
    ).toBe(CATEGORY_MAXIMA.grammarAndReadability);
    expect(
      CRITERION_MAXIMA.requiredSections +
        CRITERION_MAXIMA.contactInformation +
        CRITERION_MAXIMA.entryDetails +
        CRITERION_MAXIMA.educationDetails +
        CRITERION_MAXIMA.skillsRatio +
        CRITERION_MAXIMA.uniqueSkills +
        CRITERION_MAXIMA.industryKeywords,
    ).toBe(CATEGORY_MAXIMA.relevantInformation);
  });

  it("uses the provisional rubric version", () => {
    expect(RUBRIC_VERSION).toBe("rubric-2026-11-12-provisional");
  });
});
