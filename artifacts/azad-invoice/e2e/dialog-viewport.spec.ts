import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";
import { TEST_USER_EMAIL } from "./test-user";

// Verifies the tall Edit Work Plan and Create Package dialogs stay usable
// (submit buttons reachable) on a standard 1280x720 laptop viewport.

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

test("work-plan and create-package dialogs fit a 1280x720 viewport", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await signIn(page);

  // Create Package dialog (dashboard).
  await page.getByRole("button", { name: /new package/i }).click();
  const pkgDialog = page.getByRole("dialog");
  await expect(pkgDialog).toBeVisible();
  const createBtn = pkgDialog.getByRole("button", { name: /create/i }).last();
  await createBtn.scrollIntoViewIfNeeded();
  const createBox = await createBtn.boundingBox();
  expect(createBox).not.toBeNull();
  expect(createBox!.y + createBox!.height).toBeLessThanOrEqual(720);
  await page.keyboard.press("Escape");
  await expect(pkgDialog).toBeHidden();

  // Work Plan dialog.
  await page.getByRole("link", { name: /work plans/i }).first().click();
  await page.getByRole("button", { name: /add work plan/i }).click();
  const wpDialog = page.getByRole("dialog");
  await expect(wpDialog).toBeVisible();
  const dialogBox = await wpDialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(dialogBox!.height).toBeLessThanOrEqual(720 * 0.9 + 1);
  const saveBtn = wpDialog
    .getByRole("button", { name: /create|save/i })
    .last();
  await saveBtn.scrollIntoViewIfNeeded();
  const saveBox = await saveBtn.boundingBox();
  expect(saveBox).not.toBeNull();
  expect(saveBox!.y + saveBox!.height).toBeLessThanOrEqual(720);
  await page.keyboard.press("Escape");
});
