import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for spotting and fixing unlinked line items: a row with
// no linked employee must be visually flagged in the Line Items tab, and the
// biller must be able to link the right employee inline, which fills in that
// employee's rate/classification defaults where the row is missing them.

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EMP_NAME = `E2E Linkable ${uniq}`;

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

test("unlinked row is flagged and can be linked inline with defaults applied", async ({
  page,
  baseURL,
}) => {
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

  // --- Seed employee, work plan, invoice, and an unlinked line item -------
  const empRes = await page.request.post(api("/employees"), {
    headers,
    data: {
      name: EMP_NAME,
      classification: "Senior Engineer",
      homeRate: 150,
      fieldRate: 175,
      defaultTaskNo: "T-100",
    },
  });
  expect(empRes.status(), await empRes.text()).toBe(201);
  const employee = (await empRes.json()) as { id: number };

  const wpRes = await page.request.post(api("/work-plans"), {
    headers,
    data: {
      code: `E2E-WP-${uniq}`,
      title: "E2E Unlinked Row Plan",
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
    // An unlinked row like the importer leaves behind: no employeeId, no
    // usable rate, "Unspecified" classification.
    const liRes = await page.request.post(api(`/invoices/${invoice.id}/line-items`), {
      headers,
      data: {
        employeeName: EMP_NAME,
        classification: "Unspecified",
        category: "regular",
        location: "home",
        hours: 8,
        rate: 0,
      },
    });
    expect(liRes.status(), await liRes.text()).toBe(201);
    const lineItem = (await liRes.json()) as { id: number };

    // --- The row must be visibly flagged ---------------------------------
    await page.goto(`/invoices/${invoice.id}`);
    await page.getByRole("tab", { name: /line items/i }).click();

    await expect(page.getByTestId("alert-unlinked-rows")).toBeVisible();
    await expect(page.getByTestId(`badge-unlinked-${lineItem.id}`)).toBeVisible();

    // --- Link the employee inline -----------------------------------------
    const patchDone = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/line-items/${lineItem.id}`) &&
        res.request().method() === "PATCH",
    );
    await page.getByTestId(`select-link-employee-${lineItem.id}`).click();
    await page
      .getByRole("option", { name: new RegExp(EMP_NAME) })
      .click();
    const patchResponse = await patchDone;
    expect(patchResponse.status(), await patchResponse.text()).toBe(200);

    // --- Flag disappears; defaults applied ---------------------------------
    await expect(page.getByTestId(`badge-unlinked-${lineItem.id}`)).toHaveCount(0);
    await expect(page.getByTestId("alert-unlinked-rows")).toHaveCount(0);
    const row = page.getByTestId(`row-line-item-${lineItem.id}`);
    await expect(row).toContainText("Senior Engineer"); // classification default
    await expect(row).toContainText("150.00"); // home rate default
    await expect(row).toContainText("T-100"); // default task number

    // The PATCH must have persisted the link server-side.
    const check = await page.request.get(api(`/invoices/${invoice.id}/line-items`), {
      headers,
    });
    const items = (await check.json()) as Array<{ id: number; employeeId: number | null }>;
    expect(items.find((i) => i.id === lineItem.id)?.employeeId).toBe(employee.id);
  } finally {
    await page.request.delete(api(`/invoices/${invoice.id}`), { headers });
    await page.request.delete(api(`/work-plans/${workPlan.id}`), { headers });
    await page.request.delete(api(`/employees/${employee.id}`), { headers });
  }
});
