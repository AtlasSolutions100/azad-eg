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

/** Format families recognized by magic bytes for progress-report documents. */
export type DocumentFormat = "ooxml" | "ole2" | "pdf";

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[i] !== bytes[i]) return false;
  }
  return true;
}

/**
 * Inspects a buffer's magic bytes and returns the detected document format
 * family, or null when the content is not a supported document. Modern Office
 * files (.xlsx/.docx) are ZIP containers, legacy Office files (.xls/.doc) are
 * OLE2 compound files, and PDFs start with "%PDF".
 */
export function detectDocument(buffer: Buffer): DocumentFormat | null {
  // OOXML (.xlsx/.docx) and other ZIP-based: "PK" local file header.
  if (
    startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(buffer, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "ooxml";
  }
  // Legacy OLE2 compound file (.xls/.doc).
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "ole2";
  }
  // PDF: "%PDF".
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46])) {
    return "pdf";
  }
  return null;
}

/** Maps an allowed extension to the document format families its content may have. */
export const EXTENSION_FORMATS: Record<string, DocumentFormat[]> = {
  ".xlsx": ["ooxml"],
  ".docx": ["ooxml"],
  ".xls": ["ole2"],
  ".doc": ["ole2"],
  ".pdf": ["pdf"],
};
