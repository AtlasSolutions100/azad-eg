import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page, type Locator } from "@playwright/test";
import ExcelJS from "exceljs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, auditLogsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the Billed Line Items editor (package Invoice tab)
// and the 8 invoice-cover header fields on the work plan form:
//   1. edit the cover fields in the work-plan dialog and save;
//   2. add + edit billed line items in the editor card and save;
//   3. export the package and verify the generated Excel workbook's Invoice
//      (cover) sheet carries the edited values at the reference cells;
//   4. approve the package, create the next month's package through the UI,
//      and verify carry-forward seeding shows up in the editor (Previous =
//      prior Total Invoiced, Current reset to 0).
//
// Runs against the live web + API artifacts and the shared development
// database (all created records are cleaned up afterwards).

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const COVER = {
  supplierId: `SUP-${uniq}`,
  clientProjectNo: `CPN-${uniq}`,
  sendToCompany: `E2E Transit District ${uniq}`,
  contactPerson: `Casey Cover ${uniq}`,
  sendToAddress1: `300 Cover St ${uniq}`,
  sendToAddress2: `Oakland, CA 946${uniq.slice(-2)}`,
  bartProjectNumbers: `15NL${uniq.slice(-4)}`,
  terms: `Net 45 Days ${uniq.slice(-4)}`,
};

const ITEM = {
  workScopeNo: `B.50-${uniq.slice(-4)}`,
  poNo: `PO-${uniq.slice(-6)}`,
  lineNo: "3",
  bartProjectNo: `15NL004/PJ${uniq.slice(-3)}`,
  poAmount: 50000,
  previousInvoiced: 5000,
  currentInvoiced: 2500,
};

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

// Work-plan dialog labels are not programmatically associated with their
// inputs, so locate each input as the sibling that follows its label text.
function coverInput(dialog: Locator, label: string): Locator {
  return dialog
    .locator("label")
    .filter({ hasText: label })
    .locator("xpath=following-sibling::input[1]");
}

