import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grammarScore, punctuationScore } from "./bands.js";
import { evaluate } from "./evaluate.js";
import * as evaluationExports from "./index.js";
import {
  DICTIONARY_CANDIDATE,
  getDefaultSpellChecker,
  grammarAndSpellingRule,
  punctuationRule,
  TECHNICAL_ALLOWLIST_VERSION,
} from "./grammar.js";
import type { ResumeBlock, ResumeDocument, ResumeSection } from "./model.js";
import { CRITERION_MAXIMA } from "./rubric.js";

interface ProbeCorpus {
  version: string;
  technicalTerms: string[];
  controlEnglishWords: string[];
  knownMisspellings: string[];
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");
const CORPUS_PATH = path.join(REPO_ROOT, "scripts", "fixtures", "technical-probe-corpus.json");
const DEFAULT_OPTIONS = {
  candidateType: null,
  candidateName: null,
  jobDescription: null,
} as const;

function loadProbeCorpus(): ProbeCorpus {
  return JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as ProbeCorpus;
}

describe("spelling dictionary + versioned technical-term allowlist", () => {
  it("installs nspell + dictionary-en, pairs them with a versioned allowlist, and keeps probe arrays out of production exports", () => {
    expect(DICTIONARY_CANDIDATE).toEqual({
      spellchecker: "nspell@2.1.5",
      dictionary: "dictionary-en@4.0.0",
      technicalAllowlistVersion: TECHNICAL_ALLOWLIST_VERSION,
      unpackedBytes: 622_389,
      accepted: true,
    });

    const evalManifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "packages", "evaluation", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(evalManifest.dependencies).toMatchObject({
      nspell: "2.1.5",
      "dictionary-en": "4.0.0",
    });

    // Benchmark probe arrays live only in scripts/fixtures/technical-probe-corpus.json,
    // never in @vervecv/evaluation production exports.
    expect("SPELLING_PROBE_TERMS" in evaluationExports).toBe(false);
    expect("SPELLING_PROBE_UNKNOWN" in evaluationExports).toBe(false);
  });

  it("does not penalize technical vocabulary from the consolidated probe corpus (Kubernetes, Node.js, PostgreSQL, C#, GraphQL, LinkedIn, etc.)", () => {
    const corpus = loadProbeCorpus();
    const checker = getDefaultSpellChecker();
    expect(checker).not.toBeNull();

    for (const term of corpus.technicalTerms) {
      expect(checker?.correct(term), `expected technical term "${term}" to pass`).toBe(true);
    }
    for (const control of corpus.controlEnglishWords) {
      expect(checker?.correct(control), `expected English word "${control}" to pass`).toBe(true);
    }
    for (const typo of corpus.knownMisspellings) {
      expect(checker?.correct(typo), `expected misspelling "${typo}" to be caught`).toBe(false);
    }

    const bulletText = `Built ${corpus.technicalTerms.join(", ")} services with https://github.com/org/repo and linkedin.com/in/ada-lovelace.`;
    const result = evaluate(singleBlockResume(bulletText), DEFAULT_OPTIONS);
    const grammarRule = result.criteria.find((c) => c.ruleId === "grammar-and-spelling");
    const punctRule = result.criteria.find((c) => c.ruleId === "punctuation");

    expect(grammarRule?.findings).toEqual([]);
    expect(punctRule?.findings).toEqual([]);
  });
});

describe("deterministic grammar, spelling, and punctuation rules", () => {
  it("flags actual misspellings as informational findings while withholding the grammar score per ADR 0001 item A9", () => {
    const corpus = loadProbeCorpus();
    const text = `Recieve teh update and optmize performace across ${corpus.knownMisspellings.join(" ")}.`;
    const result = evaluate(singleBlockResume(text), DEFAULT_OPTIONS);
    const rule = result.criteria.find((c) => c.ruleId === "grammar-and-spelling");

    expect(rule?.status).toBe("withheld");
    if (rule?.status === "withheld") {
      expect(rule.score).toBeNull();
      expect(rule.maxScore).toBe(CRITERION_MAXIMA.grammarAndSpelling);
      expect(rule.reasonCode).toBe("OPEN_DECISION");
    }

    // Preserves the original rubric scoring tables in bands.ts without inventing deductions
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map(grammarScore)).toEqual([10, 9, 8, 7, 6, 5, 3, 1, 0]);
    expect([0, 1, 2, 3, 4].map(punctuationScore)).toEqual([3, 2, 1, 1, 0]);

    const spellingFindings = (rule?.findings ?? []).filter((f) => f.ruleId === "grammar-spelling");
    expect(spellingFindings.length).toBeGreaterThanOrEqual(7);
    for (const finding of spellingFindings) {
      expect(finding.severity).toBe("info");
      expect(finding.status).toBe("active");
    }

    const receiveFinding = spellingFindings.find((f) => f.message.toLowerCase().includes("recieve"));
    expect(receiveFinding?.suggestion).toBe("Receive");
    expect(receiveFinding?.confidence).toBe("high");

    // Low-confidence gibberish omits guessed suggestion
    const gibberish = grammarAndSpellingRule(singleBlockResume("Configured zzzzxqvw widgets."));
    const gibFinding = gibberish.findings.find((f) => f.message.includes("zzzzxqvw"));
    expect(gibFinding).toBeDefined();
    expect(gibFinding?.suggestion).toBeUndefined();
    expect(gibFinding?.confidence).toBe("medium");
  });

  it("detects repeated words and obvious grammatical patterns without penalizing valid resume fragments or proper nouns", () => {
    // Valid subjectless resume fragments + proper nouns + subtle valid constructs
    const cleanResume = resumeWithSections([
      {
        kind: "CONTACT",
        blocks: [
          {
            type: "paragraph",
            text: "Shayan Irfan | shayan@example.com | Bengaluru, Karnataka | linkedin.com/in/shayanirfan",
          },
        ],
      },
      {
        kind: "WORK_EXPERIENCE",
        blocks: [
          {
            type: "paragraph",
            text: "Razorpay — Senior Backend Engineer | Kharagpur & Zürich",
          },
          {
            type: "bullet",
            text: "Engineered a user authentication service in Node.js and PostgreSQL handling 10,000 requests/sec",
          },
          {
            type: "bullet",
            text: "Migrated a SQL reporting pipeline to managed Kubernetes with zero-downtime deployments",
          },
          {
            type: "bullet",
            text: "Collaborated with Priya Sharma as though it were a greenfield microservice",
          },
        ],
      },
    ]);

    const cleanEval = evaluate(cleanResume, {
      ...DEFAULT_OPTIONS,
      candidateName: "Shayan Irfan",
    });
    expect(cleanEval.criteria.find((c) => c.ruleId === "grammar-and-spelling")?.findings).toEqual(
      [],
    );
    expect(cleanEval.criteria.find((c) => c.ruleId === "punctuation")?.findings).toEqual([]);

    // Obvious grammatical errors
    const flawedText = [
      "Built the the deployment pipeline for a asynchronous worker.",
      "Designed an scalable service and waited a hour for an user.",
      "They was responsible of backend releases, and there is many services that it have.",
      "We did went to production after we have wrote tests and builded the artifact that should of been cached.",
    ].join(" ");

    const flawedRule = grammarAndSpellingRule(singleBlockResume(flawedText));
    const byRuleId = new Set(flawedRule.findings.map((f) => f.ruleId));

    expect(byRuleId).toContain("grammar-repeated-word");
    expect(byRuleId).toContain("grammar-article");
    expect(byRuleId).toContain("grammar-agreement");
    expect(byRuleId).toContain("grammar-verb-form");
    expect(byRuleId).toContain("grammar-preposition");

    const suggestions = flawedRule.findings.map((f) => f.suggestion);
    expect(suggestions).toEqual(
      expect.arrayContaining([
        "the",
        "an asynchronous",
        "a scalable",
        "an hour",
        "a user",
        "They were",
        "responsible for",
        "there are many",
        "it has",
        "did go",
        "have written",
        "built",
        "should have",
      ]),
    );
  });

  it("supports user-specific ignoredTerms case-insensitively without altering baseScore or denominator", () => {
    const doc = singleBlockResume("Recieve custom alerts with vervecvx telemetry.");
    const plain = evaluate(doc, DEFAULT_OPTIONS);
    const withIgnored = evaluate(doc, {
      ...DEFAULT_OPTIONS,
      ignoredTerms: ["RECIEVE", "VerveCVX"],
    });

    const plainFindings =
      plain.criteria.find((c) => c.ruleId === "grammar-and-spelling")?.findings ?? [];
    const ignoredFindings =
      withIgnored.criteria.find((c) => c.ruleId === "grammar-and-spelling")?.findings ?? [];

    expect(plainFindings.filter((f) => f.status === "active")).toHaveLength(2);
    expect(ignoredFindings.filter((f) => f.status === "active")).toHaveLength(0);
    expect(ignoredFindings.filter((f) => f.status === "ignored")).toHaveLength(2);

    expect(withIgnored.baseScore).toBe(plain.baseScore);
    expect(withIgnored.denominator).toBe(plain.denominator);
  });

  it("produces exact UTF-16 code-unit evidence offsets even after surrogate-pair emojis and across pages", () => {
    // "🚀" and "💡" each occupy 2 UTF-16 code units in JavaScript strings
    const text = "🚀 Built teh teh pipeline 💡 and recieve metrics.";
    const doc: ResumeDocument = {
      id: "utf16-doc",
      version: 1,
      filename: "Resume.pdf",
      mimeType: "application/pdf",
      sourceHash: "hash",
      parserVersion: "test",
      sections: [],
      blocks: [
        {
          id: "b-emoji",
          sectionId: "s-0",
          type: "bullet",
          text,
          startOffset: 0,
          endOffset: text.length,
          page: 2,
        },
      ],
      metadata: {},
    };

    const rule = grammarAndSpellingRule(doc);
    const repeated = rule.findings.find((f) => f.ruleId === "grammar-repeated-word");
    const misspelled = rule.findings.find((f) => f.ruleId === "grammar-spelling");

    expect(repeated).toBeDefined();
    expect(misspelled).toBeDefined();

    const repRef = repeated?.evidence[0];
    const spellRef = misspelled?.evidence[0];
    expect(repRef).toBeDefined();
    expect(spellRef).toBeDefined();

    expect(text.slice(repRef!.startOffset, repRef!.endOffset)).toBe("teh teh");
    expect(repRef?.page).toBe(2);

    expect(text.slice(spellRef!.startOffset, spellRef!.endOffset)).toBe("recieve");
    expect(spellRef?.page).toBe(2);
  });

  it("deduplicates repeated findings across blocks while preserving all evidence locators and avoiding multi-rule span overlap", () => {
    const doc = resumeWithSections([
      {
        kind: "WORK_EXPERIENCE",
        blocks: [
          { type: "bullet", text: "Recieve webhooks and recieve batch events" },
          { type: "bullet", text: "Builded services that recieve retry queues" },
        ],
      },
    ]);

    const rule = grammarAndSpellingRule(doc);
    const receiveFindings = rule.findings.filter((f) =>
      f.message.toLowerCase().includes("recieve"),
    );
    expect(receiveFindings).toHaveLength(1);
    expect(receiveFindings[0]?.evidence).toHaveLength(3);

    for (const ref of receiveFindings[0]?.evidence ?? []) {
      const targetBlock = doc.blocks.find((b) => b.id === ref.blockId);
      expect(targetBlock?.text.slice(ref.startOffset, ref.endOffset).toLowerCase()).toBe("recieve");
    }

    // "Builded" is claimed by grammar-verb-form and must NOT also appear as a duplicate spelling finding
    const buildedFindings = rule.findings.filter((f) =>
      f.evidence.some((ref) => {
        const b = doc.blocks.find((item) => item.id === ref.blockId);
        return b?.text.slice(ref.startOffset, ref.endOffset) === "Builded";
      }),
    );
    expect(buildedFindings).toHaveLength(1);
    expect(buildedFindings[0]?.ruleId).toBe("grammar-verb-form");
  });

  it("keeps spelling/grammar and punctuation findings strictly separate so issues are never double-counted", () => {
    const doc = resumeWithSections([
      {
        kind: "WORK_EXPERIENCE",
        blocks: [
          {
            type: "bullet",
            text: "We dont deploy broken builds,, and services,apis stay monitored .",
          },
          {
            type: "bullet",
            text: "Recieve alerts.. and doesnt drop payloads",
          },
          {
            type: "bullet",
            text: "Shipped clean telemetry.",
          },
        ],
      },
    ]);

    const evaluated = evaluate(doc, DEFAULT_OPTIONS);
    const grammarRule = evaluated.criteria.find((c) => c.ruleId === "grammar-and-spelling");
    const punctRule = evaluated.criteria.find((c) => c.ruleId === "punctuation");

    expect(grammarRule?.status).toBe("withheld");
    expect(punctRule?.status).toBe("withheld");

    const grammarRefs = (grammarRule?.findings ?? []).flatMap((f) => f.evidence);
    const punctRefs = (punctRule?.findings ?? []).flatMap((f) => f.evidence);

    expect(punctRefs.length).toBeGreaterThanOrEqual(5);

    // "dont" and "doesnt" must ONLY be in punctuation, NEVER in grammar-and-spelling
    const grammarSlices = grammarRefs.map((ref) => {
      const b = doc.blocks.find((item) => item.id === ref.blockId)!;
      return b.text.slice(ref.startOffset, ref.endOffset).toLowerCase();
    });
    expect(grammarSlices).toContain("recieve");
    expect(grammarSlices).not.toContain("dont");
    expect(grammarSlices).not.toContain("doesnt");

    // Verify zero span overlap between grammar-and-spelling and punctuation findings
    for (const gRef of grammarRefs) {
      for (const pRef of punctRefs) {
        if (gRef.blockId === pRef.blockId) {
          const overlaps =
            gRef.startOffset < pRef.endOffset && gRef.endOffset > pRef.startOffset;
          expect(overlaps).toBe(false);
        }
      }
    }

    // Consistent omission of terminal periods across all bullets produces 0 bullet-consistency findings
    const consistentOmission = resumeWithSections([
      {
        kind: "WORK_EXPERIENCE",
        blocks: [
          { type: "bullet", text: "Built authentication APIs in Fastify" },
          { type: "bullet", text: "Migrated schemas to PostgreSQL" },
          { type: "bullet", text: "Automated CI/CD pipelines" },
        ],
      },
    ]);
    expect(punctuationRule(consistentOmission).findings).toEqual([]);
  });

  it("falls back to DICTIONARY_UNAVAILABLE while still running deterministic grammar rules when spellChecker is null", () => {
    const result = grammarAndSpellingRule(
      singleBlockResume("Built the the pipeline and recieve events."),
      { spellChecker: null },
    );
    expect(result.status).toBe("withheld");
    expect(result.reasonCode).toBe("DICTIONARY_UNAVAILABLE");
    expect(result.findings.map((f) => f.ruleId)).toEqual(["grammar-repeated-word"]);
  });
});

