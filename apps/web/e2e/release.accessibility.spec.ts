import { expect, test } from "@playwright/test";
import { routeSession, routeSignedIn, routeSignedOut } from "./session";

test("signed-out account form exposes labeled controls and stays keyboard-reachable", async ({ page }) => {
  await routeSignedOut(page);
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password");
  const displayName = page.getByLabel("Display name");
  await expect(email).toBeVisible();
  await expect(password).toBeVisible();
  await expect(displayName).toBeVisible();
  await expect(password).toHaveAttribute("autocomplete", "current-password");

  await email.focus();
  await expect(email).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();

  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show password" })).toBeVisible();

  const overflow = await page.evaluate(() => {
    const root = globalThis.document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByText("ada@example.com")).toHaveCount(0);
});

test("a restored session opens the signed-in landing page", async ({ page }) => {
  await routeSignedIn(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Welcome back, Ada.", exact: true })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
});

test("a session server error does not show the sign-in form or private workspace", async ({ page }) => {
  await routeSession(page, 503, { error: { code: "DATABASE_UNAVAILABLE", message: "Database unavailable" } });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VerveCV could not reach your account" })).toBeVisible();
  await expect(page.getByLabel("Email")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Welcome back, Ada." })).toHaveCount(0);
});

test("an unavailable session endpoint does not show the sign-in form", async ({ page }) => {
  await page.route("**/api/v1/me", (route) => route.abort("connectionrefused"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "VerveCV could not reach your account" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByLabel("Password")).toHaveCount(0);
});
