import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  db,
  auditLogsTable,
  signaturesTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the over-budget override dialog: the
// "Override & Approve" button must stay disabled while the reason is blank
// or whitespace-only, enable once a real reason is typed, and the approved
// reason must show up in the entity's budget-override history. Covered in
// both the invoice detail page and the package workspace invoice tab.
//
// Runs against the live web + API artifacts and the shared development
// database (all created records are cleaned up afterwards).

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

async function signIn(page: Page): Promise<void> {
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
}

// Asserts the shared dialog behavior: approve disabled while blank, still
// disabled for whitespace-only input, enabled once a real reason is typed.
async function assertReasonGate(page: Page, reason: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/approve over budget\?/i);

  const approveButton = dialog.getByRole("button", { name: /override & approve/i });
  const reasonBox = dialog.locator("textarea");

  // Blank: disabled, with the inline hint shown.
  await expect(approveButton).toBeDisabled();
  await expect(dialog).toContainText(/a reason is required to approve over budget/i);

  // Whitespace-only must not count as a reason.
  await reasonBox.fill("   \t  ");
  await expect(approveButton).toBeDisabled();
  await expect(dialog).toContainText(/a reason is required to approve over budget/i);

  // A real reason enables the button.
  await reasonBox.fill(reason);
  await expect(approveButton).toBeEnabled();
}

