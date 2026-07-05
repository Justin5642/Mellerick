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

// Falls back to Resend's own shared sending domain, which only works for
// testing (delivers to the Resend account owner's own address). For real
// customer delivery, set EMAIL_FROM to an address on a domain verified in
// the Resend dashboard, e.g. "Mellerick Plumbing <quotes@mellerickplumbing.com.au>".
export function getFromAddress() {
  return process.env.EMAIL_FROM || "Mellerick Plumbing <onboarding@resend.dev>";
}
