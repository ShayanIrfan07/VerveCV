import { describe, expect, it } from "vitest";
import { matchEntryBullets, type KeywordDictionary } from "./detectors.js";
import { parseEntries } from "./entries.js";
import { evaluate } from "./evaluate.js";
import type { BoundingBox, ResumeBlock, ResumeDocument, ResumeSection, ResumeSectionKind } from "./model.js";

const dictionary: KeywordDictionary = {
  version: "fixture-dictionary",
  terms: [
    { id: "java", canonical: "Java", aliases: [] },
    { id: "react", canonical: "React", aliases: ["React.js"] },
  ],
};

describe("entry parsing", () => {
  it("keeps bullets with the role that precedes them, including two roles at one company", () => {
    const document = resume([
      section("work", "WORK_EXPERIENCE", [
        paragraph("google", "Google"),
        paragraph("role-1", "Engineer 2020-Present"),
        bullet("a", "Shipped Java services."),
        paragraph("role-2", "Engineer 2018-2020"),
        bullet("b", "Shipped React UI."),
      ]),
      section("lead", "LEADERSHIP_EXPERIENCE", [paragraph("lead-role", "Mentor"), bullet("c", "Coached the team.")]),
      section("projects", "PROJECTS", [paragraph("project", "Compiler"), bullet("d", "Wrote the parser.")]),
      section("skills", "SKILLS", [paragraph("skills", "Java, React")]),
    ]);
    const parsed = parseEntries(document);
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries.map((entry) => [entry.sectionKind, entry.headerBlockIds, entry.bulletBlockIds, entry.dateText])).toEqual([
      ["WORK_EXPERIENCE", ["google", "role-1"], ["a"], "2020"],
      ["WORK_EXPERIENCE", ["role-2"], ["b"], "2018"],
      ["LEADERSHIP_EXPERIENCE", ["lead-role"], ["c"], null],
      ["PROJECTS", ["project"], ["d"], null],
    ]);
    const work = parsed.entries.filter((entry) => entry.sectionKind === "WORK_EXPERIENCE");
    expect(matchEntryBullets(texts(document, work[0]?.bulletBlockIds ?? []), dictionary).map((hit) => hit.canonical)).toEqual(["java"]);
    expect(matchEntryBullets(texts(document, work[1]?.bulletBlockIds ?? []), dictionary).map((hit) => hit.canonical)).toEqual(["react"]);
    expect(parseEntries(document)).toEqual(parsed);
  });

  it("joins a wrapped PDF header and a wrapped bullet, and leaves prose unassigned", () => {
    const wrapped = resume([
      section("work", "WORK_EXPERIENCE", [
        paragraph("h1", "Software Engineer, Acme", box(1, 72, 720)),
        paragraph("h2", "Corporation | Mar 2020", box(1, 72, 704)),
        bullet("b1", "Shipped the export", box(1, 72, 680)),
        paragraph("b1b", "pipeline for billing.", box(1, 90, 664)),
        bullet("b2", "Kept the cache.", box(1, 72, 640)),
      ]),
    ]);
    const parsed = parseEntries(wrapped);
    expect(parsed.issues).toEqual([]);
    expect(parsed.entries).toEqual([
      expect.objectContaining({
        headerBlockIds: ["h1", "h2"],
        bulletBlockIds: ["b1", "b1b", "b2"],
        dateText: "Mar 2020",
      }),
    ]);

    const prose = resume([
      section("work", "WORK_EXPERIENCE", [
        paragraph("story", "One two three four five six seven eight nine ten eleven twelve."),
        bullet("loose", "Shipped the API."),
      ]),
    ]);
    expect(parseEntries(prose).entries).toEqual([]);
    expect(parseEntries(prose).issues).toEqual([
      expect.objectContaining({ status: "ambiguous", reason: "uncertain-boundary", blockIds: ["story", "loose"] }),
    ]);

    const unpunctuated = resume([
      section("work", "WORK_EXPERIENCE", [
        paragraph("story-2", "One two three four five six seven eight nine ten eleven twelve"),
        bullet("loose-2", "Shipped the API."),
      ]),
    ]);
    expect(parseEntries(unpunctuated).entries).toEqual([]);
    expect(parseEntries(unpunctuated).issues).toEqual([
      expect.objectContaining({ status: "ambiguous", reason: "uncertain-boundary", blockIds: ["story-2", "loose-2"] }),
    ]);
    const shortHeader = resume([
      section("work", "WORK_EXPERIENCE", [paragraph("role-plain", "Engineer"), bullet("plain-bullet", "Shipped the API.")]),
    ]);
    expect(parseEntries(shortHeader).entries.map((entry) => entry.headerBlockIds)).toEqual([["role-plain"]]);
  });

  it("does not invent an entry for bullets, missing blocks, headers, or repeated chrome", () => {
    expect(parseEntries(resume([])).entries).toEqual([]);
    const bulletsOnly = resume([section("work", "WORK_EXPERIENCE", [bullet("a", "Shipped the API."), bullet("b", "Kept the cache.")])]);
    expect(parseEntries(bulletsOnly).entries).toEqual([]);
    expect(parseEntries(bulletsOnly).issues[0]).toMatchObject({ status: "unsupported", reason: "unassigned-bullets", blockIds: ["a", "b"] });

    const missing = resume([section("work", "WORK_EXPERIENCE", [paragraph("role", "Engineer")])]);
    missing.sections[0]?.blockIds.push("missing-block");
    expect(parseEntries(missing).issues.map((issue) => issue.reason)).toEqual(["missing-block", "header-without-bullets"]);

    const chrome = resume([
      section("work", "WORK_EXPERIENCE", [
        paragraph("name-1", "Ada Lovelace", box(1, 72, 780)),
        paragraph("role", "Engineer 2020", box(1, 72, 500)),
        bullet("work-bullet", "Shipped the API.", box(1, 72, 400)),
        paragraph("name-2", "Ada Lovelace", box(2, 72, 780)),
        bullet("more", "Kept the cache.", box(2, 72, 400)),
      ]),
    ]);
    const chromeParsed = parseEntries(chrome);
    expect(chromeParsed.entries.map((entry) => entry.headerBlockIds)).toEqual([["role"]]);
    expect(chromeParsed.entries[0]?.bulletBlockIds).toEqual(["work-bullet", "more"]);
    expect(JSON.stringify(chromeParsed)).not.toContain("name-1");

    const copied = resume([
      section("work", "WORK_EXPERIENCE", [
        { ...paragraph("role", "Engineer"), paragraphId: "p-1" },
        { ...paragraph("role-copy", "Engineer"), paragraphId: "p-1" },
        bullet("copied-bullet", "Shipped the API."),
      ]),
    ]);
    expect(parseEntries(copied).entries.map((entry) => [entry.headerBlockIds, entry.bulletBlockIds])).toEqual([
      [["role"], ["copied-bullet"]],
    ]);
  });

  it("does not change the live score", () => {
    const document = resume([
      section("work", "WORK_EXPERIENCE", [paragraph("role", "Engineer"), bullet("a", "I shipped Java.")]),
    ]);
    const result = evaluate(document, { candidateType: "EXPERIENCED", candidateName: null, jobDescription: null });
    expect(result.criteria.find((item) => item.ruleId === "industry-keywords")?.status).toBe("withheld");
    expect(result.penalties.every((penalty) => penalty.deduction === null)).toBe(true);
    expect(result.finalScore).toBeNull();
  });
});

