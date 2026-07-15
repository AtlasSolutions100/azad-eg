import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { db, procasConnectionTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for the *failure* path of the live Procas sync: when
// the API rejects the sync (HTTP 4xx/502 with { error, warnings? } in the
// body), the browser must surface the API's specific reason in a destructive
// "Procas sync failed" toast — not a generic failure message.
//
// A live Procas connection cannot be established with fake credentials (the
// connect endpoint validates them against the real Procas API), so the test
// seeds the persisted connection row directly with bogus credentials. The
// sync then fails server-side with a specific error message which must reach
// the toast verbatim. The original connection row is restored afterwards.

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CONNECTION_ID = 1;

type ConnectionRow = typeof procasConnectionTable.$inferSelect;

async function readRawConnection(): Promise<ConnectionRow | null> {
  const [row] = await db
    .select()
    .from(procasConnectionTable)
    .where(eq(procasConnectionTable.id, CONNECTION_ID));
  return row ?? null;
}

// Seeds a "connected" Procas row with credentials that the Procas API will
// reject. The password is written as plaintext, which the server tolerates
// as a legacy format (it re-seals it on first read).
async function seedBogusConnection(): Promise<void> {
  const values = {
    id: CONNECTION_ID,
    connected: true,
    companyCode: "E2E-BOGUS-COMPANY",
    username: "e2e-bogus-user",
    password: "e2e-bogus-password",
    lastSyncAt: null,
  };
  await db
    .insert(procasConnectionTable)
    .values(values)
    .onConflictDoUpdate({ target: procasConnectionTable.id, set: values });
}

// Restores the exact pre-test row (including its encrypted password, which is
// written back untouched), or removes the row if none existed before.
async function restoreConnection(original: ConnectionRow | null): Promise<void> {
  if (!original) {
    await db
      .delete(procasConnectionTable)
      .where(eq(procasConnectionTable.id, CONNECTION_ID));
    return;
  }
  await db
    .insert(procasConnectionTable)
    .values(original)
    .onConflictDoUpdate({ target: procasConnectionTable.id, set: original });
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

test("a rejected Procas sync shows the API's reason in the toast, not a generic failure", async ({
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
      code: `E2E-WP-SYNC-${uniq}`,
      title: "E2E Rejected Procas Sync Plan",
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
      invoiceNumber: `E2E-INV-SYNC-${uniq}`,
      invoiceDate: "2026-07-15",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    },
  });
  expect(invRes.status(), await invRes.text()).toBe(201);
  const invoice = (await invRes.json()) as { id: number };

  const originalConnection = await readRawConnection();
  try {
    // --- Force a failing sync: a "connected" row with bogus credentials ----
    await seedBogusConnection();

    await page.goto(`/invoices/${invoice.id}`);
    await page.getByRole("tab", { name: /import/i }).click();

    // The live-connection panel renders only when Procas reports connected.
    const syncButton = page.getByRole("button", { name: /sync from procas/i });
    await expect(syncButton).toBeVisible();

    const syncRequest = page.waitForResponse(
      (res) =>
        res.url().includes(`/api/invoices/${invoice.id}/procas-sync`) &&
        res.request().method() === "POST",
    );
    await syncButton.click();
    const syncResponse = await syncRequest;

    // The sync must fail with a JSON body carrying the specific reason.
    expect(syncResponse.status(), await syncResponse.text()).toBeGreaterThanOrEqual(400);
    const body = (await syncResponse.json()) as { error?: string };
    expect(typeof body.error).toBe("string");
    expect(body.error!.length).toBeGreaterThan(0);

    // The destructive toast must show the API's error body verbatim — not
    // the generic ApiError message (which is prefixed with "HTTP <status>")
    // and not the hardcoded fallback text.
    const toast = page
      .getByRole("status")
      .filter({ hasText: /procas sync failed/i });
    await expect(toast.first()).toBeVisible();
    await expect(toast.first()).toContainText(body.error!);
    await expect(toast.first()).not.toContainText(/HTTP \d{3}/);
    await expect(toast.first()).not.toContainText(
      "Could not pull timesheets from Procas.",
    );
  } finally {
    // --- Clean up the shared development database -------------------------
    await restoreConnection(originalConnection);
    await page.request.delete(api(`/invoices/${invoice.id}`), { headers });
    await page.request.delete(api(`/work-plans/${workPlan.id}`), { headers });
  }
});
