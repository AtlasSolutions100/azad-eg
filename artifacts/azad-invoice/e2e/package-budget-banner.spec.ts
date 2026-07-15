import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the package workspace budget warning: the yellow
// "Approaching budget limit" banner near the threshold and the red
// "Over budget" banner plus red remaining balance when over budget. Runs
// against the live web + API artifacts and the shared development database
// (all created records are cleaned up afterwards).

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function apiToken(page: Page): Promise<string> {
  const token = await page.evaluate(async () => {
    const clerkGlobal = (window as unknown as {
      Clerk?: { session?: { getToken: () => Promise<string | null> } };
    }).Clerk;
    return (await clerkGlobal?.session?.getToken()) ?? null;
  });
  if (!token) throw new Error("Could not obtain a Clerk API token from the page.");
  return token;
}

test("package invoice tab shows budget banners at approaching and over thresholds", async ({
  page,
  baseURL,
}) => {
  // --- Sign in programmatically (Clerk test-mode email code) -------------
  await page.goto("/");
  await clerk.loaded({ page });
  await clerk.signIn({
    page,
    signInParams: { strategy: "email_code", identifier: TEST_USER_EMAIL },
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: /work plans/i }).first(),
  ).toBeVisible({ timeout: 20_000 });

  const token = await apiToken(page);
  const api = (path: string) => `${baseURL}/api${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // --- Seed: one $100k work plan per package; previouslyBilled drives ----
  // percentExpended directly (95% => approaching, 120% => over budget).
  const createdWorkPlanIds: number[] = [];
  const createdPackageIds: number[] = [];

  async function seedPackage(codeSuffix: string, previouslyBilled: number): Promise<number> {
    const wpRes = await page.request.post(api("/work-plans"), {
      headers,
      data: {
        code: `E2E-BUDGET-${codeSuffix}-${uniq}`,
        title: `E2E Budget ${codeSuffix} Plan`,
        client: "E2E Client",
        jobNumber: `E2E-JOB-${codeSuffix}`,
        totalBudget: 100000,
        billingCycle: "whole_month",
      },
    });
    expect(wpRes.status(), await wpRes.text()).toBe(201);
    const workPlan = (await wpRes.json()) as { id: number };
    createdWorkPlanIds.push(workPlan.id);

    const pkgRes = await page.request.post(api("/packages"), {
      headers,
      data: {
        workPlanId: workPlan.id,
        payPeriodStart: "2026-07-06",
        payPeriodEnd: "2026-07-19",
        invoiceNumber: `E2E-BUDGET-${codeSuffix}-${uniq}`,
        invoiceDate: "2026-07-21",
        previouslyBilled,
      },
    });
    expect(pkgRes.status(), await pkgRes.text()).toBe(201);
    const pkg = (await pkgRes.json()) as { id: number };
    createdPackageIds.push(pkg.id);
    return pkg.id;
  }

  try {
    const approachingId = await seedPackage("APPR", 95000);
    const overId = await seedPackage("OVER", 120000);

    // --- Approaching: yellow banner, no red remaining balance -------------
    await page.goto(`/packages/${approachingId}`);
    await page.getByRole("tab", { name: /invoice/i }).first().click();

    const approachingBanner = page.getByTestId("alert-package-budget");
    await expect(approachingBanner).toBeVisible();
    await expect(approachingBanner).toContainText(/approaching budget limit/i);
    await expect(approachingBanner).toContainText(/95% expended/i);
    await expect(approachingBanner).toContainText(/\$5,000\.00/);
    await expect(approachingBanner).toHaveClass(/bg-yellow-50/);
    await expect(approachingBanner).not.toHaveClass(/bg-red-50/);
    await expect(page.getByTestId("text-remaining-balance-over")).toHaveCount(0);

    // --- Over budget: red banner + red remaining balance -------------------
    await page.goto(`/packages/${overId}`);
    await page.getByRole("tab", { name: /invoice/i }).first().click();

    const overBanner = page.getByTestId("alert-package-budget");
    await expect(overBanner).toBeVisible();
    await expect(overBanner).toContainText(/over budget/i);
    await expect(overBanner).toContainText(/120% of the work plan budget/i);
    await expect(overBanner).toContainText(/-\$20,000\.00/);
    await expect(overBanner).toContainText(/recorded budget override/i);
    await expect(overBanner).toHaveClass(/bg-red-50/);

    const remaining = page.getByTestId("text-remaining-balance-over");
    await expect(remaining).toBeVisible();
    await expect(remaining).toContainText("-$20,000.00");
    await expect(remaining).toHaveClass(/text-red-600/);
  } finally {
    // --- Clean up the shared development database -------------------------
    for (const id of createdPackageIds) {
      await page.request.delete(api(`/packages/${id}`), { headers });
    }
    for (const id of createdWorkPlanIds) {
      await page.request.delete(api(`/work-plans/${id}`), { headers });
    }
  }
});
