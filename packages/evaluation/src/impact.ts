import { hasMeaningfulQuantity } from "./quantities.js";

/** Outcome cues are private. A quantity must belong to the outcome clause. */
export const IMPACT_CLASSIFIER_VERSION = "impact-2026-11-26-v2";

const REDUCTION = /\b(?:reduc(?:e|es|ed|ing)|reduction|decreas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|cut|cuts|cutting|sav(?:e|es|ed|ing)|savings|shorten(?:s|ed|ing)?|eliminat(?:e|es|ed|ing)|optimiz(?:e|es|ed|ing))\b/iu;
const REDUCTION_NOUN = /\b(?:cost|costs|spend|spending|expense|expenses|time|latency|delay|downtime|error|errors|bug|bugs|risk|risks|defect|defects|churn|complaint|complaints|incidents)\b/iu;
const GROWTH = /\b(?:increas(?:e|es|ed|ing)|grew|grown|grow(?:s|ing)?|growth|rais(?:e|es|ed|ing)|boost(?:s|ed|ing)?|expand(?:s|ed|ing)?|generat(?:e|es|ed|ing)|accelerat(?:e|es|ed|ing))\b/iu;
const GROWTH_NOUN = /\b(?:revenue|sales|profit|profits|conversion|conversions|throughput|retention|satisfaction|nps|uptime|productivity|coverage|users|customers)\b/iu;
const IMPROVE = /\b(?:improv(?:e|es|ed|ing)|improvement)\b/iu;
const IMPROVE_NOUN = /\b(?:performance|quality|reliability|latency|time|cost|revenue|satisfaction|productivity|uptime)\b/iu;
const UNCONFIRMED = /\b(?:failed|planned|attempted|hoping|aimed|sought|tried|unable)\s+to\b|\b(?:did not|didn't|could not|couldn't|would not|wouldn't|will not|won't)\b/iu;
const OUTCOME_MEASURE = /[$₹€£]\s*\d|\d+(?:\.\d+)?\s*(?:%|x|×)|\d+(?:\.\d+)?\s*(?:percent|ms|milliseconds|sec|secs|seconds|min|mins|minutes|hr|hrs|hours|days|weeks|months|lakh|lakhs|crore|crores)\b|\d+(?:\.\d+)?\s*[kKmM]\b|\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+/iu;

export function hasMeasurableImpact(text: string): boolean {
  if (UNCONFIRMED.test(text) || !hasMeaningfulQuantity(text)) {
    return false;
  }
  return text.split(/\b(?:while|whilst|whereas|although)\b|[;]/iu).some((clause) => clauseHasImpact(clause));
}

function clauseHasImpact(clause: string): boolean {
  if (!hasMeaningfulQuantity(clause)) {
    return false;
  }
  if (REDUCTION.test(clause) && REDUCTION_NOUN.test(clause) && measureMatches(clause, REDUCTION_NOUN)) {
    return true;
  }
  if (GROWTH.test(clause) && GROWTH_NOUN.test(clause) && measureMatches(clause, GROWTH_NOUN)) {
    return true;
  }
  return IMPROVE.test(clause) && IMPROVE_NOUN.test(clause) && measureMatches(clause, IMPROVE_NOUN);
}

function measureMatches(clause: string, noun: RegExp): boolean {
  if (OUTCOME_MEASURE.test(clause)) {
    return true;
  }
  return [...clause.matchAll(/\d+(?:\.\d+)?\s+[a-z]+/giu)].some((match) => noun.test(match[0] ?? ""));
}
