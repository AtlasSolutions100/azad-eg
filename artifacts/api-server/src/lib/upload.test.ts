import { describe, expect, it } from "vitest";
import { detectDocument, EXTENSION_FORMATS } from "./upload";

const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const OLE2 = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PLAIN_TEXT = Buffer.from("this is just plain text pretending to be a document");

function accepts(ext: string, buffer: Buffer): boolean {
  const detected = detectDocument(buffer);
  return detected !== null && (EXTENSION_FORMATS[ext]?.includes(detected) ?? false);
}

describe("detectDocument", () => {
  it("recognizes PDF magic bytes", () => {
    expect(detectDocument(PDF)).toBe("pdf");
  });

  it("recognizes OOXML (zip) magic bytes", () => {
    expect(detectDocument(ZIP)).toBe("ooxml");
  });

  it("recognizes legacy OLE2 magic bytes", () => {
    expect(detectDocument(OLE2)).toBe("ole2");
  });

  it("returns null for unrecognized content", () => {
    expect(detectDocument(PLAIN_TEXT)).toBeNull();
    expect(detectDocument(Buffer.from([]))).toBeNull();
  });
});

describe("extension/content matching", () => {
  it("accepts genuine documents for their extension", () => {
    expect(accepts(".pdf", PDF)).toBe(true);
    expect(accepts(".xlsx", ZIP)).toBe(true);
    expect(accepts(".docx", ZIP)).toBe(true);
    expect(accepts(".xls", OLE2)).toBe(true);
    expect(accepts(".doc", OLE2)).toBe(true);
  });

  it("rejects a file renamed to a document extension", () => {
    expect(accepts(".pdf", PLAIN_TEXT)).toBe(false);
    expect(accepts(".xlsx", PLAIN_TEXT)).toBe(false);
    expect(accepts(".doc", PLAIN_TEXT)).toBe(false);
  });

  it("rejects content that mismatches its claimed extension family", () => {
    expect(accepts(".xlsx", PDF)).toBe(false);
    expect(accepts(".pdf", ZIP)).toBe(false);
    expect(accepts(".xls", ZIP)).toBe(false);
  });
});
