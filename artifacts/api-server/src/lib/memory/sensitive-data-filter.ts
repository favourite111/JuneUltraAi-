/**
 * M15-C: Sensitive Data Filter
 *
 * Identifies and blocks sensitive information (passwords, API keys, etc.)
 * from being stored in long-term memory.
 */

import { type UserFact } from "./types.js";

/**
 * Patterns for detecting sensitive data.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /\b(?:password|passwd|pwd|secret|token|key|api_key|apikey|auth_token)\b\s*[:=]\s*\S+/i,
  /\bsk_[a-z0-9]{20,}\b/i, // OpenAI-style keys
  /\bghp_[a-z0-9]{30,}\b/i, // GitHub personal access tokens
  /\b[A-Za-z0-9+/]{40,}\b/i, // Likely Base64 encoded secrets
  /\b\d{4,8}\b/i, // Potential OTPs (only if explicitly called out in context)
];

/**
 * Contextual keywords that might indicate an OTP or secret follows.
 */
const SENSITIVE_KEYWORDS = [
  "otp", "verification code", "one-time password", "secret", "credentials"
];

/**
 * Checks if a fact contains sensitive information.
 *
 * @param key The fact key.
 * @param value The fact value.
 * @param rawSource The original message source.
 * @returns true if the fact is sensitive and should be rejected.
 */
export function isSensitive(key: string, value: string, rawSource: string): boolean {
  const lowerKey = key.toLowerCase();
  const lowerValue = value.toLowerCase();
  const lowerSource = rawSource.toLowerCase();

  // 1. Check if the key itself is sensitive
  if (["password", "secret", "token", "apikey", "key"].some(k => lowerKey.includes(k))) {
    return true;
  }

  // 2. Check value against sensitive patterns
  if (SENSITIVE_PATTERNS.some(p => p.test(value) || p.test(rawSource))) {
    return true;
  }

  // 3. Check for sensitive keywords in source
  if (SENSITIVE_KEYWORDS.some(k => lowerSource.includes(k))) {
    // If a sensitive keyword is present, be extra cautious with any numeric or token-like value
    if (/^\d{4,8}$/.test(value) || /^[A-Za-z0-9]{20,}$/.test(value)) {
      return true;
    }
  }

  return false;
}
