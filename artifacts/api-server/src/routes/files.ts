import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { generatedDir, uploadsDir } from "../lib/paths";

const router: IRouter = Router();

// Only these extensions are ever rendered inline; everything else is forced to
// download. This keeps untrusted uploads from executing in the app origin.
const INLINE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
};

router.get("/files/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const name = path.basename(decodeURIComponent(raw));
  // Optional friendly download name (e.g. EmployeeName_Job#_Invoice.xlsx). The
  // on-disk file keeps its unique name; this only sets the saved filename.
  const downloadRaw = req.query.download;
  const downloadName = typeof downloadRaw === "string" && downloadRaw.trim()
    ? path.basename(downloadRaw).replace(/"/g, "")
    : null;
  for (const dir of [generatedDir, uploadsDir]) {
    const full = path.resolve(dir, name);
    if (full.startsWith(path.resolve(dir)) && fs.existsSync(full)) {
      const ext = path.extname(name).toLowerCase();
      const contentType = INLINE_CONTENT_TYPES[ext];
      const dispositionName = downloadName ?? name;
      // Never sniff; never let an unknown type render inline.
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (contentType) {
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `inline; filename="${dispositionName}"`);
      } else {
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${dispositionName}"`);
      }
      res.sendFile(full, { headers: { "X-Content-Type-Options": "nosniff" } });
      return;
    }
  }
  res.status(404).json({ error: "File not found" });
});

export default router;
