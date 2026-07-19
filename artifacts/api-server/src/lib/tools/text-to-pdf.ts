import PDFDocument from "pdfkit";
import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase } from "./utils.js";

interface TextToPdfArgs {
  text: string;
}

// Intent-based triggers.
//
// "convert to pdf <text>" is included directly so the advertised syntax works.
// The false-positive risk from JUNE's own capability description ("I can do
// text to PDF...") is mitigated by the content check: after stripping command
// words, an empty remainder returns null so the tool never fires on bare
// capability quotes.
//
// Demonstrative-pronoun forms ("convert this to pdf") remain for users who
// paste content first and refer to it with "this"/"that".
const TRIGGER_PHRASES = [
  "convert to pdf",
  "convert this to pdf",
  "convert that to pdf",
  "convert this text to pdf",
  "convert that text to pdf",
  "make this a pdf",
  "make that a pdf",
  "make me a pdf",
  "make this into a pdf",
  "make that into a pdf",
  "turn this into a pdf",
  "turn that into a pdf",
  "turn this text into a pdf",
  "pdf this",
  "pdf of this",
  "put this in a pdf",
  "put this into a pdf",
] as const;

// Removes the matched command phrase and common connector words, so
// whatever's left is the actual content to put in the document.
const STRIP_PATTERN =
  /\b(convert|make|create|generate|turn|export|save|download|pdf|put)\b|\b(this|that|to|into|as|a|an|of|for|me|please|the|text)\b/gi;

function match(text: string): TextToPdfArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const content = text
    .replace(STRIP_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-,.\s]+|[:\-,.\s]+$/g, "");

  if (!content) return null;

  return { text: content };
}

function generatePdfBuffer(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(12).text(text, { align: "left" });
    doc.end();
  });
}

async function execute(args: TextToPdfArgs): Promise<ToolResult> {
  const buffer = await generatePdfBuffer(args.text);

  return {
    type: "document",
    reply: "Here's your PDF 📄",
    data: {
      sourceText: args.text,
      buffer: buffer.toString("base64"),
      mimeType: "application/pdf",
      filename: "document.pdf",
    },
  };
}

export const textToPdfTool: Tool<TextToPdfArgs> = {
  name: "text_to_pdf",
  description: "Converts text into a downloadable PDF document",
  match,
  execute,
};
