import QRCode from "qrcode";
import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, imageResult } from "./utils.js";

interface QrCodeArgs {
  text: string;
}

// "qr code" itself is distinctive enough on its own (not a phrase that
// shows up in normal conversation), so no separate confirmation signal
// (like requiring a URL) is needed the way the other tools need one.
const TRIGGER_PHRASES = ["qr code", "qrcode", "qr-code"] as const;

// Strip the trigger phrase and connecting words, keep whatever's left as payload.
const STRIP_PATTERN = /\bqr[\s-]?code\b|\b(generate|create|make|for|of|from|a|me|this)\b/gi;

function match(text: string): QrCodeArgs | null {
  if (!containsAnyPhrase(text, TRIGGER_PHRASES)) return null;

  const payload = text.replace(STRIP_PATTERN, " ").replace(/\s+/g, " ").trim();
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
  name: "qrcode",
  description: "Generates a QR code image from text or a URL",
  match,
  execute,
};
