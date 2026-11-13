import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { DICTIONARY_CANDIDATE, SPELLING_PROBE_TERMS, SPELLING_PROBE_UNKNOWN, grammarAndSpellingRule } from "./grammar.js";
import type { ResumeDocument } from "./model.js";
import { CRITERION_MAXIMA } from "./rubric.js";

describe("spelling dictionary candidate", () => {
  it("records the measured size and leaves the candidate uninstalled", () => {
    expect(DICTIONARY_CANDIDATE).toEqual({
      spellchecker: "nspell@2.1.5",
      dictionary: "dictionary-en@4.0.0",
      unpackedBytes: 622_389,
      accepted: false,
    });
    expect(SPELLING_PROBE_TERMS).toHaveLength(62);
    expect(SPELLING_PROBE_UNKNOWN).toHaveLength(45);
    expect(SPELLING_PROBE_UNKNOWN.every((term) => SPELLING_PROBE_TERMS.includes(term))).toBe(true);
    const manifests = ["package.json", "packages/evaluation/package.json", "apps/api/package.json", "apps/web/package.json"];
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
      expect(names).not.toContain("nspell");
      expect(names).not.toContain("dictionary-en");
    }
  });

  it("withholds grammar for misspellings, technical terms, and ignored terms", () => {
    const document = resume("Recieve teh Kubernetes update.");
    const plain = evaluate(document, { candidateType: null, candidateName: null, jobDescription: null });
    const ignored = evaluate(document, {
      candidateType: null,
      candidateName: null,
      jobDescription: null,
      ignoredTerms: ["recieve", "Kubernetes"],
    });
    for (const result of [plain, ignored]) {
      const rule = result.criteria.find((item) => item.ruleId === "grammar-and-spelling");
      expect(rule).toEqual(grammarAndSpellingRule());
      expect(rule?.status).toBe("withheld");
      if (rule?.status === "withheld") {
        expect(rule.reasonCode).toBe("DICTIONARY_UNAVAILABLE");
        expect(rule.score).toBeNull();
        expect(rule.maxScore).toBe(CRITERION_MAXIMA.grammarAndSpelling);
      }
      expect(result.criteria.find((item) => item.ruleId === "punctuation")?.status).toBe("withheld");
      expect(result.denominator).toBe(
        result.criteria.reduce((sum, item) => sum + (item.status === "scored" ? item.maxScore : 0), 0),
      );
    }
    expect(ignored.baseScore).toBe(plain.baseScore);
    expect(ignored.denominator).toBe(plain.denominator);
    expect(evaluate(document, { candidateType: null, candidateName: null, jobDescription: null })).toEqual(plain);
  });
});

function resume(text: string): ResumeDocument {
  return {
    id: "resume",
    version: 1,
    filename: "Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [],
    blocks: [{ id: "block-0", sectionId: "section-0", type: "paragraph", text, startOffset: 0, endOffset: text.length }],
    metadata: {},
  };
}
