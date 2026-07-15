import { clerkSetup } from "@clerk/testing/playwright";
import { TEST_USER_EMAIL } from "./test-user";

// Obtains a Clerk testing token (so bot detection is bypassed) and makes sure
// the e2e test user exists in the Clerk instance. Uses the same
// CLERK_SECRET_KEY / CLERK_PUBLISHABLE_KEY env vars as the API server.
export default async function globalSetup(): Promise<void> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ?? process.env.VITE_CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) {
    throw new Error(
      "CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY must be set to run the e2e tests.",
    );
  }

  await clerkSetup({ publishableKey, secretKey });

  const res = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [TEST_USER_EMAIL],
      first_name: "E2E",
      last_name: "Uploader",
      skip_password_requirement: true,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      errors?: Array<{ code?: string }>;
    } | null;
    const alreadyExists = body?.errors?.some(
      (e) => e.code === "form_identifier_exists",
    );
    if (!alreadyExists) {
      throw new Error(
        `Failed to create Clerk e2e test user (${res.status}): ${JSON.stringify(body)}`,
      );
    }
  }
}