test("billing editor + cover fields flow: edit → save → export → carry-forward", async ({
  page,
  baseURL,
}) => {
  // Export builds an Excel workbook and a merged PDF — give it room.
  test.setTimeout(300_000);

  await signIn(page);
  const token = await apiToken(page);
  const api = (path_: string) => `${baseURL}/api${path_}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const code = `E2E-BLI-${uniq}`;
  let workPlanId: number | null = null;
  let packageId: number | null = null;
  let nextPackageId: number | null = null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bli-"));

  try {
    // --- Seed: work plan + June package with one timesheet entry -----------
    const wpRes = await page.request.post(api("/work-plans"), {
      headers,
      data: {
        code,
        title: "E2E Billed Line Items Plan",
        client: "E2E Client",
        jobNumber: `E2E-JOB-BLI-${uniq}`,
        totalBudget: 1_000_000,
        billingCycle: "whole_month",
      },
    });
    expect(wpRes.status(), await wpRes.text()).toBe(201);
    workPlanId = ((await wpRes.json()) as { id: number }).id;

    const pkgRes = await page.request.post(api("/packages"), {
      headers,
      data: {
        workPlanId,
        payPeriodStart: "2026-06-01",
        payPeriodEnd: "2026-06-30",
        invoiceNumber: `E2E-BLI-${uniq}`,
        invoiceDate: "2026-07-02",
      },
    });
    expect(pkgRes.status(), await pkgRes.text()).toBe(201);
    packageId = ((await pkgRes.json()) as { id: number }).id;

    const weekRes = await page.request.post(api(`/packages/${packageId}/weeks`), {
      headers,
      data: { label: "Week 1", weekStart: "2026-06-01", weekEnd: "2026-06-07" },
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

    // --- 1. Edit the 8 invoice-cover fields in the work-plan dialog --------
    await page.goto("/work-plans");
    const planRow = page.getByRole("row").filter({ hasText: code });
    await expect(planRow).toBeVisible();
    await planRow.getByRole("button").first().click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Edit Work Plan");
    await coverInput(dialog, "Supplier ID").fill(COVER.supplierId);
    await coverInput(dialog, "Client Project No").fill(COVER.clientProjectNo);
    await coverInput(dialog, "Send To — Company").fill(COVER.sendToCompany);
    await coverInput(dialog, "Contact Person").fill(COVER.contactPerson);
    await coverInput(dialog, "Send To — Address Line 1").fill(COVER.sendToAddress1);
    await coverInput(dialog, "Send To — Address Line 2").fill(COVER.sendToAddress2);
    await coverInput(dialog, "BART Project Numbers").fill(COVER.bartProjectNumbers);
    await coverInput(dialog, "Payment Terms").fill(COVER.terms);

    const wpSave = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/work-plans/${workPlanId}`) &&
        ["PATCH", "PUT"].includes(res.request().method()),
    );
    await dialog.getByRole("button", { name: /^save$/i }).click();
    expect((await wpSave).status(), "work plan save").toBeLessThan(300);
    await expect(dialog).toBeHidden();

    // Persisted? Reopen the dialog and spot-check two fields.
    await planRow.getByRole("button").first().click();
    await expect(coverInput(page.getByRole("dialog"), "Supplier ID")).toHaveValue(
      COVER.supplierId,
    );
    await expect(
      coverInput(page.getByRole("dialog"), "Payment Terms"),
    ).toHaveValue(COVER.terms);
    await page.keyboard.press("Escape");

    // --- 2. Add + edit a billed line item in the editor card ---------------
    await page.goto(`/packages/${packageId}`);
    await page.getByRole("tab", { name: /invoice/i }).first().click();
    await expect(page.getByText("Billed Line Items")).toBeVisible();

    await page.getByTestId("button-add-line-item").click();
    const row = page.getByTestId("row-line-item-0");
    const inputs = row.locator("input");
    await inputs.nth(0).fill(ITEM.workScopeNo);
    await inputs.nth(1).fill(ITEM.poNo);
    await inputs.nth(2).fill(ITEM.lineNo);
    await inputs.nth(3).fill(ITEM.bartProjectNo);
    await inputs.nth(4).fill(String(ITEM.poAmount));
    await inputs.nth(5).fill(String(ITEM.previousInvoiced));
    await inputs.nth(6).fill(String(ITEM.currentInvoiced));

    // The derived Total and Remaining columns update live.
    await expect(row).toContainText("$7,500.00"); // 5,000 + 2,500
    await expect(row).toContainText("$42,500.00"); // 50,000 − 7,500

    const putItems = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/packages/${packageId}/billed-line-items`) &&
        res.request().method() === "PUT",
    );
    await page.getByTestId("button-save-line-items").click();
    expect((await putItems).status(), "billed line items save").toBe(200);
    await expect(
      page.getByRole("listitem").filter({ hasText: /billed line items saved/i }),
    ).toBeVisible();

    // Values survive a reload (saved, not just local state).
    await page.reload();
    await page.getByRole("tab", { name: /invoice/i }).first().click();
    await expect(page.getByTestId("input-work-scope-0")).toHaveValue(ITEM.workScopeNo);
    await expect(page.getByTestId("input-current-invoiced-0")).toHaveValue(
      String(ITEM.currentInvoiced),
    );

    // --- 3. Export via the UI and inspect the generated workbook -----------
    // The export handler window.opens the download URL; suppress the popup.
    await page.evaluate(() => {
      window.open = () => null;
    });
    const exportResPromise = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/packages/${packageId}/export`) &&
        res.request().method() === "POST",
      { timeout: 180_000 },
    );
    await page.getByRole("button", { name: /export package/i }).click();
    const exportRes = await exportResPromise;
    expect(exportRes.status(), await exportRes.text()).toBe(200);
    const exported = (await exportRes.json()) as { url: string };

    const zipRes = await page.request.get(`${baseURL}${exported.url}`, { headers });
    expect(zipRes.status(), "zip download").toBe(200);
    const zipPath = path.join(tmpDir, "export.zip");
    fs.writeFileSync(zipPath, await zipRes.body());
    execSync(`unzip -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(tmpDir)}`);
    const xlsxName = fs.readdirSync(tmpDir).find((f) => f.endsWith(".xlsx"));
    expect(xlsxName, "exported workbook present in ZIP").toBeTruthy();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(tmpDir, xlsxName!));
    const cover = wb.getWorksheet("Invoice");
    expect(cover, "Invoice (cover) sheet present").toBeTruthy();

    // Cover header fields (work-plan form values).
    expect(cover!.getCell("U10").value).toBe(COVER.supplierId);
    expect(cover!.getCell("U12").value).toBe(COVER.clientProjectNo);
    expect(cover!.getCell("H10").value).toBe(COVER.sendToCompany);
    expect(cover!.getCell("H11").value).toBe(COVER.sendToAddress1);
    expect(cover!.getCell("H12").value).toBe(COVER.sendToAddress2);
    expect(cover!.getCell("H13").value).toBe(COVER.contactPerson);
    expect(cover!.getCell("R17").value).toBe(COVER.bartProjectNumbers);
    expect(cover!.getCell("T18").value).toBe(COVER.terms);

    // Billed Line Items table (first line row, 25).
    expect(cover!.getCell("C25").value).toBe(ITEM.workScopeNo);
    expect(cover!.getCell("E25").value).toBe(ITEM.poNo);
    expect(cover!.getCell("G25").value).toBe(Number(ITEM.lineNo));
    expect(cover!.getCell("H25").value).toBe(ITEM.bartProjectNo);
    expect(cover!.getCell("J25").value).toBe(ITEM.poAmount);
    expect(cover!.getCell("M25").value).toBe(ITEM.previousInvoiced);
    expect(cover!.getCell("P25").value).toBe(ITEM.currentInvoiced);

    // --- 4. Carry-forward seeding on new-package creation (in the UI) ------
    const approveRes = await page.request.patch(api(`/packages/${packageId}`), {
      headers,
      data: { status: "approved" },
    });
    expect(approveRes.status(), await approveRes.text()).toBe(200);

    await page.goto("/");
    await page.getByRole("button", { name: /new package/i }).first().click();
    const createDialog = page.getByRole("dialog");
    await expect(createDialog).toContainText("Create Package");

    // Second combobox is the Work Plan select (first is the optional employee).
    await createDialog.getByRole("combobox").nth(1).click();
    await page.getByRole("option", { name: new RegExp(code) }).click();
    const dateInputs = createDialog.locator('input[type="date"]');
    await dateInputs.nth(0).fill("2026-07-01");
    await dateInputs.nth(1).fill("2026-07-31");

    const createRes = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/packages") && res.request().method() === "POST",
    );
    await createDialog.getByRole("button", { name: /create package/i }).click();
    const created = await createRes;
    expect(created.status(), await created.text()).toBe(201);
    nextPackageId = ((await created.json()) as { id: number }).id;

    // The dashboard navigates straight into the new package workspace.
    await page.waitForURL(`**/packages/${nextPackageId}`);
    await page.getByRole("tab", { name: /invoice/i }).first().click();

    const carriedRow = page.getByTestId("row-line-item-0");
    const carried = carriedRow.locator("input");
    await expect(carried.nth(0)).toHaveValue(ITEM.workScopeNo);
    await expect(carried.nth(1)).toHaveValue(ITEM.poNo);
    await expect(carried.nth(4)).toHaveValue(String(ITEM.poAmount));
    // Previous = prior Total Invoiced (5,000 + 2,500); Current resets to 0.
    await expect(carried.nth(5)).toHaveValue("7500");
    await expect(carried.nth(6)).toHaveValue("0");
  } finally {
    // --- Clean up the shared development database ---------------------------
    const pkgIds = [packageId, nextPackageId].filter((v): v is number => v != null);
    for (const id of pkgIds) {
      await page.request.delete(api(`/packages/${id}`), { headers });
    }
    if (pkgIds.length > 0) {
      await db
        .delete(auditLogsTable)
        .where(
          and(
            eq(auditLogsTable.entityType, "package"),
            inArray(auditLogsTable.entityId, pkgIds),
          ),
        );
    }
    if (workPlanId != null) {
      await page.request.delete(api(`/work-plans/${workPlanId}`), { headers });
      await db
        .delete(auditLogsTable)
        .where(
          and(
            eq(auditLogsTable.entityType, "workPlan"),
            eq(auditLogsTable.entityId, workPlanId),
          ),
        );
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
