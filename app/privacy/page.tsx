import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage, CONTACT_EMAIL, BUSINESS, BUSINESS_ADDRESS } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy Policy — Mellerick Field" };

export default function PrivacyPolicyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="14 October 2026">
      <p>
        Mellerick Field is the job-management app used by staff of {BUSINESS} (trading as Mellerick Plumbing). It is
        provided only to our employees and contractors; there is no public sign-up. This policy explains what the app
        collects, why, and who it is shared with. We handle personal information in line with the Australian Privacy
        Principles under the <em>Privacy Act 1988</em> (Cth).
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details</strong> — your name, work email, phone number and role, set up by our office.</li>
        <li>
          <strong>Location</strong> — your device&apos;s location, used to clock you in and out automatically when you arrive at
          or leave a job site and to record travel time between sites. With your permission (&quot;Allow all the time&quot;)
          this includes location while the app is in the background. Tracking runs only for technicians, and only
          during working hours (06:00–19:00 Monday to Saturday) or while you are on the clock; outside those times it
          stops. Location is also used to tag job photos with where they were taken.
        </li>
        <li><strong>Work records</strong> — time entries, job notes, job photos, variations, expenses and receipts, backflow test results, signatures and voice reports you create in the app.</li>
        <li>
          <strong>Voice</strong> — when you dictate a note or record a voice report, speech is converted to text by your
          phone&apos;s built-in speech recognition (Apple or Google). The text is saved to the job. For voice reports, the audio
          recording is also stored with the job where your phone supports it.
        </li>
        <li><strong>Camera and photos</strong> — photos you take or choose are uploaded to the job they belong to.</li>
        <li><strong>Customer information</strong> — names, addresses and contact details of our customers and sites, which you view and update while doing the work.</li>
        <li><strong>Diagnostics</strong> — crash and error reports (device type, app version and the error), so we can fix problems. These do not include your notes, customer details or amounts.</li>
        <li><strong>Notifications</strong> — a device token so we can send you job notifications.</li>
      </ul>

      <h2>How we use it</h2>
      <p>
        To schedule and record work, calculate hours and pay, invoice customers, meet compliance obligations (such as
        backflow testing), keep the app working and secure, and contact you about your work. We do not use your
        information for advertising, and we do not sell it.
      </p>

      <h2>Who we share it with</h2>
      <p>We use these service providers to run the app. They process data on our behalf and only for that purpose:</p>
      <ul>
        <li><strong>Supabase</strong> — database, sign-in and file storage (hosted in Sydney, Australia).</li>
        <li><strong>PowerSync</strong> — keeps a copy of your jobs on your phone so the app works without signal.</li>
        <li><strong>Vercel</strong> — hosts the web application.</li>
        <li><strong>Anthropic</strong> — the &quot;Polish with AI&quot; and dictation clean-up features send the note text to Anthropic&apos;s Claude service to tidy wording, and the backflow data-plate scan sends the photo. Anthropic does not use this data to train its models.</li>
        <li><strong>Apple and Google</strong> — speech recognition on your device, and push notifications.</li>
        <li><strong>Sentry</strong> — crash and error reporting.</li>
        <li><strong>Xero and Google Calendar</strong> — office staff only: invoices and schedules are shared with these if connected.</li>
      </ul>
      <p>Some of these providers store data outside Australia (for example in the United States). We choose providers that protect data to a standard comparable to the Australian Privacy Principles.</p>

      <h2>How long we keep it</h2>
      <p>
        Work records (jobs, time entries, notes, photos, test results) are business records and are kept for as long as
        we are required to by law, generally at least seven years. Location readings that do not become part of a time
        entry are not kept. Copies on your phone are removed when you sign out.
      </p>

      <h2>Security</h2>
      <p>
        Data is encrypted in transit. Access is restricted by role — for example, technicians cannot see prices,
        rates or invoices. Only authorised Mellerick staff can access your information.
      </p>

      <h2>Your choices and rights</h2>
      <ul>
        <li>You can turn off location, camera, microphone or notification permissions in your phone&apos;s settings at any time. Automatic clock-in and travel time will not be recorded without location.</li>
        <li>You can ask to see or correct the personal information we hold about you.</li>
        <li>You can ask us to delete your account — see <Link href="/delete-account">Deleting your account</Link>.</li>
        <li>If you have a privacy complaint, contact us first. If you are not satisfied with our response you can contact the Office of the Australian Information Commissioner (oaic.gov.au).</li>
      </ul>

      <h2>Contact</h2>
      <p>
        {BUSINESS}, {BUSINESS_ADDRESS}
        <br />
        Email: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
    </LegalPage>
  );
}
