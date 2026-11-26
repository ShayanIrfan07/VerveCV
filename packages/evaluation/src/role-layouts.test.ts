import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import type { BoundingBox, ResumeBlock, ResumeDocument } from "./model.js";

const options = { candidateType: null, candidateName: null, jobDescription: null };
const BULLET = "Reduced review latency by 18 percent for the nightly export pipeline this quarter.";

describe("employment header layouts", () => {
  it("scores an employer followed by a designation and a date line", () => {
    expect(roleScore(lines(["Northwind", "Engineer", "Jan 2020 - Present"], 5))).toBe(6);
  });

  it("scores a designation followed by an employer", () => {
    expect(roleScore(lines(["Software Engineer", "Northwind", "Jan 2020 - Present"], 5))).toBe(6);
  });

  it("scores the employer and designation on one line in either order", () => {
    expect(roleScore(lines(["Northwind Software Engineer Jan 2020 - Present"], 5))).toBe(6);
    expect(roleScore(lines(["Software Engineer Northwind Jan 2020 - Present"], 5))).toBe(6);
    expect(roleScore(lines(["Northwind - Software Engineer", "Jan 2020 - Present"], 5))).toBe(6);
  });

  it("keeps a right-aligned date with the role on the same baseline", () => {
    const document = work([
      row("Northwind", { x: 72, y: 700 }),
      row("Jan 2020 - Present", { x: 400, y: 700 }),
      row("Engineer", { x: 72, y: 680 }),
      ...Array.from({ length: 5 }, (_, index) => row(BULLET, { x: 90, y: 640 - index * 20 }, "bullet")),
    ]);
    expect(roleScore(document)).toBe(6);
  });

  it("reuses one employer line for a later title and date", () => {
    const document = work([
      ...linesOf(["Northwind", "Engineer", "Jan 2020 - Present"]),
      ...Array.from({ length: 4 }, () => row(BULLET, undefined, "bullet")),
      ...linesOf(["Analyst", "Jan 2018 - Dec 2019"]),
      row("Maintained the ledger for the regional finance team this quarter.", undefined, "bullet"),
      row(BULLET, undefined, "bullet"),
    ]);
    expect(roleScore(document)).toBe(6);
  });

  it("ignores a client label when the employer is still clear, and withholds a client-only or location header", () => {
    expect(roleScore(lines(["Northwind", "Engineer", "Client: Globex", "Jan 2020 - Present"], 5))).toBe(6);
    expect(roleStatus(lines(["Client: Globex", "Consultant", "Jan 2020 - Present"], 5))).toBe("withheld");
    expect(roleStatus(lines(["Northwind", "Engineer", "San Francisco", "Jan 2020 - Present"], 5))).toBe("withheld");
    expect(roleStatus(lines(["Northwind", "Globex", "Remote"], 5))).toBe("withheld");
  });
});

function roleScore(document: ResumeDocument): number | null {
  const rule = evaluate(document, options).criteria.find((item) => item.ruleId === "minimum-bullets-per-role");
  return rule?.status === "scored" ? rule.score : null;
}

function roleStatus(document: ResumeDocument): string | undefined {
  return evaluate(document, options).criteria.find((item) => item.ruleId === "minimum-bullets-per-role")?.status;
}

function lines(header: readonly string[], count: number): ResumeDocument {
  return work([...linesOf(header), ...Array.from({ length: count }, () => row(BULLET, undefined, "bullet"))]);
}

function linesOf(header: readonly string[]): Row[] {
  return header.map((text) => row(text));
}

interface Row {
  text: string;
  type: ResumeBlock["type"];
  box?: { x: number; y: number };
}

function row(text: string, box?: { x: number; y: number }, type: ResumeBlock["type"] = "paragraph"): Row {
  return { text, type, ...(box ? { box } : {}) };
}

function work(rows: readonly Row[]): ResumeDocument {
  const document: ResumeDocument = {
    id: "resume",
    version: 1,
    filename: "Ada_Resume.pdf",
    mimeType: "application/pdf",
    sourceHash: "hash",
    parserVersion: "test",
    sections: [],
    blocks: [],
    metadata: {},
  };
  const blockIds = rows.map((item, index) => {
    const id = `block-${index}`;
    const box: BoundingBox | undefined = item.box ? { page: 1, x: item.box.x, y: item.box.y, width: 80, height: 12 } : undefined;
    document.blocks.push({
      id,
      sectionId: "work",
      type: item.type,
      text: item.text,
      startOffset: 0,
      endOffset: item.text.length,
      ...(box ? { boxes: [box] } : {}),
    });
    return id;
  });
  document.sections.push({ id: "work", kind: "WORK_EXPERIENCE", heading: "Experience", blockIds });
  return document;
}
