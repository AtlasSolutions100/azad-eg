import path from "node:path";
import fs from "node:fs";

export const workspaceRoot = process.cwd().endsWith(path.join("artifacts", "api-server"))
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();

export const apiServerRoot = path.resolve(workspaceRoot, "artifacts/api-server");
export const uploadsDir = path.resolve(apiServerRoot, "storage/uploads");
export const generatedDir = path.resolve(apiServerRoot, "storage/generated");
export const templatesDir = path.resolve(apiServerRoot, "templates");

export function ensureDirs(): void {
  for (const dir of [uploadsDir, generatedDir, templatesDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Deletes a previously stored upload given its public URL
 * (e.g. "/api/files/progress_1_123.xlsx" -> uploadsDir/progress_1_123.xlsx).
 * No-ops when the URL is empty, points outside uploadsDir, or the file is gone,
 * so callers can use it freely on replace/remove/cascade-delete flows.
 */
export function deleteUploadedFile(fileUrl: string | null | undefined): void {
  if (!fileUrl) return;
  const filename = path.basename(decodeURIComponent(fileUrl));
  if (!filename) return;
  const abs = path.resolve(uploadsDir, filename);
  if (abs.startsWith(uploadsDir + path.sep) && fs.existsSync(abs)) {
    fs.rmSync(abs, { force: true });
  }
}
