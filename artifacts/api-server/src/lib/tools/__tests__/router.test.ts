import { describe, expect, it } from "vitest";
import { routeTool } from "../registry.js";

describe("Capability Router - Milestone 3", () => {
  it("returns the deterministic QR-code capability and confidence", () => {
    const result = routeTool("generate a qr code for https://example.com");

    expect(result).not.toBeNull();
    expect(result?.tool.name).toBe("qrcode");
    expect(result?.args).toEqual({ text: "https://example.com" });
    expect(result?.confidence).toEqual({
      score: 0.98,
      reasoning: ["Text matches QR code generation pattern"],
    });
  });

  it("returns the deterministic URL-shortener capability and confidence", () => {
    const result = routeTool("shorten https://example.com");

    expect(result).not.toBeNull();
    expect(result?.tool.name).toBe("url_shortener");
    expect(result?.args).toEqual({ url: "https://example.com" });
    expect(result?.confidence).toEqual({
      score: 0.95,
      reasoning: ["Text matches URL shortening pattern"],
    });
  });

  it("returns null when no registered capability matches", () => {
    expect(routeTool("tell me something unrelated to tools")).toBeNull();
  });
});
