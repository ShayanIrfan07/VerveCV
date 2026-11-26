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
    status: "provisional",
    score: 13,
    notice: "This result is provisional and is not a complete 100-point score.",
    areas: [
      { label: "Required sections", state: "passed" },
      { label: "Contact information", state: "passed" },
      { label: "Unique skills", state: "passed" },
    ],
    unavailable: [
      {
        label: "Readability",
        explanation: "Readability is not available yet because no scoring method has been approved.",
      },
    ],
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
    expect(container.querySelector('[data-testid="analysis-score"]')?.textContent).toBe("13");
    expect(container.textContent).toContain("Provisional");
    expect(container.textContent).toContain("not a complete 100-point score");
    expect(container.textContent).not.toContain("13/13");
    expect(container.textContent).toContain("3 checks passed");
    expect(container.textContent).toContain("Required sections");
    expect(container.textContent).toContain("Passed");
    expect(container.textContent).toContain("Contact information");
    expect(container.textContent).toContain("Unique skills");
    expect(container.textContent).not.toContain("4/4");
    expect(container.textContent).not.toContain("5/5");
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
        kind: "issue",
        message: "A phone number was not found.",
        evidence: [{ blockId: "block-1", startOffset: 0, endOffset: 4 }],
      },
      {
        id: "spell",
        kind: "note",
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
          score: 11,
          areas: [
            { label: "Required sections", state: "passed" },
            { label: "Contact information", state: "review" },
            { label: "Unique skills", state: "passed" },
          ],
        })}
        findings={findings}
        onHighlight={onHighlight}
      />,
    );

    expect(container.querySelector('[data-testid="analysis-score"]')?.textContent).toBe("11");
    expect(container.textContent).not.toContain("11/13");
    expect(container.textContent).toContain("2 checks passed");
    expect(container.textContent).toContain("Review");
    expect(container.textContent).not.toContain("2/4");
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

  it("shows an unavailable score without a denominator or private scoring terms", () => {
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({
          score: null,
          notice: "A final score is not available.",
        })}
        findings={[]}
        onHighlight={() => undefined}
      />,
    );

    expect(container.querySelector('[data-testid="analysis-score"]')?.textContent).toBe("—");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).not.toContain("/100");
    expect(container.textContent).not.toContain("OPEN_DECISION");
    expect(container.textContent).not.toContain("rubric-2026-11-12-provisional");
    expect(container.textContent).not.toContain("DETECTOR_VERSION");
    cleanup();
  });
});
