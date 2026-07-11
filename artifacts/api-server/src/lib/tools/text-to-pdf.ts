import PDFDocument from "pdfkit";
import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase } from "./utils.js";

interface TextToPdfArgs {
  text: string;
}

// Deliberately only multi-word command phrases -- never a bare "pdf" --
// so a message that merely mentions the word ("I like pdf files") never
// matches. Every phrase pairs an action verb or clear intent with "pdf".
const TRIGGER_PHRASES = [
  "convert to pdf",
  "convert this to pdf",
  "convert that to pdf",
  "convert this text to pdf",
  "convert that text to pdf",
  "convert text to pdf",
  "make this a pdf",
  "make that a pdf",
  "make me a pdf",
  "make this into a pdf",
  "make that into a pdf",
  "create a pdf",
  "create pdf",
  "generate a pdf",
  "generate pdf",
  "turn this into a pdf",
  "turn that into a pdf",
  "turn this text into a pdf",
  "turn text into a pdf",
  "export to pdf",
  "export as pdf",
  "save as pdf",
  "download as pdf",
  "pdf this",
  "pdf of this",
  "text to pdf",
  "write this as pdf",
  "write as pdf",
  "put this in a pdf",
  "put this into a pdf",
] as const;

// Removes the matched command phrase and common connector words, so
// whatever's left is the actual content to put in the document.
const STRIP_PATTERN =
  /\b(convert|make|create|generate|turn|export|save|download|pdf)\b|\b(this|that|to|into|as|a|an|of|for|me|please|the)\b/gi;

function match(text: string): TextToPdfArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const content = text
    .replace(STRIP_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Drop leftover leading/trailing punctuation from stripping words
    // adjacent to a colon or dash (e.g. "convert to pdf: notes here").
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
