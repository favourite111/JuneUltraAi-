import QRCode from "qrcode";
import type { Tool, ToolResult } from "./types.js";
import { containsAnyPhrase, imageResult } from "./utils.js";

interface QrCodeArgs {
  text: string;
}

// "qr code" alone is NOT distinctive enough — people mention QR codes in
// ordinary conversation without asking for one to be generated ("I saw a QR
// code on a billboard", "there's a QR code on the poster"). A prior version
// fired on any such mention because non-empty leftover text after stripping
// filler words was treated as intent, which false-triggered on passive,
// past-tense observations.
//
// Requires a real request signal in addition to the phrase: either an
// explicit action verb ("generate/create/make/need/want/give me/send me/
// show me a qr code") or a "for"/":" clause directly attached to the phrase
// naming what to encode ("qr code for https://x.com", "qr code: my text").
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

// Strip the trigger phrase, action verbs, and connecting words, keep
// whatever's left as payload.
const STRIP_PATTERN =
  /\bqr[\s-]?code\b|\b(can you|give me|send me|show me|generate|create|make|need|want|for|of|from|a|me|this|that)\b/gi;

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
  name: "qrcode",
  description: "Generates a QR code image from text or a URL",
  match,
  execute,
};
