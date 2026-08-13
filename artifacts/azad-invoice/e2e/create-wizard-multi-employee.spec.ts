import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the create-package wizard:
//  - step order (Owner → Prime → Work Plan → Pay Period & Details)
//  - auto-detected employee list when a work plan is picked
//  - the multi-employee confirmation gate ("N employees are associated with
//    this work plan — continue?") blocking Next until acknowledged
//  - single-employee work plans skipping the gate entirely
//  - the manual Procas-job fallback running the same detection + gate
//
// A live Procas connection is not available in dev, so the browser's calls to
// GET /api/procas/work-plan-employees are intercepted with page.route and
// answered with deterministic fixtures keyed off the requested project code.

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MULTI_PROJECT = `E2EMULTI${uniq}`;
const SINGLE_PROJECT = `E2ESINGLE${uniq}`;
const MANUAL_PROJECT = `E2EMANUAL${uniq}`;

const MULTI_EMPLOYEES = [
  { employeeId: null, name: "Alice Multi", hours: 120.5 },
  { employeeId: null, name: "Bob Multi", hours: 88 },
  { employeeId: null, name: "Carol Multi", hours: 40.25 },
];
const SINGLE_EMPLOYEE = [{ employeeId: null, name: "Solo Worker", hours: 152 }];
const MANUAL_EMPLOYEES = [
  { employeeId: null, name: "Manny One", hours: 60 },
  { employeeId: null, name: "Manny Two", hours: 30 },
];

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

