import { test, expect } from "@playwright/test";

// Smoke tier — verifies the app boots and the auth boundary holds. These use
// only selectors confirmed against the running app (the login form and the
// unauthenticated /dashboard -> /login redirect). Deeper, authenticated flows
// (job lifecycle, invoice builder, role-based 403s) are added once the seeded
// local stack is wired in — see tests/e2e/README once the stack lands.

test("unauthenticated visit to /dashboard redirects to the login page", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});

test("login page renders the email + password form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByPlaceholder("you@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});
