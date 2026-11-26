import { expect, test } from "@playwright/test";
import { routeSignedIn } from "./session";

const historyItem = {
  id: "eval-1",
  resumeId: "resume-1",
  resumeVersionId: "version-1",
  originalFilename: "Ada_Resume.pdf",
  mimeType: "application/pdf",
  status: "provisional",
  score: 23,
  createdAt: "2026-11-26T00:00:00.000Z",
};

test("historical evaluation shows coverage and grouped findings", async ({ page }, testInfo) => {
  await routeSignedIn(page);
  await page.route("**/api/v1/evaluations**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/v1/evaluations/eval-1")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          evaluation: {
            ...historyItem,
            notice: "This result is provisional and is not a complete 100-point score.",
            areas: [
              { label: "Bullet length", state: "passed" },
              { label: "Action verbs", state: "passed" },
              { label: "Quantified metrics", state: "review" },
              { label: "Impact metrics", state: "review" },
              { label: "Contact information", state: "passed" },
            ],
            unavailable: [
              { label: "Bullets per role", explanation: "This check could not be completed from the roles on this resume." },
              { label: "Resume filename", explanation: "The filename includes a name, but this criterion has not been evaluated." },
              { label: "Readability", explanation: "This check is not yet available." },
            ],
          },
          findings: [
            {
              id: "q1",
              kind: "issue",
              message: "This bullet does not include a measurable quantity.",
              suggestion: null,
              evidence: [{ blockId: "bullet-1", startOffset: 0, endOffset: 12 }],
            },
            {
              id: "q2",
              kind: "issue",
              message: "This bullet does not include a measurable quantity.",
              suggestion: null,
              evidence: [{ blockId: "bullet-2", startOffset: 0, endOffset: 12 }],
            },
            {
              id: "impact",
              kind: "issue",
              message: "This bullet does not state a measurable outcome.",
              suggestion: null,
              evidence: [{ blockId: "bullet-3", startOffset: 0, endOffset: 12, page: 1 }],
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evaluations: [historyItem],
        pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
      }),
    });
  });
  await page.route("**/api/v1/resumes/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "missing" } }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "23Provisional Ada_Resume.pdf" }).click();
  await expect(page.getByText("4 of 5 evaluated")).toBeVisible();
  await expect(page.getByText("Coverage represents completed checks, not resume quality or earned points.")).toBeVisible();
  const bulletCoverage = page.getByTestId("coverage-bullet-points");
  await bulletCoverage.getByText("View individual checks").click();
  await expect(bulletCoverage.getByText("Bullets per role")).toBeVisible();
  await expect(bulletCoverage.getByText("Unavailable")).toBeVisible();
  await expect(page.getByText("Add measurable quantities")).toBeVisible();
  await expect(page.getByText("2 bullets need attention")).toBeVisible();
  await expect(page.getByText("Original text is not available for this result.").first()).toBeVisible();
  await expect(page.getByText("[quantity, percentage, duration, or scale]")).toBeVisible();
  await expect(page.getByText("Checks not yet available (3)")).toBeVisible();
  await page.getByText("Demonstrate measurable impact").click();
  await expect(page.getByText("[verified improvement in time, cost, quality, or performance]")).toBeVisible();
  await page.getByTestId("resume-health").screenshot({ path: testInfo.outputPath("health.png") });
  await page.getByTestId("scored-findings").screenshot({ path: testInfo.outputPath("findings.png") });
});

test("all five bullet checks show evaluated coverage", async ({ page }, testInfo) => {
  await routeSignedIn(page);
  await page.route("**/api/v1/evaluations**", async (route) => {
    const url = route.request().url();
    if (url.includes("/api/v1/evaluations/eval-1")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          evaluation: {
            ...historyItem,
            score: 35,
            notice: "This result is provisional and is not a complete 100-point score.",
            areas: [
              { label: "Bullet length", state: "passed" },
              { label: "Action verbs", state: "passed" },
              { label: "Quantified metrics", state: "passed" },
              { label: "Impact metrics", state: "passed" },
              { label: "Bullets per role", state: "passed" },
              { label: "Required sections", state: "passed" },
            ],
            unavailable: [
              { label: "Readability", explanation: "This check is not yet available." },
            ],
          },
          findings: [],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evaluations: [{ ...historyItem, score: 35 }],
        pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
      }),
    });
  });
  await page.route("**/api/v1/resumes/**", async (route) => {
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "missing" } }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "35Provisional Ada_Resume.pdf" }).click();
  const bulletCoverage = page.getByTestId("coverage-bullet-points");
  await expect(bulletCoverage.getByText("5 of 5 evaluated")).toBeVisible();
  await bulletCoverage.getByText("View individual checks").click();
  await expect(bulletCoverage.getByText("Unavailable")).toHaveCount(0);
  await page.getByTestId("resume-health").screenshot({ path: testInfo.outputPath("health-complete.png") });
});
