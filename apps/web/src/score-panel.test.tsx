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
    expect(container.textContent).toContain("Resume health");
    expect(container.textContent).toContain("MinaKapoor_CV.pdf");
    expect(container.querySelector('[data-testid="analysis-score"]')?.textContent).toBe("13");
    expect(container.textContent).toContain("Provisional");
    expect(container.textContent).toContain("not a complete 100-point score");
    expect(container.textContent).not.toContain("13/13");
    expect(container.textContent).toContain("What's working well");
    expect(container.textContent).toContain("Required sections");
    expect(container.textContent).toContain("2 of 2 evaluated");
    expect(container.textContent).toContain("Coverage represents completed checks, not resume quality or earned points.");
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
    expect(container.textContent).toContain("This check is not yet available.");
    expect(container.textContent).not.toContain("no scoring method has been approved");
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
    expect(container.textContent).toContain("Evaluated with confirmed improvement opportunities");
    expect(container.textContent).not.toContain("2/4");
    expect(container.textContent).toContain("A phone number was not found.");
    expect(container.textContent).not.toContain("No confirmed issues");
    expect(container.querySelector('[data-testid="scored-findings"]')?.textContent).toContain("A phone number was not found.");
    expect(container.querySelector('[data-testid="scored-findings"]')?.textContent).not.toContain("Recieve");
    expect(container.querySelector('[data-testid="writing-suggestions"]')?.textContent).toContain("These notes are not part of the score.");
    expect(container.querySelector('[data-testid="writing-suggestions"]')?.textContent).toContain('Possible misspelling "Recieve".');

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
    expect(container.textContent).toContain("Score unavailable");
    expect(container.textContent).not.toContain("/100");
    expect(container.textContent).not.toContain("OPEN_DECISION");
    expect(container.textContent).not.toContain("rubric-2026-11-12-provisional");
    expect(container.textContent).not.toContain("DETECTOR_VERSION");
    expect(container.textContent).toContain("Your improvement plan is ready.");
    expect(container.textContent).toContain("1 of 2 evaluated");
    expect(container.textContent).not.toContain("%");
    cleanup();
  });

  it("filters findings without turning withheld checks into failures", () => {
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({ score: null, areas: [{ label: "Contact information", state: "passed" }] })}
        findings={[
          {
            id: "spell",
            kind: "note",
            message: 'Possible misspelling "Recieve".',
            suggestion: "Receive",
            evidence: [],
          },
        ]}
        onHighlight={() => undefined}
      />,
    );

    expect(container.textContent).toContain("What's working well");
    expect(container.textContent).toContain("Contact information");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("1 of 1 evaluated");
    expect(container.textContent).toContain("Additional checks pending");
    const card = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Recieve"));
    act(() => {
      card?.click();
    });
    expect(container.textContent).toContain("Suggested approach");
    expect(container.textContent).toContain("Receive");
    const summary = container.querySelector("details");
    act(() => {
      summary?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (summary) {
        summary.open = true;
      }
    });
    expect(container.textContent).toContain("Readability");
    expect(container.textContent).toContain("not yet available");
    expect(container.textContent).not.toContain("Failed");
    expect(container.textContent).not.toContain("/100");
    cleanup();
  });

  it("shows a completed score without a denominator", () => {
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({
          status: "complete",
          score: 13,
          notice: "This result is complete.",
          unavailable: [],
        })}
        findings={[]}
        onHighlight={() => undefined}
      />,
    );

    expect(container.querySelector('[data-testid="analysis-score"]')?.textContent).toBe("13");
    expect(container.textContent).toContain("Complete");
    expect(container.textContent).not.toContain("Provisional");
    expect(container.textContent).not.toContain("/100");
    expect(container.textContent).not.toContain("%");
    expect(container.textContent).toContain("No confirmed issues in the scored checks.");
    expect(container.textContent).not.toContain("Other checks are not yet available.");
    cleanup();
  });

  it("uses the unavailable count from the evaluation and keeps that list collapsed", () => {
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({
          unavailable: [
            { label: "Readability", explanation: "The recognizer is still undecided." },
            { label: "Section order", explanation: "This check is not yet available." },
          ],
        })}
        findings={[]}
        onHighlight={() => undefined}
      />,
    );
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(container.textContent).toContain("Checks not yet available (2)");
    expect(container.textContent).not.toContain("Checks not yet available (15)");
    expect(container.textContent).not.toContain("4 of 5");
    expect(container.textContent).not.toContain("undecided");
    expect(container.textContent).toContain("This check is not yet available.");
    cleanup();
  });

  it("derives bullet coverage from the response and groups repeated findings once per bullet", () => {
    const findings: ScoreFinding[] = [
      finding("q1", "This bullet does not include a measurable quantity.", "bullet-a", 1),
      finding("q2", "This bullet does not include a measurable quantity.", "bullet-a", 1),
      finding("q3", "This bullet does not include a measurable quantity.", "bullet-b"),
      finding("impact", "This bullet does not state a measurable outcome.", "bullet-c", 2),
    ];
    const onHighlight = vi.fn();
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({
          areas: [
            { label: "Bullet length", state: "passed" },
            { label: "Action verbs", state: "review" },
            { label: "Quantified metrics", state: "review" },
            { label: "Impact metrics", state: "passed" },
          ],
          unavailable: [{ label: "Bullets per role", explanation: "This check could not be completed from the roles on this resume." }],
        })}
        findings={findings}
        onHighlight={onHighlight}
        sourceBlocks={[
          { id: "bullet-a", text: "Developed REST APIs using Spring Boot.", page: 1 },
          { id: "bullet-c", text: "Improved the billing workflow." },
        ]}
      />,
    );

    expect(container.textContent).toContain("4 of 5 evaluated");
    expect(container.textContent).not.toContain("5 of 5 evaluated");
    const bulletCoverage = container.querySelector('[data-testid="coverage-bullet-points"]');
    expect(bulletCoverage?.querySelectorAll("span.h-1\\.5").length).toBe(5);
    const bulletDetails = bulletCoverage?.querySelector("details");
    expect(bulletDetails?.open).toBe(false);
    act(() => {
      bulletDetails?.querySelector("summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (bulletDetails) {
        bulletDetails.open = true;
      }
    });
    expect(bulletCoverage?.textContent).toContain("Evaluated");
    expect(bulletCoverage?.textContent).toContain("Evaluated with confirmed improvement opportunities");
    expect(bulletCoverage?.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Add measurable quantities");
    expect(container.textContent).toContain("2 bullets need attention");
    expect(container.textContent).toContain("Developed REST APIs using Spring Boot.");
    expect(container.textContent).toContain("Original bullet · Page 1");
    expect(container.textContent).toContain("[quantity, percentage, duration, or scale]");
    expect(container.textContent).toContain("Replace placeholders with verified information.");
    expect(container.textContent).not.toContain("rewritten achievement");
    const missing = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("bullet-b") || button.textContent?.includes("Original text is not available"));
    expect(container.textContent).toContain("Original text is not available for this result.");
    expect(missing).toBeTruthy();
    const located = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Improved the billing workflow."));
    act(() => {
      located?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onHighlight).toHaveBeenCalledWith(expect.objectContaining({ blockId: "bullet-c", page: 2, tone: "issue" }));
    expect(container.textContent).not.toContain("OPEN_DECISION");
    expect(container.textContent).not.toContain("65%");
    cleanup();
  });

  it("shows five of five when every bullet check in the response was evaluated", () => {
    const { container, cleanup } = renderPanel(
      <ScorePanel
        activeHighlight={null}
        evaluation={evaluation({
          areas: [
            { label: "Bullet length", state: "review" },
            { label: "Action verbs", state: "passed" },
            { label: "Quantified metrics", state: "passed" },
            { label: "Impact metrics", state: "passed" },
            { label: "Bullets per role", state: "passed" },
          ],
          unavailable: [],
        })}
        findings={[]}
        onHighlight={() => undefined}
      />,
    );
    expect(container.textContent).toContain("5 of 5 evaluated");
    expect(container.textContent).not.toContain("Unavailable");
    cleanup();
  });
});

function finding(id: string, message: string, blockId: string, page?: number): ScoreFinding {
  return {
    id,
    kind: "issue",
    message,
    evidence: [{ blockId, startOffset: 0, endOffset: 8, ...(page === undefined ? {} : { page }) }],
  };
}