// Routes the work-plan-employees endpoint to fixtures keyed by project code.
async function mockWorkPlanEmployees(page: Page): Promise<void> {
  await page.route("**/api/procas/work-plan-employees*", async (route) => {
    const url = new URL(route.request().url());
    const project = url.searchParams.get("project") ?? "";
    const body = project.startsWith(MULTI_PROJECT)
      ? MULTI_EMPLOYEES
      : project.startsWith(SINGLE_PROJECT)
        ? SINGLE_EMPLOYEE
        : project.startsWith(MANUAL_PROJECT)
          ? MANUAL_EMPLOYEES
          : [];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("create wizard: step order, auto-detected employees, multi-employee gate, manual fallback", async ({
  page,
  baseURL,
}) => {
  // Tall Radix dialog: enlarge the viewport so nothing sits off-screen.
  await page.setViewportSize({ width: 1400, height: 2200 });

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

  // --- Seed two work plans with Procas charge codes through the API ------
  const token = await apiToken(page);
  const api = (path: string) => `${baseURL}/api${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const createWorkPlan = async (code: string, title: string, procasProject: string) => {
    const res = await page.request.post(api("/work-plans"), {
      headers,
      data: {
        code,
        title,
        client: "E2E Client",
        jobNumber: "E2E-JOB",
        totalBudget: 100000,
        billingCycle: "whole_month",
        procasProject,
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()) as { id: number };
  };

  const multiPlan = await createWorkPlan(
    `E2E-WIZ-MULTI-${uniq}`,
    "E2E Wizard Multi-Employee Plan",
    MULTI_PROJECT,
  );
  const singlePlan = await createWorkPlan(
    `E2E-WIZ-SINGLE-${uniq}`,
    "E2E Wizard Single-Employee Plan",
    SINGLE_PROJECT,
  );

  await mockWorkPlanEmployees(page);

  // The dashboard fetched its work-plan list before the seeds existed;
  // reload so the wizard's select can see them.
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /new package/i }),
  ).toBeVisible({ timeout: 20_000 });

  const dialog = page.getByRole("dialog", { name: /create package/i });
  const nextButton = dialog.getByRole("button", { name: /^next$/i });

  const openWizard = async () => {
    await page.getByRole("button", { name: /new package/i }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Step 1 of 4 — Owner");
  };
  const closeWizard = async () => {
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  };
  const advanceToWorkPlanStep = async () => {
    // Step 1: Owner → Step 2: Prime → Step 3: Work Plan.
    await dialog.getByPlaceholder(/project owner/i).fill("E2E Owner");
    await nextButton.click();
    await expect(dialog).toContainText("Step 2 of 4 — Prime");
    await dialog.getByPlaceholder(/prime contractor/i).fill("E2E Prime");
    await nextButton.click();
    await expect(dialog).toContainText("Step 3 of 4 — Work Plan");
    // No work plan / job picked yet — Next must be disabled.
    await expect(nextButton).toBeDisabled();
  };
  const pickWorkPlan = async (code: string) => {
    await dialog.getByRole("combobox").first().click();
    await page.getByRole("option", { name: new RegExp(code, "i") }).click();
  };

  try {
    // ===== Scenario 1: multi-employee work plan gates step 4 ==============
    await openWizard();
    await advanceToWorkPlanStep();
    await pickWorkPlan(`E2E-WIZ-MULTI-${uniq}`);

    // Auto-detected employee list, with hours, sorted by the fixture.
    await expect(dialog).toContainText(
      "Employees charged to this work plan (from Procas)",
    );
    for (const emp of MULTI_EMPLOYEES) {
      await expect(dialog).toContainText(emp.name);
    }

    // The multi-employee confirmation gate blocks Next.
    await expect(dialog).toContainText(
      "3 employees are associated with this work plan — continue?",
    );
    await expect(nextButton).toBeDisabled();

    // Acknowledge → gate lifts, Next proceeds to step 4.
    await dialog
      .getByRole("button", { name: /yes, continue with 3 employees/i })
      .click();
    await expect(dialog).toContainText(
      "Confirmed — all 3 employees will be included",
    );
    await expect(nextButton).toBeEnabled();
    await nextButton.click();
    await expect(dialog).toContainText("Step 4 of 4 — Pay Period & Details");
    await expect(dialog.getByText("Pay Period Start")).toBeVisible();
    await closeWizard();

    // ===== Scenario 2: single-employee work plan skips the gate ===========
    await openWizard();
    await advanceToWorkPlanStep();
    await pickWorkPlan(`E2E-WIZ-SINGLE-${uniq}`);

    await expect(dialog).toContainText("Solo Worker");
    // No confirmation gate for a single detected employee.
    await expect(dialog).not.toContainText(/employees are associated with this work plan/i);
    await expect(nextButton).toBeEnabled();
    await nextButton.click();
    await expect(dialog).toContainText("Step 4 of 4 — Pay Period & Details");
    await closeWizard();

    // ===== Scenario 3: manual Procas-job fallback runs the same gate ======
    await openWizard();
    await advanceToWorkPlanStep();
    await dialog
      .getByRole("button", { name: /work plan not in procas yet/i })
      .click();
    // Without a live Procas connection the fallback renders a free-text
    // job-number input; blurring it triggers the same detection.
    const jobInput = dialog.getByPlaceholder("e.g. 22-1234");
    await expect(jobInput).toBeVisible();
    await jobInput.fill(MANUAL_PROJECT);
    await jobInput.blur();

    await expect(dialog).toContainText("Manny One");
    await expect(dialog).toContainText("Manny Two");
    await expect(dialog).toContainText(
      "2 employees are associated with this work plan — continue?",
    );
    await expect(nextButton).toBeDisabled();
    await dialog
      .getByRole("button", { name: /yes, continue with 2 employees/i })
      .click();
    await expect(nextButton).toBeEnabled();
    await nextButton.click();
    await expect(dialog).toContainText("Step 4 of 4 — Pay Period & Details");
    await closeWizard();
  } finally {
    // --- Clean up the shared development database -------------------------
    await page.request.delete(api(`/work-plans/${multiPlan.id}`), { headers });
    await page.request.delete(api(`/work-plans/${singlePlan.id}`), { headers });
  }
});
