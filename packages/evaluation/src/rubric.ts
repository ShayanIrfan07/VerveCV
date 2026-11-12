/** Provisional rubric. Weights are locked. Scoring rules are not implemented in this package yet. */
export const RUBRIC_VERSION = "rubric-2026-11-12-provisional";

export const CATEGORY_MAXIMA = {
  bulletQuality: 35,
  formatting: 15,
  grammarAndReadability: 20,
  relevantInformation: 30,
} as const;

export const CRITERION_MAXIMA = {
  bulletLength: 7,
  actionVerbs: 10,
  quantifiedMetrics: 6,
  impactMetrics: 6,
  minimumBulletsPerRole: 6,
  sectionOrdering: 4,
  reverseChronology: 3,
  filename: 2,
  formattingConsistency: 6,
  grammarAndSpelling: 10,
  readability: 7,
  punctuation: 3,
  requiredSections: 4,
  contactInformation: 4,
  entryDetails: 4,
  educationDetails: 3,
  skillsRatio: 3,
  uniqueSkills: 5,
  industryKeywords: 7,
} as const;

export function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}
