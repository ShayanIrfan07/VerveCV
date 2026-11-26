import { expect, test } from "@playwright/test";
import { routeSignedIn } from "./session";

const resume = {
  id: "eval-1",
  resumeId: "resume-1",
  resumeVersionId: "version-1",
  originalFilename: "Software_Engineer_Resume.pdf",
  mimeType: "application/pdf",
  status: "provisional",
  score: 11,
  createdAt: "2026-11-26T00:00:00.000Z",
};

test("confirmed deletion removes the resume on desktop, tablet, and mobile", async ({ page }, testInfo) => {
  let deleted = false;
  await routeSignedIn(page);
  await page.route("**/api/v1/evaluations**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evaluations: deleted ? [] : [resume],
        pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
      }),
    });
  });
  await page.route("**/api/v1/resumes/resume-1", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.fallback();
      return;
    }
    deleted = true;
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Recent resumes" })).toBeVisible();
  await page.getByRole("button", { name: "Delete Software_Engineer_Resume.pdf" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this resume?" });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("delete-dialog.png"), fullPage: true });
  await expect(dialog).toContainText("Software_Engineer_Resume.pdf");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Software_Engineer_Resume.pdf")).toBeVisible();

  await page.getByRole("button", { name: "Delete Software_Engineer_Resume.pdf" }).click();
  await page.getByRole("button", { name: "Delete resume" }).click();
  await expect(page.getByRole("status")).toContainText("Deletion requested. Software_Engineer_Resume.pdf is no longer available.");
  await expect(page.getByText("No scores yet.")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
