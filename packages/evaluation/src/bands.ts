/**
 * Specified arithmetic.
 * A percentage that is not inside a named whole-number band is withheld.
 * That includes 99.5, 89.5, and 64.5. ADR 0001 item A1 records a rounding
 * proposal. It is not applied here.
 */

function usablePercent(percent: number): boolean {
  return Number.isFinite(percent) && percent >= 0 && percent <= 100;
}

function usableCount(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

export type BandScore = { status: "scored"; score: number } | { status: "withheld" };

const scored = (score: number): BandScore => ({ status: "scored", score });
const withheld: BandScore = { status: "withheld" };

function between(percent: number, min: number, max: number): boolean {
  return percent >= min && percent <= max;
}

function gap(percent: number, above: number, below: number): boolean {
  return percent > above && percent < below;
}

export function bulletLengthScore(percentMeeting: number): BandScore {
  if (!usablePercent(percentMeeting)) return withheld;
  if (percentMeeting === 100) return scored(7);
  if (gap(percentMeeting, 99, 100)) return withheld;
  if (between(percentMeeting, 95, 99)) return scored(6);
  if (gap(percentMeeting, 94, 95)) return withheld;
  if (between(percentMeeting, 85, 94)) return scored(5);
  if (gap(percentMeeting, 84, 85)) return withheld;
  if (between(percentMeeting, 70, 84)) return scored(4);
  if (gap(percentMeeting, 69, 70)) return withheld;
  if (between(percentMeeting, 55, 69)) return scored(3);
  if (gap(percentMeeting, 54, 55)) return withheld;
  if (between(percentMeeting, 40, 54)) return scored(2);
  if (gap(percentMeeting, 39, 40)) return withheld;
  if (between(percentMeeting, 25, 39)) return scored(1);
  if (percentMeeting < 25) return scored(0);
  return withheld;
}

export function actionVerbScore(percent: number): BandScore {
  if (!usablePercent(percent)) return withheld;
  if (percent === 100) return scored(10);
  if (gap(percent, 99, 100)) return withheld;
  if (between(percent, 90, 99)) return scored(9);
  if (gap(percent, 89, 90)) return withheld;
  if (between(percent, 80, 89)) return scored(8);
  if (gap(percent, 79, 80)) return withheld;
  if (between(percent, 60, 79)) return scored(6);
  if (gap(percent, 59, 60)) return withheld;
  if (between(percent, 40, 59)) return scored(4);
  if (gap(percent, 39, 40)) return withheld;
  if (between(percent, 25, 39)) return scored(2);
  if (percent < 25) return scored(0);
  return withheld;
}

export function quantifiedMetricScore(percent: number): BandScore {
  if (!usablePercent(percent)) return withheld;
  if (percent >= 65) return scored(6);
  if (gap(percent, 64, 65)) return withheld;
  if (between(percent, 55, 64)) return scored(5);
  if (gap(percent, 54, 55)) return withheld;
  if (between(percent, 45, 54)) return scored(4);
  if (gap(percent, 44, 45)) return withheld;
  if (between(percent, 35, 44)) return scored(3);
  if (gap(percent, 34, 35)) return withheld;
  if (between(percent, 25, 34)) return scored(2);
  if (gap(percent, 24, 25)) return withheld;
  if (between(percent, 15, 24)) return scored(1);
  if (percent < 15) return scored(0);
  return withheld;
}

export function impactScore(quantifiedPercent: number, impactPercent: number): BandScore {
  if (!usablePercent(quantifiedPercent) || !usablePercent(impactPercent)) return withheld;
  if (quantifiedPercent < 10) return scored(0);
  const category = quantifiedCategory(quantifiedPercent);
  if (category === "withheld") return withheld;
  return impactForCategory(category, impactPercent);
}

function quantifiedCategory(percent: number): "C1" | "C2" | "C3" | "C4" | "withheld" {
  if (percent >= 65) return "C1";
  if (gap(percent, 64, 65)) return "withheld";
  if (between(percent, 45, 64)) return "C2";
  if (gap(percent, 44, 45)) return "withheld";
  if (between(percent, 25, 44)) return "C3";
  if (gap(percent, 24, 25)) return "withheld";
  if (between(percent, 10, 24)) return "C4";
  return "withheld";
}

function impactForCategory(category: "C1" | "C2" | "C3" | "C4", percent: number): BandScore {
  if (category === "C1") {
    if (percent >= 85) return scored(6);
    if (gap(percent, 84, 85)) return withheld;
    if (between(percent, 60, 84)) return scored(5);
    if (gap(percent, 59, 60)) return withheld;
    if (between(percent, 40, 59)) return scored(3);
    if (gap(percent, 39, 40)) return withheld;
    if (between(percent, 20, 39)) return scored(2);
    if (percent < 20) return scored(0);
    return withheld;
  }
  if (category === "C2") {
    if (percent >= 85) return scored(5);
    if (gap(percent, 84, 85)) return withheld;
    if (between(percent, 60, 84)) return scored(3);
    if (gap(percent, 59, 60)) return withheld;
    if (between(percent, 40, 59)) return scored(2);
    if (percent < 40) return scored(0);
    return withheld;
  }
  if (category === "C3") {
    if (percent >= 85) return scored(3);
    if (gap(percent, 84, 85)) return withheld;
    if (between(percent, 60, 84)) return scored(2);
    if (percent < 60) return scored(0);
    return withheld;
  }
  if (percent >= 85) return scored(2);
  if (percent < 85) return scored(0);
  return withheld;
}

export function roleEntryCredit(requirement: 4 | 2 | 1, bulletsPresent: number): number | null {
  if (!usableCount(bulletsPresent)) return null;
  if (requirement === 4) {
    if (bulletsPresent >= 4) return 6 / 6;
    if (bulletsPresent === 3) return 4 / 6;
    if (bulletsPresent === 2) return 2 / 6;
    if (bulletsPresent === 1) return 1 / 6;
    return 0;
  }
  if (requirement === 2) {
    if (bulletsPresent >= 2) return 1;
    if (bulletsPresent === 1) return 1.5 / 3;
    return 0;
  }
  return bulletsPresent >= 1 ? 1 : 0;
}

export function minimumBulletsScore(averageCompletionPercent: number): BandScore {
  if (!usablePercent(averageCompletionPercent)) return withheld;
  if (averageCompletionPercent === 100) return scored(6);
  if (gap(averageCompletionPercent, 99, 100)) return withheld;
  if (between(averageCompletionPercent, 90, 99)) return scored(5);
  if (gap(averageCompletionPercent, 89, 90)) return withheld;
  if (between(averageCompletionPercent, 75, 89)) return scored(4);
  if (gap(averageCompletionPercent, 74, 75)) return withheld;
  if (between(averageCompletionPercent, 60, 74)) return scored(3);
  if (gap(averageCompletionPercent, 59, 60)) return withheld;
  if (between(averageCompletionPercent, 45, 59)) return scored(2);
  if (gap(averageCompletionPercent, 44, 45)) return withheld;
  if (between(averageCompletionPercent, 35, 44)) return scored(1);
  if (averageCompletionPercent < 35) return scored(0);
  return withheld;
}

export function averageRoleCompletion(credits: number[]): number | null {
  if (credits.length === 0 || credits.some((credit) => !Number.isFinite(credit) || credit < 0 || credit > 1)) {
    return null;
  }
  const total = credits.reduce((sum, credit) => sum + credit, 0);
  return (total / credits.length) * 100;
}

/** Round half up for non-negative keyword scores. 6.5 rounds to 7. */
export function roundHalfUp(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value + 0.5);
}

