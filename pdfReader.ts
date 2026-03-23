// ─── PDF text extraction (V2.1) ───────────────────────────────────────────────
// Uses pdf-parse to extract text from a PDF file.
// Returns structured metadata plus truncated text for digest generation.

import { PDFParse } from "pdf-parse";
import { createHash } from "crypto";

export interface PdfDocument {
  refId: string;    // "pdf:{sha1}" — stable content-based ID
  title: string;    // heuristically extracted from first non-empty line
  authors: string;  // heuristically extracted
  text: string;     // full extracted text, truncated to 8 000 chars
  numpages: number;
}

export async function parsePdf(filePath: string, filename: string): Promise<PdfDocument> {
  const fileBuffer = await Bun.file(filePath).arrayBuffer();
  const buffer = Buffer.from(fileBuffer);

  // Stable ref_id from first 512 bytes (avoids full-file hashing for large PDFs)
  const sha1 = createHash("sha1").update(buffer.slice(0, 512)).digest("hex");
  const refId = `pdf:${sha1}`;

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const textResult = await parser.getText();
  const rawText = (textResult.text ?? "").trim();
  const text = rawText.slice(0, 8_000);
  const numpages = textResult.total ?? 1;

  // Extract title from first meaningful line (papers start with title)
  const lines = text
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 5);

  const title =
    lines[0]?.slice(0, 200) ?? filename.replace(/\.pdf$/i, "");

  // Heuristic author extraction: look for a line after the title that has
  // commas or "and" (typical author-list format) and is reasonably short
  let authors = "";
  for (let i = 1; i < Math.min(15, lines.length); i++) {
    const line = lines[i]!;
    if (
      (line.includes(",") || / and /i.test(line)) &&
      line.length < 250 &&
      !line.toLowerCase().includes("abstract") &&
      !line.toLowerCase().includes("introduction")
    ) {
      authors = line;
      break;
    }
  }

  return { refId, title, authors, text, numpages };
}
