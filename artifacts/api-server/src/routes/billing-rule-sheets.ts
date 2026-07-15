import { Router, type IRouter } from "express";
import multer from "multer";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, billingRuleSheetsTable } from "@workspace/db";
import { ListBillingRuleSheetsResponse, UploadBillingRuleSheetResponse } from "@workspace/api-zod";
import { upload, detectImage, detectDocument, EXTENSION_FORMATS } from "../lib/upload";
import { uploadsDir, ensureDirs, deleteUploadedFile } from "../lib/paths";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);
const ALLOWED_EXTENSIONS = new Set([
  ".pdf",
  ".xlsx",
  ".xls",
  ".docx",
  ".doc",
  ".png",
  ".jpg",
  ".jpeg",
]);

function toApi(s: typeof billingRuleSheetsTable.$inferSelect) {
  return {
    id: s.id,
    title: s.title,
    notes: s.notes,
    fileUrl: s.fileUrl,
    fileName: s.fileName,
    contentType: s.contentType,
    createdAt: s.createdAt.toISOString(),
  };
}

router.get("/billing-rule-sheets", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(billingRuleSheetsTable)
    .orderBy(billingRuleSheetsTable.createdAt);
  res.json(ListBillingRuleSheetsResponse.parse(rows.map(toApi)));
});

router.post(
  "/billing-rule-sheets",
  (req, res, next) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
          res.status(400).json({
            error: "File is too large. The maximum size is 25 MB.",
            code: "FILE_TOO_LARGE",
          });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  async (req, res): Promise<void> => {
  ensureDirs();
  const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  if (!file) {
    res.status(400).json({ error: "No file uploaded (expected an Excel, Word, PDF, or image in field 'file')." });
    return;
  }
  if (!title) {
    res.status(400).json({ error: "A title is required." });
    return;
  }

  const originalName = file.originalname || "cheat-sheet";
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    res.status(400).json({ error: "Unsupported file type. Upload a PDF, Excel, Word, or image file." });
    return;
  }

  // Verify the actual file content (magic bytes) matches the declared extension,
  // then use a server-normalized extension so untrusted names can't smuggle a type.
  let safeExt = ext;
  if (IMAGE_EXTENSIONS.has(ext)) {
    const detected = detectImage(file.buffer);
    if (!detected) {
      res.status(400).json({ error: "Uploaded file is not a valid PNG or JPEG image." });
      return;
    }
    safeExt = detected.ext;
  } else {
    const detected = detectDocument(file.buffer);
    const allowed = EXTENSION_FORMATS[ext] ?? [];
    if (!detected || !allowed.includes(detected)) {
      res.status(400).json({ error: "Uploaded file content does not match its extension." });
      return;
    }
  }

  const filename = `billing_rule_${Date.now()}_${crypto.randomBytes(6).toString("hex")}${safeExt}`;
  const absPath = path.resolve(uploadsDir, filename);
  fs.writeFileSync(absPath, file.buffer);

  let row;
  try {
    [row] = await db
      .insert(billingRuleSheetsTable)
      .values({
        title,
        notes: typeof req.body?.notes === "string" && req.body.notes.trim() ? req.body.notes.trim() : null,
        fileUrl: `/api/files/${encodeURIComponent(filename)}`,
        fileName: originalName,
        contentType: safeExt.replace(/^\./, "").toLowerCase(),
      })
      .returning();
  } catch (err) {
    // Don't leave an orphaned upload on disk if the DB insert fails.
    fs.rmSync(absPath, { force: true });
    throw err;
  }

  await recordAudit({
    action: "uploaded billing rule sheet",
    entityType: "billing_rule_sheet",
    entityId: row.id,
    description: row.title,
  });

  res.status(201).json(UploadBillingRuleSheetResponse.parse(toApi(row)));
  },
);

router.delete("/billing-rule-sheets/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db
    .delete(billingRuleSheetsTable)
    .where(eq(billingRuleSheetsTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Billing rule sheet not found" });
    return;
  }
  deleteUploadedFile(row.fileUrl);
  await recordAudit({
    action: "deleted billing rule sheet",
    entityType: "billing_rule_sheet",
    entityId: id,
    description: row.title,
  });
  res.sendStatus(204);
});

export default router;
