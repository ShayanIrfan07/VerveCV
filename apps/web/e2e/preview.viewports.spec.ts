import { expect, test } from "@playwright/test";

test("sample PDF preview keeps section layout and does not outline the first block", async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Preview sample PDF" }).click();
  await expect(page.getByRole("heading", { name: "Extracted text" })).toBeVisible();
  await expect(page.getByTestId("pdf-highlight-box")).toHaveCount(0);

  const heading = page.locator('[data-block-type="heading"]');
  await expect(heading).toHaveText("Work Experience");
  await expect(heading).toHaveClass(/whitespace-pre-wrap/);
  await expect(heading).toHaveClass(/font-semibold/);

  const paragraph = page.locator('[data-block-type="paragraph"]');
  await expect(paragraph).toContainText("Shipped the export pipeline.");
  await expect(paragraph).toHaveClass(/whitespace-pre-wrap/);
  await expect(paragraph).toHaveClass(/text-sm/);

  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const canvas = globalThis.document.querySelector("canvas");
          if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0) {
            return 0;
          }
          const context = canvas.getContext("2d");
          if (!context) {
            return 0;
          }
          const pixels = context.getImageData(0, 0, canvas.width, Math.min(canvas.height, 220)).data;
          let dark = 0;
          for (let index = 0; index < pixels.length; index += 16) {
            const red = pixels[index] ?? 255;
            const green = pixels[index + 1] ?? 255;
            const blue = pixels[index + 2] ?? 255;
            if (red < 240 || green < 240 || blue < 240) {
              dark += 1;
            }
          }
          return dark;
        }),
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: testInfo.outputPath("sample-pdf-preview.png"),
    fullPage: true,
  });

  const overflow = await page.evaluate(() => {
    const root = globalThis.document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
