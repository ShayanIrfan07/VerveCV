import { expect, test } from "@playwright/test";

test("signed-out account form exposes labeled controls and stays keyboard-reachable", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password");
  const displayName = page.getByLabel("Display name");
  await expect(email).toBeVisible();
  await expect(password).toBeVisible();
  await expect(displayName).toBeVisible();

  await email.focus();
  await expect(email).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();

  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();

  const overflow = await page.evaluate(() => {
    const root = globalThis.document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
