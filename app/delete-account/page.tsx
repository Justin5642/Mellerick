import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, CONTACT_EMAIL, BUSINESS } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Delete your account — Mellerick Field" };

// Google Play requires a public page explaining how a user asks for their
// account and data to be deleted. Accounts are created by our office (there is
// no self sign-up), so deletion is a request to the office, not a button.
export default function DeleteAccountPage() {
  const subject = encodeURIComponent("Delete my Mellerick Field account");
  return (
    <LegalPage title="Deleting your Mellerick Field account" updated="14 October 2026">
      <p>
        Mellerick Field accounts are created by {BUSINESS} for its staff. To have your account and personal data
        deleted:
      </p>
      <ol className="list-decimal pl-5 space-y-1">
        <li>
          Email <a href={`mailto:${CONTACT_EMAIL}?subject=${subject}`}>{CONTACT_EMAIL}</a> from the email address on
          your account, with the subject &quot;Delete my Mellerick Field account&quot;.
        </li>
        <li>We confirm the request within 5 business days and complete it within 30 days.</li>
      </ol>

      <h2>What is deleted</h2>
      <ul>
        <li>Your sign-in account, so you can no longer access the app.</li>
        <li>Your profile details (phone number, notification tokens) and app settings.</li>
        <li>Location readings that are not part of a recorded time entry.</li>
      </ul>

      <h2>What we keep, and why</h2>
      <p>
        Business records you created while working — time entries, job notes, photos, test results and signatures —
        are kept for as long as the law requires (generally seven years), because they form part of payroll, tax and
        compliance records. They remain linked to your name for that purpose and are then deleted.
      </p>

      <p>
        More detail is in our <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </LegalPage>
  );
}
