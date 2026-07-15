import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the timesheet upload button: file picker, multipart
// submission from the browser, and rendering of the imported line items and
// warnings in the UI. Runs against the live web + API artifacts and the shared
// development database (all created records are cleaned up afterwards).

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ALICE = `E2E Alice ${uniq}`;
const BOB = `E2E Bob ${uniq}`;
const ZERO_HOURS = `E2E ZeroHours ${uniq}`;

async function buildTimesheetXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Employee", "Classification", "Category", "Location", "Hours", "Rate"]);
  ws.addRow([ALICE, "Senior Engineer", "Regular", "Home", 40, 150]);
  ws.addRow([BOB, "Engineer", "Overtime", "Field", 8, 120]);
  // Zero hours row: the importer must skip it and surface a warning.
  ws.addRow([ZERO_HOURS, "Engineer", "Regular", "Home", 0, 100]);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

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

test("timesheet upload button imports an .xlsx and shows line items + warnings", async ({
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

  // --- Seed a work plan + draft invoice through the API ------------------
  const token = await apiToken(page);
  const api = (path: string) => `${baseURL}/api${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const wpRes = await page.request.post(api("/work-plans"), {
    headers,
    data: {
      code: `E2E-WP-${uniq}`,
      title: "E2E Upload Test Plan",
      client: "E2E Client",
      jobNumber: "E2E-JOB",
      totalBudget: 100000,
      billingCycle: "whole_month",
    },
  });
  expect(wpRes.status(), await wpRes.text()).toBe(201);
  const workPlan = (await wpRes.json()) as { id: number };

  const invRes = await page.request.post(api("/invoices"), {
    headers,
    data: {
      workPlanId: workPlan.id,
      invoiceNumber: `E2E-INV-${uniq}`,
      invoiceDate: "2026-07-15",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    },
  });
  expect(invRes.status(), await invRes.text()).toBe(201);
  const invoice = (await invRes.json()) as { id: number };

  try {
    // --- Drive the real import button in the browser ---------------------
    await page.goto(`/invoices/${invoice.id}`);
    await page.getByRole("tab", { name: /import/i }).click();

    // Source select: switch from the default "Procas" to "Timesheet".
    await page.getByRole("combobox").filter({ hasText: /procas/i }).click();
    await page.getByRole("option", { name: "Timesheet" }).click();

    await page.locator('input[type="file"]').setInputFiles({
      name: "timesheet-sample.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: await buildTimesheetXlsx(),
    });

    const uploadRequest = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/invoices/${invoice.id}/time-import`) &&
        res.request().method() === "POST",
    );
    await page.getByRole("button", { name: /upload & import/i }).click();
    const uploadResponse = await uploadRequest;
    expect(uploadResponse.status(), await uploadResponse.text()).toBe(200);

    // --- Warnings must be rendered in the UI ------------------------------
    const warnings = page.getByTestId("import-warnings");
    await expect(warnings).toBeVisible();
    await expect(warnings).toContainText(ZERO_HOURS);
    await expect(warnings).toContainText(/missing or zero hours, skipped/i);

    // --- Imported line items must appear in the Line Items tab -----------
    await page.getByRole("tab", { name: /line items/i }).click();
    const aliceRow = page.getByRole("row", { name: new RegExp(ALICE) });
    await expect(aliceRow).toBeVisible();
    await expect(aliceRow).toContainText("40");
    await expect(aliceRow).toContainText("150");

    const bobRow = page.getByRole("row", { name: new RegExp(BOB) });
    await expect(bobRow).toBeVisible();
    await expect(bobRow).toContainText("8");
    await expect(bobRow).toContainText("120");

    await expect(
      page.getByRole("row", { name: new RegExp(ZERO_HOURS) }),
    ).toHaveCount(0);
  } finally {
    // --- Clean up the shared development database -------------------------
    await page.request.delete(api(`/invoices/${invoice.id}`), { headers });
    await page.request.delete(api(`/work-plans/${workPlan.id}`), { headers });
  }
});
