import { describe, expect, it } from "vitest";
import {
  DETECTOR_VERSION,
  detectPronouns,
  extractionArtifactIds,
  findDuplicateBullets,
  matchEntryBullets,
  observeAddresses,
  observeSpecialCharacters,
  tokenizeBlocks,
  tokenizeWords,
  type KeywordDictionary,
} from "./detectors.js";
import { evaluate } from "./evaluate.js";
import type { ResumeDocument } from "./model.js";

const dictionary: KeywordDictionary = {
  version: "fixture-dictionary",
  terms: [
    { id: "react", canonical: "React", aliases: ["React.js", "ReactJS"] },
    { id: "java", canonical: "Java", aliases: [] },
    { id: "javascript", canonical: "JavaScript", aliases: [] },
    { id: "machine-learning", canonical: "machine learning", aliases: ["ML"] },
    { id: "node", canonical: "Node.js", aliases: [] },
    { id: "go", canonical: "Go", aliases: [], excludes: ["go to market"] },
  ],
};

describe("phase 4 detectors", () => {
  it("counts a keyword once per entry, including aliases, and ignores substrings", () => {
    const first = matchEntryBullets(
      ["Shipped React and React.js and ReactJS.", "The title line is not in this list."],
      dictionary,
    );
    const second = matchEntryBullets(["ReactJS services", "React UI"], dictionary);
    expect(first.map((hit) => hit.canonical)).toEqual(["react"]);
    expect(second.map((hit) => hit.canonical)).toEqual(["react"]);
    expect(first).toEqual(matchEntryBullets(["Shipped React and React.js and ReactJS.", "The title line is not in this list."], dictionary));
    expect(matchEntryBullets(["Built a reactive cache and a Javascript parser."], dictionary).map((hit) => hit.canonical)).toEqual([
      "javascript",
    ]);
    expect(matchEntryBullets(["Used machine learning and ML models."], dictionary).map((hit) => hit.canonical)).toEqual([
      "machine-learning",
    ]);
    expect(matchEntryBullets(["Deployed Node services."], dictionary)).toEqual([]);
    expect(matchEntryBullets(["Prepared a go to market plan and used Go."], dictionary).map((hit) => hit.evidenceText)).toEqual(["Go"]);
    expect(matchEntryBullets(["https://example.com/react-native"], dictionary)).toEqual([]);
    expect(first[0]?.version).toBe(DETECTOR_VERSION);
    expect(first.every((hit) => hit.quality === "high" && hit.startOffset >= 0 && hit.endOffset > hit.startOffset)).toBe(true);
  });

  it("counts repeated text and aliases of one canonical keyword once per entry", () => {
    const hits = matchEntryBullets(["React React.js ReactJS React", "React again and React.js"], dictionary);
    expect(hits.map((hit) => hit.canonical)).toEqual(["react"]);
    expect(matchEntryBullets(["Java Java Java"], dictionary)).toHaveLength(1);
  });

  it("keeps the same keyword set when bullet order changes", () => {
    const forward = matchEntryBullets(["Java services", "JavaScript UI"], dictionary).map((hit) => hit.canonical);
    const backward = matchEntryBullets(["JavaScript UI", "Java services"], dictionary).map((hit) => hit.canonical);
    expect(new Set(forward)).toEqual(new Set(backward));
    expect(forward).toHaveLength(2);
  });

  it("counts proposed words without applying the short-resume penalty", () => {
    expect(tokenizeWords("end-to-end Node.js CI/CD C# C++")).toEqual(["end-to-end", "Node.js", "CI/CD", "C#", "C++"]);
    expect(tokenizeWords("See https://example.com/a/b and ada@example.com today.")).toEqual([
      "See",
      "https://example.com/a/b",
      "and",
      "ada@example.com",
      "today",
    ]);
    const words = Array.from({ length: 239 }, () => "alpha");
    expect(tokenizeWords(words.join(" "))).toHaveLength(239);
    expect(tokenizeWords([...words, "beta"].join(" "))).toHaveLength(240);
    expect(tokenizeWords(Array.from({ length: 299 }, () => "alpha").join(" "))).toHaveLength(299);
    expect(tokenizeWords(Array.from({ length: 300 }, () => "alpha").join(" "))).toHaveLength(300);
    expect(tokenizeWords("well\u2011known alpha\u2014beta")).toEqual(["well-known", "alpha-beta"]);
    expect(tokenizeBlocks([{ text: "Shipped the API." }, { text: "Shipped the API." }, { text: "Kept the cache." }])).toEqual([
      "Shipped",
      "the",
      "API",
      "Shipped",
      "the",
      "API",
      "Kept",
      "the",
      "cache",
    ]);
    expect(
      tokenizeBlocks([
        { text: "Shipped the API.", paragraphId: "p-1" },
        { text: "Shipped the API.", paragraphId: "p-1" },
      ]),
    ).toEqual(["Shipped", "the", "API"]);
    const painted = { page: 1, x: 72, y: 400, width: 80, height: 12 };
    expect(
      tokenizeBlocks([
        { text: "Shipped the API.", boxes: [painted] },
        { text: "Shipped the API.", boxes: [{ ...painted }] },
      ]),
    ).toEqual(["Shipped", "the", "API"]);
    expect(
      tokenizeBlocks([
        { text: "Ada Lovelace", page: 1, boxes: [{ page: 1, x: 72, y: 780, width: 100, height: 12 }] },
        { text: "Shipped the API.", page: 1, boxes: [{ page: 1, x: 72, y: 400, width: 80, height: 12 }] },
        { text: "Ada Lovelace", page: 2, boxes: [{ page: 2, x: 72, y: 780, width: 100, height: 12 }] },
        { text: "Kept the cache.", page: 2, boxes: [{ page: 2, x: 72, y: 400, width: 80, height: 12 }] },
      ]),
    ).toEqual(["Ada", "Lovelace", "Shipped", "the", "API", "Kept", "the", "cache"]);
  });

  it("matches only the named pronouns outside emails, URLs, and quotes", () => {
    const hits = detectPronouns('I asked me and my team, and we shipped. Email me@example.com. See i.e. details and "I quote".');
    expect(hits.map((hit) => hit.canonical)).toEqual(["i", "me", "my", "we"]);
    expect(detectPronouns("myself website well mine our us Ibrahim iOS webrtc")).toEqual([]);
    expect(detectPronouns("https://example.com/we/me")).toEqual([]);
    expect(detectPronouns("\u201CI quote\u201D and I shipped.")).toEqual([
      expect.objectContaining({ canonical: "i", evidenceText: "I" }),
    ]);
    expect(detectPronouns("")).toEqual([]);
    expect(detectPronouns("I shipped.")).toEqual(detectPronouns("I shipped."));
  });

  it("records address digits without deciding that they are unprofessional", () => {
    const hits = observeAddresses("ada.lovelace@example.com jane2@example.com linkedin.com/in/jane-doe-123");
    expect(hits.map((hit) => [hit.type, hit.digitCount, hit.quality])).toEqual([
      ["email", 0, "insufficient_policy"],
      ["email", 1, "insufficient_policy"],
      ["linkedin", 3, "insufficient_policy"],
    ]);
    expect(observeAddresses("No profile is listed.")).toEqual([]);
    expect(observeAddresses("linkedin.com/in/ linkedin.com/jobs linkedin.com/company/acme")).toEqual([]);
  });

  it("separates protected symbols from unclassified ones", () => {
    const hits = observeSpecialCharacters("Use C# and C++ at https://example.com/a=b, then stop!");
    expect(hits.map((hit) => [hit.evidenceText, hit.quality])).toEqual([
      ["#", "protected"],
      ["=", "protected"],
      ["!", "unclassified"],
    ]);
  });

  it("finds exact and whitespace-normalized duplicate bullets without a score", () => {
    const hits = findDuplicateBullets([
      { id: "a", text: "Shipped the API." },
      { id: "b", text: "Shipped the API." },
      { id: "c", text: "  Shipped the API. " },
      { id: "d", text: "Kept the cache." },
    ]);
    expect(hits.map((hit) => [hit.type, hit.blockId])).toEqual([
      ["exact-duplicate", "b"],
      ["normalized-duplicate", "c"],
    ]);
    const across = findDuplicateBullets([
      { id: "work-bullet", text: "Shipped the API.", sectionId: "work" },
      { id: "project-bullet", text: "Shipped the API.", sectionId: "projects" },
    ]);
    expect(across.map((hit) => [hit.blockId, hit.sectionId])).toEqual([["project-bullet", "projects"]]);
    expect(
      findDuplicateBullets([
        { id: "once", text: "Shipped the API.", paragraphId: "p-9" },
        { id: "again", text: "Shipped the API.", paragraphId: "p-9" },
      ]),
    ).toEqual([]);
  });

  it("maps keyword and symbol offsets back to the original text when NFKC changes length", () => {
    const ligature = "Shipped \uFB01le systems";
    const fileDictionary: KeywordDictionary = {
      version: "fixture-dictionary",
      terms: [{ id: "file", canonical: "file", aliases: [] }],
    };
    const keyword = matchEntryBullets([ligature], fileDictionary, "entry-file");
    expect(keyword).toHaveLength(1);
    const hit = keyword[0];
    expect(hit?.evidenceText).toBe("\uFB01le");
    expect(ligature.slice(hit?.startOffset, hit?.endOffset)).toBe("\uFB01le");
    expect((hit?.endOffset ?? 0) - (hit?.startOffset ?? 0)).toBe(3);

    const acute = "caf\u0065\u0301";
    const pronoun = detectPronouns(`${acute} I`);
    expect(pronoun.map((item) => item.evidenceText)).toEqual(["I"]);
    expect(pronoun[0]?.startOffset).toBe(acute.length + 1);

    const symbol = observeSpecialCharacters("\uFB01le!");
    expect(symbol.map((item) => item.evidenceText)).toEqual(["!"]);
    expect(symbol[0]?.startOffset).toBe("\uFB01le".length);
    expect("\uFB01le!".slice(symbol[0]?.startOffset, symbol[0]?.endOffset)).toBe("!");
  });

  it("gives repeated keywords in separate entries distinct stable ids", () => {
    const again = matchEntryBullets(["Used Java in billing."], dictionary, "entry-a");
    const other = matchEntryBullets(["Used Java in billing."], dictionary, "entry-b");
    expect(again[0]?.canonical).toBe("java");
    expect(other[0]?.canonical).toBe("java");
    expect(again[0]?.id).not.toBe(other[0]?.id);
    expect(again[0]?.id).toBe(matchEntryBullets(["Used Java in billing."], dictionary, "entry-a")[0]?.id);
    expect(again[0]?.startOffset).toBe(other[0]?.startOffset);
    const duplicate = findDuplicateBullets([
      { id: "block-a", text: "Shipped the \uFB01le." },
      { id: "block-b", text: "Shipped the \uFB01le." },
    ]);
    expect(duplicate[0]?.id).toContain("block-b");
    expect(duplicate[0]?.endOffset).toBe("Shipped the \uFB01le.".length);
    expect(duplicate[0]?.evidenceText).toBe("Shipped the \uFB01le.");
  });

  it("treats only overlapping copies on the same page as extraction artifacts", () => {
    const blocks = Array.from({ length: 240 }, (_, index) => ({
      id: `line-${index}`,
      text: "Shipped the API.",
      page: 1 + Math.floor(index / 80),
      boxes: [{ page: 1 + Math.floor(index / 80), x: 72 + (index % 80) * 100, y: 400, width: 80, height: 12 }],
    }));
    blocks.push({
      id: "overlap",
      text: "Shipped the API.",
      page: 1,
      boxes: [{ page: 1, x: 72, y: 400, width: 80, height: 12 }],
    });
    const artifacts = extractionArtifactIds(blocks);
    expect(artifacts).toEqual(new Set(["overlap"]));
    expect(
      extractionArtifactIds([
        { id: "left", text: "Shipped the API.", boxes: [{ page: 1, x: 72, y: 400, width: 80, height: 12 }] },
        { id: "right", text: "Shipped the API.", boxes: [{ page: 1, x: 200, y: 400, width: 80, height: 12 }] },
      ]),
    ).toEqual(new Set());
  });

  it("leaves keyword points and every penalty unevaluated", () => {
    const text = "I built APIs with C# and React. jane2@example.com linkedin.com/in/jane-123";
    const document: ResumeDocument = {
      id: "resume",
      version: 1,
      filename: "Resume.pdf",
      mimeType: "application/pdf",
      sourceHash: "hash",
      parserVersion: "test",
      sections: [{ id: "work", kind: "WORK_EXPERIENCE", heading: "Experience", blockIds: ["b1", "b2"] }],
      blocks: [
        { id: "b1", sectionId: "work", type: "bullet", text, startOffset: 0, endOffset: text.length },
        { id: "b2", sectionId: "work", type: "bullet", text, startOffset: 0, endOffset: text.length },
      ],
      metadata: {},
    };
    const result = evaluate(document, { candidateType: "EXPERIENCED", candidateName: "Ada Lovelace", jobDescription: null });
    expect(result.criteria.find((item) => item.ruleId === "industry-keywords")?.status).toBe("withheld");
    expect(result.criteria.find((item) => item.ruleId === "industry-keywords")?.score).toBeNull();
    expect(result.penalties.every((penalty) => penalty.status !== "scored" && penalty.deduction === null)).toBe(true);
    expect(result.finalScore).toBeNull();
    expect(JSON.stringify(result)).not.toContain("fixture-dictionary");
    expect(JSON.stringify(result)).not.toContain(DETECTOR_VERSION);
  });
});
