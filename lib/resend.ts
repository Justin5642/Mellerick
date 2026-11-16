import { Resend } from "resend";

export function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Email sending is not configured yet — RESEND_API_KEY is missing. Add it in Vercel project settings."
    );
  }
  return new Resend(apiKey);
}

// Where customer and supplier replies go (16 Nov 2026). The sending address is
// on a Resend sending domain nobody reads, so every customer-facing email sets
// Reply-To to a monitored mailbox. EMAIL_REPLY_TO (one address, or several
// comma-separated) wins; otherwise the business email (BUSINESS_EMAIL, else
// admin@mellerick.com, lib/business-info.ts). One setting, never hardcoded.
export function getReplyTo(): string[] {
  const raw = process.env.EMAIL_REPLY_TO || process.env.BUSINESS_EMAIL || "admin@mellerick.com";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Falls back to Resend's own shared sending domain, which only works for
// testing (delivers to the Resend account owner's own address). For real
// customer delivery, set EMAIL_FROM to an address on a domain verified in
// the Resend dashboard, e.g. "Mellerick Pty Ltd <accounts@send.mellerick.com>". One setting, read here
// only; every send goes through it.
export function getFromAddress() {
  return process.env.EMAIL_FROM || "Mellerick Pty Ltd <onboarding@resend.dev>";
}
