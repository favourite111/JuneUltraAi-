import QRCode from "qrcode";
import type { Tool, ToolResult, ToolManifest } from "./types.js";
import { containsAnyPhrase, imageResult } from "./utils.js";

interface QrCodeArgs {
  text: string;
}

const TRIGGER_PHRASES = ["qr code", "qrcode", "qr-code"] as const;

const ACTION_VERB_PHRASES = [
  "generate",
  "create",
  "make",
  "need",
  "want",
  "give me",
  "send me",
  "show me",
] as const;

const FOR_CLAUSE_PATTERN = /\bqr[\s-]?code\b\s*(for|:|-)\s*\S/i;

const STRIP_PATTERN =
  /\bqr[\s-]?code\b|\b(can you|give me|send me|show me|generate|create|make|need|want|for|of|from|a|me|this|that)\b/gi;

/**
 * Phase 2 Manifest for the QR Generator tool.
 */
const manifest: ToolManifest = {
  id: "qrcode",
  name: "QR Generator",
  description: "Creates high-quality QR code images from any text or URL provided by the user.",
  version: "2.0.0",
  category: "media",
  triggers: [...TRIGGER_PHRASES],
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text or URL to encode into the QR code."
      }
    },
    required: ["text"]
  },
  outputTypes: ["image"],
  cost: 1,
  estimatedLatency: 150,
  permissions: [],
  examples: [
    "generate a qr code for https://google.com",
    "make a qrcode: My Secret Message",
    "show me a qr code for this text: Hello World"
  ]
};

function match(text: string): QrCodeArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const hasActionVerb = containsAnyPhrase(text, ACTION_VERB_PHRASES);
  const hasForClause = FOR_CLAUSE_PATTERN.test(text);
  if (!hasActionVerb && !hasForClause) return null;

  const payload = text
    .replace(STRIP_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-,.\s]+|[:\-,.\s]+$/g, "");
  if (!payload) return null;

  return { text: payload };
}

async function execute(args: QrCodeArgs): Promise<ToolResult> {
  const buffer = await QRCode.toBuffer(args.text, { type: "png", width: 400 });

  return imageResult("Here's your QR code 📷", {
    encodedText: args.text,
    buffer: buffer.toString("base64"),
    mimeType: "image/png",
  });
}

export const qrCodeTool: Tool<QrCodeArgs> = {
  name: manifest.id,
  description: manifest.description,
  manifest,
  match,
  execute,
};
