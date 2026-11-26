import { hasMeaningfulQuantity } from "./quantities.js";

/** Outcome cues are private. A quantity must belong to the outcome clause. */
export const IMPACT_CLASSIFIER_VERSION = "impact-2026-11-26-v3";

const REDUCTION = /\b(?:reduc(?:e|es|ed|ing)|reduction|decreas(?:e|es|ed|ing)|lower(?:s|ed|ing)?|cut|cuts|cutting|sav(?:e|es|ed|ing)|savings|shorten(?:s|ed|ing)?|eliminat(?:e|es|ed|ing)|optimiz(?:e|es|ed|ing))\b/iu;
const REDUCTION_NOUN = /\b(?:cost|costs|spend|spending|expense|expenses|time|latency|delay|downtime|error|errors|bug|bugs|risk|risks|defect|defects|churn|complaint|complaints|incidents)\b/iu;
const GROWTH = /\b(?:increas(?:e|es|ed|ing)|grew|grown|grow(?:s|ing)?|growth|rais(?:e|es|ed|ing)|boost(?:s|ed|ing)?|expand(?:s|ed|ing)?|generat(?:e|es|ed|ing)|accelerat(?:e|es|ed|ing))\b/iu;
const GROWTH_NOUN = /\b(?:revenue|sales|profit|profits|conversion|conversions|throughput|retention|satisfaction|nps|uptime|productivity|coverage|users|customers)\b/iu;
const IMPROVE = /\b(?:improv(?:e|es|ed|ing)|improvement)\b/iu;
const IMPROVE_NOUN = /\b(?:performance|quality|reliability|latency|time|cost|revenue|satisfaction|productivity|uptime)\b/iu;
const UNCONFIRMED_BEFORE = /(?:\b(?:failed|planned|attempted|hoping|aimed|sought|tried|unable|expected)\s+to|\b(?:did\s+not|didn't|could\s+not|couldn't|would\s+not|wouldn't|will\s+not|won't|never))\s*$/iu;
const OUTCOME_MEASURE = /[$₹€£]\s*\d|\d+(?:\.\d+)?\s*(?:%|x|×)|\d+(?:\.\d+)?\s*(?:percent|ms|milliseconds|sec|secs|seconds|min|mins|minutes|hr|hrs|hours|days|weeks|months|lakh|lakhs|crore|crores)\b|\d+(?:\.\d+)?\s*[kKmM]\b|\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+/iu;

export function hasMeasurableImpact(text: string): boolean {
  if (!hasMeaningfulQuantity(text)) {
    return false;
  }
  return text.split(/\b(?:while|whilst|whereas|although|and)\b|[;]/iu).some((clause) => clauseHasImpact(clause));
}

function clauseHasImpact(clause: string): boolean {
  if (!hasMeaningfulQuantity(clause)) {
    return false;
  }
  if (measureMatches(clause, REDUCTION, REDUCTION_NOUN)) {
    return true;
  }
  if (measureMatches(clause, GROWTH, GROWTH_NOUN)) {
    return true;
  }
  return measureMatches(clause, IMPROVE, IMPROVE_NOUN);
}

function measureMatches(clause: string, verb: RegExp, noun: RegExp): boolean {
  const verbs = new RegExp(verb.source, "giu");
  for (const found of clause.matchAll(verbs)) {
    const index = found.index ?? 0;
    if (UNCONFIRMED_BEFORE.test(clause.slice(0, index))) {
      continue;
    }
    const afterVerb = clause.slice(index + found[0].length);
    const nounFound = new RegExp(noun.source, "iu").exec(afterVerb);
    if (nounFound === null || nounFound.index > 48) {
      continue;
    }
    const wordsBetween = afterVerb.slice(0, nounFound.index).trim();
    if (wordsBetween.split(/\s+/u).filter((word) => word.length > 0).length > 6) {
      continue;
    }
    const tail = afterVerb.slice(nounFound.index + nounFound[0].length);
    const link = /^(?:\s+\w+){0,3}\s+(?:by|from)\s+([\s\S]+)$/iu.exec(tail);
    const measured = link?.[1]?.split(/\b(?:and|while|whilst)\b|[;]/iu)[0] ?? "";
    if (OUTCOME_MEASURE.test(measured)) {
      return true;
    }
  }
  return false;
}