function singleBlockResume(text: string): ResumeDocument {
  return {
    id: "resume",
    version: 1,
    filename: "Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [],
    blocks: [
      {
        id: "block-0",
        sectionId: "section-0",
        type: "paragraph",
        text,
        startOffset: 0,
        endOffset: text.length,
      },
    ],
    metadata: {},
  };
}

function resumeWithSections(
  specs: Array<{
    kind: ResumeSection["kind"];
    blocks: Array<{ type: "paragraph" | "bullet" | "heading"; text: string }>;
  }>,
): ResumeDocument {
  const sections: ResumeSection[] = [];
  const blocks: ResumeBlock[] = [];
  let cursor = 0;

  specs.forEach((spec, sIdx) => {
    const sectionId = `section-${sIdx}`;
    const blockIds: string[] = [];
    spec.blocks.forEach((bSpec) => {
      const blockId = `block-${blocks.length}`;
      const startOffset = cursor;
      const endOffset = startOffset + bSpec.text.length;
      blocks.push({
        id: blockId,
        sectionId,
        type: bSpec.type,
        text: bSpec.text,
        startOffset,
        endOffset,
      });
      blockIds.push(blockId);
      cursor = endOffset + 1;
    });
    sections.push({
      id: sectionId,
      kind: spec.kind,
      heading: spec.kind,
      blockIds,
    });
  });

  return {
    id: "resume-sections",
    version: 1,
    filename: "Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections,
    blocks,
    metadata: {},
  };
}
