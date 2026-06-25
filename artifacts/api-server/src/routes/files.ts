import { Router, type IRouter } from "express";
import fs from "node:fs";
import path from "node:path";
import { generatedDir, uploadsDir } from "../lib/paths";

const router: IRouter = Router();

router.get("/files/:name", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const name = path.basename(decodeURIComponent(raw));
  for (const dir of [generatedDir, uploadsDir]) {
    const full = path.resolve(dir, name);
    if (full.startsWith(path.resolve(dir)) && fs.existsSync(full)) {
      res.sendFile(full);
      return;
    }
  }
  res.status(404).json({ error: "File not found" });
});

export default router;
