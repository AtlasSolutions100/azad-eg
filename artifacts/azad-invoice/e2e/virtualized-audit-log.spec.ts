import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { db, auditLogsTable } from "@workspace/db";
import { like } from "drizzle-orm";
import { TEST_USER_EMAIL } from "./test-user";

// End-to-end coverage for audit-log virtualization: with thousands of
// entries loaded via infinite scroll, only the rows near the viewport are
// actually rendered (bounded DOM size), while scrolling, filtering and the
// "Load older entries" fallback keep working.
//
// Runs against the live web + API artifacts and the shared development
// database (all seeded records are cleaned up afterwards).

const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const MARKER = `E2E-VIRT-${uniq}`;
const SEED_COUNT = 1200; // 6 pages at the 200-entry page size
const PAGE_SIZE = 200;
// A hard ceiling on rendered rows: header + overscan window. Without
// virtualization, all loaded rows (1200+) render, so this is a strong signal.
const MAX_RENDERED_ROWS = 120;

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

test.describe("audit log stays fast with thousands of loaded entries", () => {
  test.beforeAll(async () => {
    const now = Date.now();
    const rows = Array.from({ length: SEED_COUNT }, (_, i) => ({
      userName: `E2E Virt User`,
      action: "e2e virtualization test",
      entityType: "invoice",
      entityId: 999_000_000,
      description: `${MARKER} entry ${i}`,
      createdAt: new Date(now - i * 1000),
    }));
    // Insert in chunks to stay under parameter limits.
    for (let i = 0; i < rows.length; i += 300) {
      await db.insert(auditLogsTable).values(rows.slice(i, i + 300));
    }
  });

  test.afterAll(async () => {
    await db
      .delete(auditLogsTable)
      .where(like(auditLogsTable.description, `${MARKER}%`));
  });

  test("global audit log virtualizes rows while infinite scroll loads pages", async ({ page }) => {
    await signIn(page);

    await page.goto("/audit-log");
    const bodyRows = page.locator("table tbody tr");
    await expect(bodyRows.first()).toBeVisible({ timeout: 20_000 });

    // Scroll to the bottom repeatedly until all seeded pages are loaded
    // (the "Load older entries" button disappears when exhausted) or we hit
    // enough pages to prove the point.
    const loadMore = page.getByTestId("button-load-more-audit");
    let loadedPages = 1;
    for (let i = 0; i < 30 && (await loadMore.isVisible().catch(() => false)); i++) {
      await page.keyboard.press("End");
      await page.mouse.wheel(0, 100_000);
      const before = loadedPages;
      await page
        .waitForResponse(
          (res) => res.url().includes("/api/audit-logs") && res.ok(),
          { timeout: 10_000 },
        )
        .catch(() => undefined);
      loadedPages = before + 1;
      await page.waitForTimeout(250);
      if (loadedPages * PAGE_SIZE > SEED_COUNT + PAGE_SIZE) break;
    }

    // Enough entries are loaded that, unvirtualized, the DOM would hold
    // 1000+ rows — but the rendered row count stays bounded.
    const filterNote = page.getByText(/Showing \d+ of \d+ entries/);
    const renderedAfterScroll = await bodyRows.count();
    expect(renderedAfterScroll).toBeLessThan(MAX_RENDERED_ROWS);

    // Search filtering stays functional over everything loaded: filter to the
    // seeded marker and confirm the summary counts far more matches than the
    // number of rendered rows.
    await page.getByTestId("input-audit-search").fill(MARKER.toLowerCase());
    await expect(filterNote).toBeVisible();
    const noteText = (await filterNote.textContent()) ?? "";
    const match = noteText.match(/Showing (\d+) of (\d+) entries/);
    expect(match).not.toBeNull();
    const shown = Number(match![1]);
    expect(shown).toBeGreaterThan(MAX_RENDERED_ROWS); // many matches loaded…
    const renderedFiltered = await bodyRows.count();
    expect(renderedFiltered).toBeLessThan(MAX_RENDERED_ROWS); // …few rendered

    // Rows render real content (top of the filtered list).
    await expect(bodyRows.filter({ hasText: MARKER }).first()).toBeVisible();

    // Scrolling back to the top still shows the newest seeded entry.
    await page.keyboard.press("Home");
    await page.mouse.wheel(0, -1_000_000);
    await expect(
      bodyRows.filter({ hasText: `${MARKER} entry 0` }).first(),
    ).toBeVisible();
  });

  test("invoice Activity tab virtualizes rows too", async ({ page, baseURL }) => {
    await signIn(page);
    const token = await page.evaluate(async () => {
      const clerkGlobal = (window as unknown as {
        Clerk?: { session?: { getToken: () => Promise<string | null> } };
      }).Clerk;
      return (await clerkGlobal?.session?.getToken()) ?? null;
    });
    expect(token).not.toBeNull();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const api = (path: string) => `${baseURL}/api${path}`;

    // Seed a real invoice, then point a batch of audit entries at it so the
    // Activity tab has multiple pages of history.
    let workPlanId: number | null = null;
    let invoiceId: number | null = null;
    try {
      const wpRes = await page.request.post(api("/work-plans"), {
        headers,
        data: {
          code: `E2E-VIRT-WP-${uniq}`,
          title: "E2E Virtualization Plan",
          client: "E2E Client",
          jobNumber: "E2E-JOB-VIRT",
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
          invoiceNumber: `E2E-VIRT-INV-${uniq}`,
          invoiceDate: "2026-07-15",
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
        },
      });
      expect(invRes.status(), await invRes.text()).toBe(201);
      invoiceId = ((await invRes.json()) as { id: number }).id;

      const now = Date.now();
      const rows = Array.from({ length: 600 }, (_, i) => ({
        userName: "E2E Virt User",
        action: "e2e activity virtualization",
        entityType: "invoice",
        entityId: invoiceId!,
        description: `${MARKER} activity ${i}`,
        createdAt: new Date(now - i * 1000),
      }));
      for (let i = 0; i < rows.length; i += 300) {
        await db.insert(auditLogsTable).values(rows.slice(i, i + 300));
      }

      await page.goto(`/invoices/${invoiceId}`);
      await page.getByRole("tab", { name: /activity/i }).click();

      const activityRows = page
        .locator('[role="tabpanel"][data-state="active"] table tbody tr');
      await expect(activityRows.first()).toBeVisible({ timeout: 20_000 });

      // Load the remaining pages via the fallback button.
      const loadMore = page.getByTestId("button-load-more-activity");
      for (let i = 0; i < 5 && (await loadMore.isVisible().catch(() => false)); i++) {
        await loadMore.scrollIntoViewIfNeeded();
        await page
          .waitForResponse(
            (res) => res.url().includes("/api/audit-logs") && res.ok(),
            { timeout: 10_000 },
          )
          .catch(() => undefined);
        await page.waitForTimeout(250);
      }

      // 600+ entries loaded, but the DOM stays bounded.
      const rendered = await activityRows.count();
      expect(rendered).toBeLessThan(MAX_RENDERED_ROWS);
      await expect(
        activityRows.filter({ hasText: `${MARKER} activity` }).first(),
      ).toBeVisible();
    } finally {
      if (invoiceId != null) {
        await page.request.delete(api(`/invoices/${invoiceId}`), { headers });
      }
      if (workPlanId != null) {
        await page.request.delete(api(`/work-plans/${workPlanId}`), { headers });
      }
    }
  });
});
