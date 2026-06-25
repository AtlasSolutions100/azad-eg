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