export function keywordMatchScore(completions: number[]): BandScore {
  if (completions.length === 0 || completions.some((value) => !Number.isFinite(value) || value < 0)) {
    return withheld;
  }
  const average = completions.reduce((sum, value) => sum + Math.min(value, 1), 0) / completions.length;
  const score = roundHalfUp(average * 7);
  if (score === null || score < 0 || score > 7) return withheld;
  return scored(score);
}

export function skillsRatioScore(technical: number, soft: number): number | null {
  if (!usableCount(technical) || !usableCount(soft)) return null;
  if (soft === 0) return 0;
  const ratio = technical / soft;
  if (ratio < 1) return 0;
  if (ratio < 1.5) return 1;
  if (technical >= 3 && soft >= 2) return 3;
  return 1;
}

export function uniqueSkillScore(count: number): number | null {
  if (!usableCount(count)) return null;
  if (count >= 10) return 5;
  if (count >= 8) return 4;
  if (count >= 5) return 3;
  if (count >= 1) return 1;
  return 0;
}

export function grammarScore(distinctErrors: number): number | null {
  if (!usableCount(distinctErrors)) return null;
  const table = [10, 9, 8, 7, 6, 5, 3, 1];
  if (distinctErrors >= 8) return 0;
  return table[distinctErrors] ?? 0;
}

export function punctuationScore(errors: number): number | null {
  if (!usableCount(errors)) return null;
  if (errors <= 0) return 3;
  if (errors === 1) return 2;
  if (errors <= 3) return 1;
  return 0;
}

export function shortResumePenalty(words: number): number | null {
  if (!usableCount(words)) return null;
  if (words < 240) return 15;
  if (words <= 299) return 10;
  return 0;
}

export function cappedDeduction(occurrences: number, cap: number): number | null {
  if (!usableCount(occurrences) || !usableCount(cap)) return null;
  return Math.min(occurrences, cap);
}
