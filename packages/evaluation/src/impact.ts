import { hasMeaningfulQuantity } from "./quantities.js";

/** Outcome cues are private. A quantity alone is not an outcome. */
export const IMPACT_CLASSIFIER_VERSION = "impact-2026-11-26-v1";

const REDUCTION = /\b(?:reduc(?:e|es|ed|ing)|reduction|decreas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|cut|cuts|cutting|sav(?:e|es|ed|ing)|savings|shorten(?:s|ed|ing)?|eliminat(?:e|es|ed|ing)|optimiz(?:e|es|ed|ing))\b/iu;
const REDUCTION_NOUN = /\b(?:cost|costs|spend|spending|expense|expenses|time|latency|delay|downtime|error|errors|bug|bugs|risk|risks|defect|defects|churn|complaint|complaints|incidents)\b/iu;
const GROWTH = /\b(?:increas(?:e|es|ed|ing)|grew|grown|grow(?:s|ing)?|growth|rais(?:e|es|ed|ing)|boost(?:s|ed|ing)?|expand(?:s|ed|ing)?|generat(?:e|es|ed|ing)|accelerat(?:e|es|ed|ing))\b/iu;
const GROWTH_NOUN = /\b(?:revenue|sales|profit|profits|conversion|conversions|throughput|retention|satisfaction|nps|uptime|productivity|coverage|users|customers)\b/iu;
const IMPROVE = /\b(?:improv(?:e|es|ed|ing)|improvement)\b/iu;
const IMPROVE_NOUN = /\b(?:performance|quality|reliability|latency|time|cost|revenue|satisfaction|productivity|uptime)\b/iu;

export function hasMeasurableImpact(text: string): boolean {
  if (!hasMeaningfulQuantity(text)) {
    return false;
  }
  if (REDUCTION.test(text) && REDUCTION_NOUN.test(text)) {
    return true;
  }
  if (GROWTH.test(text) && GROWTH_NOUN.test(text)) {
    return true;
  }
  return IMPROVE.test(text) && IMPROVE_NOUN.test(text);
}
