import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generatedDir, ensureDirs } from "./paths";
import {
  pruneGeneratedFiles,
  ZIPS_KEPT_PER_PACKAGE,
  MAX_LOOSE_FILE_AGE_MS,
} from "./generatedCleanup";

const created: string[] = [];

function touch(name: string, ageMs = 0): string {
  ensureDirs();
  const full = path.resolve(generatedDir, name);
  fs.writeFileSync(full, "x");
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(full, past, past);
  }
  created.push(full);
  return full;
}

afterEach(() => {
  for (const f of created.splice(0)) {
    fs.rmSync(f, { force: true });
  }
});

describe("pruneGeneratedFiles", () => {
  it("keeps only the newest N ZIPs per package slug", () => {
    const now = Date.now();
    const names: string[] = [];
    for (let i = 0; i < ZIPS_KEPT_PER_PACKAGE + 2; i++) {
      names.push(`Package_PRUNE-A_${now - i * 1000}.zip`);
    }
    const otherSlug = `Package_PRUNE-B_${now}.zip`;
    for (const n of names) touch(n);
    touch(otherSlug);

    const result = pruneGeneratedFiles(now);

    expect(result.deletedZips).toBeGreaterThanOrEqual(2);
    // Newest N survive, oldest two are gone.
    for (const n of names.slice(0, ZIPS_KEPT_PER_PACKAGE)) {
      expect(fs.existsSync(path.resolve(generatedDir, n))).toBe(true);
    }
    for (const n of names.slice(ZIPS_KEPT_PER_PACKAGE)) {
      expect(fs.existsSync(path.resolve(generatedDir, n))).toBe(false);
    }
    // Other package's single ZIP is untouched.
    expect(fs.existsSync(path.resolve(generatedDir, otherSlug))).toBe(true);
  });

  it("deletes loose files older than the grace period and keeps fresh ones", () => {
    const now = Date.now();
    const oldLegacy = touch(`Invoice_PRUNE-LEGACY_${now}.xlsx`, MAX_LOOSE_FILE_AGE_MS + 60_000);
    const oldNoTs = touch("PRUNE-legacy-no-timestamp.pdf", MAX_LOOSE_FILE_AGE_MS + 60_000);
    const freshDoc = touch(`Invoice_PRUNE-FRESH_${now}.xlsx`);

    pruneGeneratedFiles(now);

    expect(fs.existsSync(oldLegacy)).toBe(false);
    expect(fs.existsSync(oldNoTs)).toBe(false);
    expect(fs.existsSync(freshDoc)).toBe(true);
  });

  it("is a no-op on an empty or missing directory", () => {
    expect(() => pruneGeneratedFiles()).not.toThrow();
  });
});
