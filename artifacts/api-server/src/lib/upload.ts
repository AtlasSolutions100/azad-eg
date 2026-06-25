import multer from "multer";

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Strict image upload: rejects anything that isn't a PNG/JPEG by declared MIME. */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
});

/**
 * Validates a buffer's magic bytes and returns a safe, normalized extension.
 * Returns null when the content is not a supported image, so callers can reject.
 */
export function detectImage(buffer: Buffer): { ext: ".png" | ".jpg"; mime: "image/png" | "image/jpeg" } | null {
  if (buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return { ext: ".png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: ".jpg", mime: "image/jpeg" };
  }
  return null;
}