function texts(document: ResumeDocument, ids: readonly string[]): string[] {
  const byId = new Map(document.blocks.map((block) => [block.id, block.text]));
  return ids.map((id) => byId.get(id) ?? "");
}

function resume(sections: ResumeSection[]): ResumeDocument {
  const blocks = sections.flatMap((section) =>
    section.blockIds.map((id) => {
      const stored = blockStore.get(id);
      if (!stored) {
        throw new Error(`missing fixture block ${id}`);
      }
      return { ...stored, sectionId: section.id };
    }),
  );
  return {
    id: "resume",
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

const blockStore = new Map<string, ResumeBlock>();

function section(id: string, kind: ResumeSectionKind, blocks: ResumeBlock[]): ResumeSection {
  for (const block of blocks) {
    blockStore.set(block.id, block);
  }
  return { id, kind, heading: kind, blockIds: blocks.map((block) => block.id) };
}

function paragraph(id: string, text: string, boxes?: BoundingBox): ResumeBlock {
  return block(id, "paragraph", text, boxes);
}

function bullet(id: string, text: string, boxes?: BoundingBox): ResumeBlock {
  return block(id, "bullet", text, boxes);
}

function block(id: string, type: string, text: string, boxes?: BoundingBox): ResumeBlock {
  return {
    id,
    sectionId: "unset",
    type,
    text,
    startOffset: 0,
    endOffset: text.length,
    ...(boxes ? { page: boxes.page, boxes: [boxes] } : {}),
  };
}

function box(page: number, x: number, y: number): BoundingBox {
  return { page, x, y, width: 120, height: 12 };
}
