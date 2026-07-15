import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the *failure* path of the timesheet upload: an
// .xlsx that the API rejects with HTTP 400 { error, warnings } must surface
// a clear destructive "Import failed" toast in the browser, and the specific
// row-level warnings from the response body must be rendered — not just a
// generic message.

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SKIPPED_EMPLOYEE = `E2E Rejected ${uniq}`;

// A recognizable header row but every data row has zero hours, so the parser
// skips them all and the API responds 400 with per-row warnings.
async function buildAllZeroHoursXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Employee", "Classification", "Category", "Location", "Hours", "Rate"]);
  ws.addRow([SKIPPED_EMPLOYEE, "Engineer", "Regular", "Home", 0, 100]);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

// No recognizable header row at all — the parser cannot find employee/hours
// columns and rejects the whole file.
async function buildNoHeaderXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["Foo", "Bar", "Baz"]);
  ws.addRow(["a", "b", "c"]);
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

async function uploadInvalidFile(
  page: Page,
  invoiceId: number,
  file: { name: string; buffer: Buffer },
): Promise<void> {
  await page.goto(`/invoices/${invoiceId}`);
  await page.getByRole("tab", { name: /import/i }).click();

  // Source select: switch from the default "Procas" to "Timesheet".
  await page.getByRole("combobox").filter({ hasText: /procas/i }).click();
  await page.getByRole("option", { name: "Timesheet" }).click();

  await page.locator('input[type="file"]').setInputFiles({
    name: file.name,
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: file.buffer,
  });

  const uploadRequest = page.waitForResponse(
    (res) =>
      res.url().includes(`/api/invoices/${invoiceId}/time-import`) &&
      res.request().method() === "POST",
  );
  await page.getByRole("button", { name: /upload & import/i }).click();
  const uploadResponse = await uploadRequest;
  expect(uploadResponse.status(), await uploadResponse.text()).toBe(400);
}

test("a rejected upload shows a destructive toast with the API error and its warnings", async ({
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
      code: `E2E-WP-REJ-${uniq}`,
      title: "E2E Rejected Upload Plan",
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
      invoiceNumber: `E2E-INV-REJ-${uniq}`,
      invoiceDate: "2026-07-15",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    },
  });
  expect(invRes.status(), await invRes.text()).toBe(201);
  const invoice = (await invRes.json()) as { id: number };

  try {
    // --- Case 1: valid headers, but every row is skipped (zero hours) ----
    await uploadInvalidFile(page, invoice.id, {
      name: "all-zero-hours.xlsx",
      buffer: await buildAllZeroHoursXlsx(),
    });

    // The destructive toast must show the API's error message, not a
    // generic one, and point at the warning details.
    const toast = page.getByRole("status").filter({ hasText: /import failed/i });
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText(/no valid rows found/i);
    await expect(toast.first()).toContainText(/warning/i);

    // The row-level warnings from the 400 body must be rendered in the UI.
    const warnings = page.getByTestId("import-warnings");
    await expect(warnings).toBeVisible();
    await expect(warnings).toContainText(SKIPPED_EMPLOYEE);
    await expect(warnings).toContainText(/missing or zero hours, skipped/i);

    // Nothing was imported.
    await page.getByRole("tab", { name: /line items/i }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(SKIPPED_EMPLOYEE) }),
    ).toHaveCount(0);

    // --- Case 2: no recognizable header row ------------------------------
    await uploadInvalidFile(page, invoice.id, {
      name: "no-header.xlsx",
      buffer: await buildNoHeaderXlsx(),
    });

    const toast2 = page.getByRole("status").filter({ hasText: /import failed/i });
    await expect(toast2.first()).toBeVisible();
    await expect(toast2.first()).toContainText(/no valid rows found/i);

    const warnings2 = page.getByTestId("import-warnings");
    await expect(warnings2).toBeVisible();
    await expect(warnings2).toContainText(/could not locate a header row/i);
  } finally {
    // --- Clean up the shared development database -------------------------
    await page.request.delete(api(`/invoices/${invoice.id}`), { headers });
    await page.request.delete(api(`/work-plans/${workPlan.id}`), { headers });
  }
});
