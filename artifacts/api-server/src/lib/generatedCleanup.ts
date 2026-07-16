import fs from "node:fs";
import path from "node:path";
import { generatedDir } from "./paths";
import { logger } from "./logger";

/**
 * Retention policy for `storage/generated`:
 * - Package export ZIPs (`Package_<slug>_<ts>.zip`): keep the newest
 *   ZIPS_KEPT_PER_PACKAGE per package slug; older ones are deleted.
 * - Everything else (single-document xlsx/pdf downloads, stray intermediate
 *   InvoicePackage_* files, legacy per-document files from the old 8-file
 *   export format): deleted once older than MAX_LOOSE_FILE_AGE_MS. The age
 *   grace period keeps freshly generated single-document download links
 *   working while still bounding disk growth.
 */
export const ZIPS_KEPT_PER_PACKAGE = 3;
export const MAX_LOOSE_FILE_AGE_MS = 24 * 60 * 60 * 1000;

const ZIP_PATTERN = /^Package_(.+)_(\d+)\.zip$/;

export interface PruneResult {
  deletedZips: number;
  deletedLooseFiles: number;
}

/**
 * Prunes old generated export files. Best-effort: failures on individual
 * files are logged and skipped so a locked/missing file never breaks an
 * export or server startup.
 */
export function pruneGeneratedFiles(now: number = Date.now()): PruneResult {
  const result: PruneResult = { deletedZips: 0, deletedLooseFiles: 0 };
  if (!fs.existsSync(generatedDir)) return result;

  let names: string[];
  try {
    names = fs.readdirSync(generatedDir);
  } catch (err) {
    logger.warn({ err }, "Could not read generated directory for pruning");
    return result;
  }

  const zipsBySlug = new Map<string, { name: string; ts: number }[]>();

  for (const name of names) {
    const zipMatch = ZIP_PATTERN.exec(name);
    if (zipMatch) {
      const slug = zipMatch[1] as string;
      const ts = Number(zipMatch[2]);
      const list = zipsBySlug.get(slug) ?? [];
      list.push({ name, ts });
      zipsBySlug.set(slug, list);
      continue;
    }

    // Loose file (single-doc download, intermediate, or legacy artifact):
    // delete once past the grace period, judged by filesystem mtime so files
    // without a timestamp suffix are still covered.
    const full = path.resolve(generatedDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > MAX_LOOSE_FILE_AGE_MS) {
        fs.rmSync(full, { force: true });
        result.deletedLooseFiles += 1;
      }
    } catch (err) {
      logger.warn({ err, file: name }, "Failed to prune generated file");
    }
  }

  for (const list of zipsBySlug.values()) {
    // Newest first; keep the first N.
    list.sort((a, b) => b.ts - a.ts);
    for (const stale of list.slice(ZIPS_KEPT_PER_PACKAGE)) {
      try {
        fs.rmSync(path.resolve(generatedDir, stale.name), { force: true });
        result.deletedZips += 1;
      } catch (err) {
        logger.warn({ err, file: stale.name }, "Failed to prune old export ZIP");
      }
    }
  }

  if (result.deletedZips > 0 || result.deletedLooseFiles > 0) {
    logger.info(result, "Pruned old generated export files");
  }
  return result;
}
