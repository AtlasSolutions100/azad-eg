import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { db, signaturesTable } from "@workspace/db";
import { ListSignaturesResponse, UploadSignatureResponse } from "@workspace/api-zod";
import { imageUpload, detectImage } from "../lib/upload";
import { uploadsDir, ensureDirs } from "../lib/paths";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

function toApi(s: typeof signaturesTable.$inferSelect) {
  return {
    id: s.id,
    name: s.name,
    title: s.title,
    email: s.email,
    imageUrl: s.imageUrl,
    isDefault: s.isDefault,
    createdAt: s.createdAt.toISOString(),
  };
}

router.get("/signatures", async (_req, res): Promise<void> => {
  const rows = await db.select().from(signaturesTable).orderBy(signaturesTable.createdAt);
  res.json(ListSignaturesResponse.parse(rows.map(toApi)));
});

router.post("/signatures", imageUpload.single("file"), async (req, res): Promise<void> => {
  ensureDirs();
  const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
  const name = typeof req.body?.name === "string" ? req.body.name : "";
  if (!file) {
    res.status(400).json({ error: "No image uploaded (expected a PNG or JPEG in field 'file')." });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "Signature name is required." });
    return;
  }
  // Verify the actual file content (magic bytes), not just the declared MIME, then
  // use a server-normalized extension so untrusted filenames can't smuggle a type.
  const detected = detectImage(file.buffer);
  if (!detected) {
    res.status(400).json({ error: "Uploaded file is not a valid PNG or JPEG image." });
    return;
  }
  const filename = `signature_${Date.now()}${detected.ext}`;
  fs.writeFileSync(path.resolve(uploadsDir, filename), file.buffer);

  const [row] = await db
    .insert(signaturesTable)
    .values({
      name,
      title: typeof req.body?.title === "string" ? req.body.title : null,
      email: typeof req.body?.email === "string" ? req.body.email : null,
      imageUrl: `/api/files/${encodeURIComponent(filename)}`,
    })
    .returning();

  const notice = row.email ? ` Notification queued for ${row.email}.` : "";
  await recordAudit({ action: "uploaded signature", entityType: "signature", entityId: row.id, description: `${row.name}.${notice}` });

  res.status(201).json(UploadSignatureResponse.parse(toApi(row)));
});

router.delete("/signatures/:id", async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [row] = await db.delete(signaturesTable).where(eq(signaturesTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Signature not found" });
    return;
  }
  res.sendStatus(204);
});

export default router;
