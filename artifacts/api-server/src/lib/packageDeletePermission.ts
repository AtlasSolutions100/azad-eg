import { getAuth, clerkClient } from "@clerk/express";
import type { Request } from "express";

// Only these people may delete packages. Identity comes exclusively from the
// user's VERIFIED email addresses on their Clerk profile (fetched server-side)
// — never from display names or unverified claims, which a user can freely
// edit to impersonate someone. An allowlist entry is either an exact email
// ("julie@azadeng.com") or a bare local part ("julie"), which matches any
// verified email whose part before the @ equals it.
// Override via PACKAGE_DELETE_ALLOWLIST (comma-separated) without a code change.
const DEFAULT_ALLOWLIST = ["griselda", "mahsa", "julie"];

export function packageDeleteAllowlist(): string[] {
  const raw = process.env.PACKAGE_DELETE_ALLOWLIST;
  const list = (raw ? raw.split(",") : DEFAULT_ALLOWLIST)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWLIST;
}

/**
 * Whether the signed-in user is allowed to delete packages. Fetches the Clerk
 * user profile and checks only verified email addresses — a user cannot make
 * themselves eligible by renaming their profile, only by controlling one of
 * the allowlisted mailboxes.
 */
export async function canDeletePackages(req: Request): Promise<boolean> {
  const auth = getAuth(req);
  const userId = (auth?.sessionClaims?.userId as string | undefined) || auth?.userId;
  if (!userId) return false;
  const allow = packageDeleteAllowlist();

  try {
    const user = await clerkClient.users.getUser(userId);
    const verifiedEmails = (user.emailAddresses ?? [])
      .filter((e) => e.verification?.status === "verified")
      .map((e) => e.emailAddress.trim().toLowerCase());
    return verifiedEmails.some(
      (email) => allow.includes(email) || allow.includes(email.split("@")[0]),
    );
  } catch {
    // Clerk unreachable — deny rather than fail open.
    return false;
  }
}
