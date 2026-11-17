// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScorePanel, type ScoreFinding, type ScoreView } from "./score-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function evaluation(overrides: Partial<ScoreView> = {}): ScoreView {
  return {
    id: "eval-1",
    resumeId: "resume-1",
    resumeVersionId: "version-1",
    originalFilename: "MinaKapoor_CV.pdf",
    scoreStatus: "PROVISIONAL",
    baseScore: 13,
    denominator: 13,
    penaltyTotal: null,
    penaltyStatus: "not_evaluated",
    finalScore: null,
    rubricVersion: "rubric-2026-11-12-provisional",
    criteria: [
      { ruleId: "required-sections", maxScore: 4, status: "scored", score: 4 },
      { ruleId: "contact-information", maxScore: 4, status: "scored", score: 4 },
      { ruleId: "unique-skills", maxScore: 5, status: "scored", score: 5 },
      { ruleId: "readability", maxScore: 7, status: "withheld", score: null, reasonCode: "OPEN_DECISION" },
    ],
    jdMatch: { status: "not_implemented", appliedToScore: false },
    createdAt: "2026-11-17T00:00:00.000Z",
    ...overrides,
  };
}

function renderPanel(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("resume analysis panel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders the dark score card from the evaluation without internal status codes", () => {
    const onHighlight = vi.fn();
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation()}
        findings={[]}
        onHighlight={onHighlight}
      />,
    );

    expect(container.querySelector("section")?.className).toContain("bg-card");
    expect(container.textContent).toContain("Resume analysis");
    expect(container.textContent).toContain("MinaKapoor_CV.pdf");
    expect(container.textContent).toContain("13/13");
    expect(container.textContent).toContain("Evaluated");
    expect(container.textContent).toContain("3 checks passed");
    expect(container.textContent).toContain("Required sections");
    expect(container.textContent).toContain("4/4");
    expect(container.textContent).toContain("Contact information");
    expect(container.textContent).toContain("Unique skills");
    expect(container.textContent).toContain("5/5");
    expect(container.textContent).toContain(
      "No confirmed issues in the scored checks. Other checks are not yet available.",
    );
    expect(container.textContent).not.toContain("Withheld criteria stay out of the denominator");
    expect(container.textContent).not.toContain("OPEN_DECISION");
    expect(container.textContent).not.toContain("PROVISIONAL");
    expect(container.textContent).not.toContain("rubric-2026-11-12-provisional");
    expect(container.querySelector(".text-primary")).toBeTruthy();

    const summary = container.querySelector("details");
    expect(summary?.open).toBe(false);
    expect(container.textContent).toContain("Checks not yet available (1)");
    act(() => {
      summary?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (summary) {
        summary.open = true;
      }
    });
    expect(container.textContent).toContain("Readability");
    expect(container.textContent).toContain("no scoring method has been approved");
    expect(container.textContent).not.toContain("OPEN_DECISION");

    const layout = container.querySelector(".flex-col");
    expect(layout?.className).toContain("sm:flex-row");
    cleanup();
  });

  it("shows a partial score and its deduction without calling spelling notes a deduction", () => {
    const findings: ScoreFinding[] = [
      {
        id: "phone",
        ruleId: "contact-phone",
        message: "A phone number was not found.",
        evidence: [{ blockId: "block-1", startOffset: 0, endOffset: 4 }],
      },
      {
        id: "spell",
        ruleId: "grammar-spelling",
        message: 'Possible misspelling "Recieve".',
        suggestion: "Receive",
        evidence: [{ blockId: "block-2", startOffset: 1, endOffset: 8 }],
      },
    ];
    const onHighlight = vi.fn();
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({
          baseScore: 11,
          denominator: 13,
          criteria: [
            { ruleId: "required-sections", maxScore: 4, status: "scored", score: 4 },
            { ruleId: "contact-information", maxScore: 4, status: "scored", score: 2 },
            { ruleId: "unique-skills", maxScore: 5, status: "scored", score: 5 },
            { ruleId: "readability", maxScore: 7, status: "withheld", score: null, reasonCode: "OPEN_DECISION" },
          ],
        })}
        findings={findings}
        onHighlight={onHighlight}
      />,
    );

    expect(container.textContent).toContain("11/13");
    expect(container.textContent).toContain("2 checks passed");
    expect(container.textContent).toContain("2/4");
    expect(container.textContent).toContain("A phone number was not found.");
    expect(container.textContent).not.toContain("No confirmed issues");
    expect(container.textContent).toContain('Possible misspelling "Recieve".');

    const suggestion = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Recieve"),
    );
    act(() => {
      suggestion?.dispatchEvent(new KeyboardEvent("focus", { bubbles: true }));
      suggestion?.focus();
    });
    expect(onHighlight).toHaveBeenCalled();
    cleanup();
  });
});
