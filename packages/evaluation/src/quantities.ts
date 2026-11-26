/** A bullet counts once, however many quantities it contains. */
export const QUANTITY_RECOGNIZER_VERSION = "quantities-2026-11-26-v3";

const COUNT_NOUN = "engineers|developers|people|members|clients|customers|users|requests|transactions|orders|apis|microservices|services|tickets|bugs|servers|nodes|records|accounts|invoices|patients|candidates|shipments";

const MASKS = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu,
  /\+91[\s-]?\d{5}[\s-]?\d{5}\b/gu,
  /\b0?[6-9]\d{9}\b/gu,
  /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-])\d{3}[\s.-]\d{4}\b/gu,
  /\bhttps?:\/\/\d+(?:\.\d+)?\b/giu,
  /\b(?:java|postgresql|postgres|mysql|oracle|python|node(?:\.js)?|react|angular|vue|spring(?:\s+boot)?|kubernetes|docker|oauth|tls|ssl|windows|linux|android|ios|swift|kotlin|ruby|php|scala|kafka|redis|mongodb|graphql)\b(?:\s+version|\s+v)?\s*\d+(?:\.\d+)*/giu,
  /\bv\d+(?:\.\d+)+\b/giu,
  /\b\d+\.\d+\.\d+(?:\.\d+)?\b/gu,
  /\bport\s+\d{2,5}\b|:\d{2,5}\b/giu,
  /\b\d{1,2}:\d{2}\b/gu,
  /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:,?\s+(?:19|20)\d{2})?/giu,
  /\b(?:serial(?:\s+(?:no|number))?|s\/n|identifier|ref(?:erence)?(?:\s+no)?|invoice\s*(?:no|number)|account\s*(?:no|number)|model|\bid)\b\.?\s*#?\s*[a-z0-9][a-z0-9,.-]*/giu,
  /#\d[\d,]*/gu,
];

const QUANTITY = new RegExp(
  String.raw`[$₹€£]\s*\d|\d+(?:\.\d+)?\s*(?:%|x|×)|\d+(?:\.\d+)?\s*(?:percent|ms|milliseconds|sec|secs|seconds|min|mins|minutes|hr|hrs|hours|days|weeks|months|lakh|lakhs|crore|crores|rps|qps|req\/s|mb\/s)\b|\d+(?:\.\d+)?\s*[kKmM]\b|\d+(?:\.\d+)?\+|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\b(?:team|group|staff)\s+of\s+\d+\b|\d+(?:\.\d+)?\s*(?:${COUNT_NOUN})\b|\d+(?:\.\d+)?\s*(?:-|–|to)\s*\d+(?:\.\d+)?`,
  "iu",
);

export function hasMeaningfulQuantity(text: string): boolean {
  return QUANTITY.test(maskExclusions(text));
}

function maskExclusions(text: string): string {
  let value = text;
  for (const pattern of MASKS) {
    value = value.replace(pattern, (match) => " ".repeat(match.length));
  }
  return value.replace(/\b(?:19|20)\d{2}\b/gu, (match, offset: number, source: string) => {
    const before = source.slice(0, offset);
    const after = source.slice(offset + match.length);
    const unitAfter = /^\s*(?:%|x|×|percent|ms|milliseconds|sec|secs|seconds|min|mins|minutes|hr|hrs|hours|rps|qps|req\/s|mb\/s)\b/iu;
    if (/[$₹€£]\s*$/u.test(before) || unitAfter.test(after) || new RegExp(String.raw`^\s+(?:${COUNT_NOUN})\b`, "iu").test(after)) {
      return match;
    }
    return " ".repeat(match.length);
  });
}