test.describe("over-budget override dialog requires a non-blank reason", () => {
  test("invoice detail page", async ({ page, baseURL }) => {
    await signIn(page);
    const token = await apiToken(page);
    const api = (path: string) => `${baseURL}/api${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    // The invoice approval flow signs with the default signature; the shared
    // dev database may not have one, so seed one directly and remove it after.
    const [seededSignature] = await db
      .insert(signaturesTable)
      .values({
        name: `E2E Override Signer ${uniq}`,
        imageUrl: "/api/files/e2e-nonexistent-signature.png",
        isDefault: true,
      })
      .returning();

    let workPlanId: number | null = null;
    let invoiceId: number | null = null;
    try {
      // --- Seed: $100k plan, invoice already $120k previously billed -------
      const wpRes = await page.request.post(api("/work-plans"), {
        headers,
        data: {
          code: `E2E-OVR-INV-${uniq}`,
          title: "E2E Override Reason Invoice Plan",
          client: "E2E Client",
          jobNumber: "E2E-JOB-OVR-INV",
          totalBudget: 100000,
          billingCycle: "whole_month",
        },
      });
      expect(wpRes.status(), await wpRes.text()).toBe(201);
      workPlanId = ((await wpRes.json()) as { id: number }).id;

      const invRes = await page.request.post(api("/invoices"), {
        headers,
        data: {
          workPlanId,
          invoiceNumber: `E2E-OVR-INV-${uniq}`,
          invoiceDate: "2026-07-15",
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
          previouslyBilled: 120000,
        },
      });
      expect(invRes.status(), await invRes.text()).toBe(201);
      invoiceId = ((await invRes.json()) as { id: number }).id;

      // A line item so validations pass and the Approve button is enabled.
      const liRes = await page.request.post(api(`/invoices/${invoiceId}/line-items`), {
        headers,
        data: {
          employeeName: "E2E Worker",
          classification: "Engineer",
          category: "regular",
          location: "home",
          hours: 8,
          rate: 100,
        },
      });
      expect(liRes.status(), await liRes.text()).toBe(201);

      // --- Trigger approval; the override dialog gates on a real reason ----
      await page.goto(`/invoices/${invoiceId}`);
      await page.getByRole("button", { name: "Approve", exact: true }).click();

      const reason = `E2E invoice override reason ${uniq}`;
      await assertReasonGate(page, reason);

      const approveRequest = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/invoices/${invoiceId}/approve`) &&
          res.request().method() === "POST",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /override & approve/i })
        .click();
      const approveResponse = await approveRequest;
      expect(approveResponse.status(), await approveResponse.text()).toBe(200);

      // --- The reason lands in the invoice's override history --------------
      const history = page
        .locator('[role="alert"]')
        .filter({ hasText: /budget override.* on record/i });
      await expect(history.first()).toBeVisible();
      await expect(history.first()).toContainText(reason);
    } finally {
      // --- Clean up the shared development database -------------------------
      if (invoiceId != null) {
        await page.request.delete(api(`/invoices/${invoiceId}`), { headers });
        await db
          .delete(auditLogsTable)
          .where(and(eq(auditLogsTable.entityType, "invoice"), eq(auditLogsTable.entityId, invoiceId)));
      }
      if (workPlanId != null) {
        await page.request.delete(api(`/work-plans/${workPlanId}`), { headers });
      }
      await db.delete(signaturesTable).where(eq(signaturesTable.id, seededSignature.id));
    }
  });

  test("package workspace invoice tab", async ({ page, baseURL }) => {
    await signIn(page);
    const token = await apiToken(page);
    const api = (path: string) => `${baseURL}/api${path}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    let workPlanId: number | null = null;
    let packageId: number | null = null;
    try {
      // --- Seed: $100k plan, package already $120k previously billed -------
      const wpRes = await page.request.post(api("/work-plans"), {
        headers,
        data: {
          code: `E2E-OVR-PKG-${uniq}`,
          title: "E2E Override Reason Package Plan",
          client: "E2E Client",
          jobNumber: "E2E-JOB-OVR-PKG",
          totalBudget: 100000,
          billingCycle: "whole_month",
        },
      });
      expect(wpRes.status(), await wpRes.text()).toBe(201);
      workPlanId = ((await wpRes.json()) as { id: number }).id;

      const pkgRes = await page.request.post(api("/packages"), {
        headers,
        data: {
          workPlanId,
          payPeriodStart: "2026-07-06",
          payPeriodEnd: "2026-07-19",
          invoiceNumber: `E2E-OVR-PKG-${uniq}`,
          invoiceDate: "2026-07-21",
          previouslyBilled: 120000,
        },
      });
      expect(pkgRes.status(), await pkgRes.text()).toBe(201);
      packageId = ((await pkgRes.json()) as { id: number }).id;

      // A week + timesheet entry so validations pass (no blocking errors).
      const weekRes = await page.request.post(api(`/packages/${packageId}/weeks`), {
        headers,
        data: { label: "Week 1", weekStart: "2026-07-06", weekEnd: "2026-07-12" },
      });
      expect(weekRes.status(), await weekRes.text()).toBe(201);
      const week = (await weekRes.json()) as { id: number };

      const entryRes = await page.request.post(api(`/packages/${packageId}/entries`), {
        headers,
        data: {
          weekId: week.id,
          employeeName: "E2E Worker",
          classification: "Engineer",
          category: "regular",
          location: "home",
          hoursMon: 8,
          rate: 100,
        },
      });
      expect(entryRes.status(), await entryRes.text()).toBe(201);

      // --- Trigger approval; the override dialog gates on a real reason ----
      await page.goto(`/packages/${packageId}`);
      await page.getByRole("tab", { name: /invoice/i }).first().click();
      await page.getByRole("button", { name: "Approve", exact: true }).click();

      const reason = `E2E package override reason ${uniq}`;
      await assertReasonGate(page, reason);

      const approveRequest = page.waitForResponse(
        (res) =>
          res.url().includes(`/api/packages/${packageId}`) &&
          res.request().method() === "PATCH",
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /override & approve/i })
        .click();
      const approveResponse = await approveRequest;
      expect(approveResponse.status(), await approveResponse.text()).toBe(200);

      // --- The reason lands in the package's override history --------------
      const history = page
        .locator('[role="alert"]')
        .filter({ hasText: /budget override.* on record/i });
      await expect(history.first()).toBeVisible();
      await expect(history.first()).toContainText(reason);
    } finally {
      // --- Clean up the shared development database -------------------------
      if (packageId != null) {
        await page.request.delete(api(`/packages/${packageId}`), { headers });
        await db
          .delete(auditLogsTable)
          .where(and(eq(auditLogsTable.entityType, "package"), eq(auditLogsTable.entityId, packageId)));
      }
      if (workPlanId != null) {
        await page.request.delete(api(`/work-plans/${workPlanId}`), { headers });
      }
    }
  });
});
