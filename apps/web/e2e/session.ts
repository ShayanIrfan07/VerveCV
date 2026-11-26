import type { Page, Route } from "@playwright/test";

const UNAUTHENTICATED = {
  error: { code: "UNAUTHORIZED", message: "Authentication required" },
};

export async function routeSession(page: Page, status: number, body: unknown = UNAUTHENTICATED): Promise<void> {
  await page.route("**/api/v1/me", async (route: Route) => {
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

export async function routeSignedOut(page: Page): Promise<void> {
  await routeSession(page, 401);
}

export async function routeSignedIn(page: Page): Promise<void> {
  await routeSession(page, 200, {
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "ada@example.com",
      displayName: "Ada",
    },
  });
  await page.route("**/api/v1/evaluations**", async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        evaluations: [],
        pagination: { limit: 20, offset: 0, hasMore: false, nextOffset: null },
      }),
    });
  });
}
