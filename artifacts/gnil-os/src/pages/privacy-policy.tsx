/**
 * Privacy Policy — public, no-login page served at /privacy.
 * Single authoritative policy for the Get Next In Line platform.
 * Structured for Twilio A2P 10DLC campaign vetting (error 30908 compliance).
 */
import React from 'react';
import { Link } from 'wouter';

const EFFECTIVE_DATE = 'August 14, 2026';
const CONTACT_EMAIL = 'privacy@getnextinline.com';
const APP_NAME = 'Get Next In Line';
export const PRIVACY_POLICY_URL = 'https://www.getnextinline.com/privacy';

interface SectionProps {
  id: string;
  title: string;
  children: React.ReactNode;
}

function Section({ id, title, children }: SectionProps) {
  return (
    <section id={id} className="mb-10 scroll-mt-24">
      <h2 className="text-xl font-semibold text-slate-900 mb-4 pb-2 border-b border-slate-200">
        {title}
      </h2>
      <div className="space-y-3 text-slate-600 leading-relaxed text-[15px]">
        {children}
      </div>
    </section>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p>{children}</p>;
}

function Ul({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5 space-y-1">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

/** Highlighted callout box — used for the required A2P non-sharing statement. */
function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border-2 border-indigo-200 bg-indigo-50 px-5 py-4 text-slate-700 text-[15px] leading-relaxed">
      {children}
    </div>
  );
}

const TOC = [
  { id: 'mobile-messaging',   label: 'Mobile Messaging & SMS Consent' },
  { id: 'who-we-are',         label: 'Who We Are' },
  { id: 'data-we-collect',    label: 'Data We Collect' },
  { id: 'how-we-use',         label: 'How We Use Your Data' },
  { id: 'payments',           label: 'Payments & Financial Data' },
  { id: 'perks-wallet',       label: 'Local Perks Wallet & Passport' },
  { id: 'coop-network',       label: 'Co-Op Business Network' },
  { id: 'sharing',            label: 'Sharing & Disclosure' },
  { id: 'retention',          label: 'Data Retention' },
  { id: 'security',           label: 'Security' },
  { id: 'your-rights',        label: 'Your Rights & Choices' },
  { id: 'children',           label: "Children's Privacy" },
  { id: 'changes',            label: 'Changes to This Policy' },
  { id: 'contact',            label: 'Contact Us' },
];

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm select-none">
              GN
            </div>
            <span className="text-sm font-medium text-slate-500">{APP_NAME}</span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Privacy Policy</h1>
          <p className="text-slate-500 text-sm">Effective date: {EFFECTIVE_DATE}</p>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-10 flex gap-10">
        {/* Sidebar TOC — sticky, hidden on small screens */}
        <aside className="hidden lg:block w-56 flex-shrink-0">
          <div className="sticky top-8">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Contents
            </p>
            <nav className="space-y-1">
              {TOC.map(({ id, label }) => (
                <a
                  key={id}
                  href={`#${id}`}
                  className="block text-sm text-slate-500 hover:text-indigo-600 transition-colors py-0.5 leading-snug"
                >
                  {label}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0">

          {/* ── SECTION 1: Mobile Messaging & SMS (first, prominent for A2P review) ── */}
          <Section id="mobile-messaging" title="Mobile Messaging & SMS Consent">

            <Callout>
              <strong>We do not share, sell, or provide your mobile phone number or
              messaging consent data to third parties or affiliates for marketing or
              promotional purposes.</strong>
            </Callout>

            <P>
              Mobile phone numbers and SMS opt-in consent collected through our platform
              are used solely to deliver transactional text messages to customers who
              have affirmatively opted in. We do not use mobile numbers or messaging
              consent for advertising, and we do not sell, rent, or transfer them to any
              third party for marketing or promotional purposes.
            </P>

            <P>
              <strong>What messages we send.</strong> Customers who affirmatively opt in
              may receive transactional messages only, including: check-in confirmations,
              queue position updates, appointment reminders, appointment cancellation
              notices, waitlist availability alerts, service notifications, and tracking
              links related to their visit. Message frequency varies based on the
              customer's activity with the business they are visiting.
            </P>

            <P>
              <strong>Rates and opt-out.</strong> Message and data rates may apply. Reply{' '}
              <strong>STOP</strong> to unsubscribe from any sender at any time. Reply{' '}
              <strong>HELP</strong> for assistance. We honor carrier-level STOP signals.
              Consent to receive text messages is not a condition of purchase or service.
            </P>

            <P>
              <strong>Messaging service provider.</strong> Text messages are delivered
              through Twilio, which acts as our messaging service provider. Twilio
              receives the minimum information necessary — including the recipient phone
              number and message content — solely to transmit messages on our behalf.
              Twilio does not receive SMS opt-in data for marketing purposes and does not
              use your information for its own marketing. Twilio's Privacy Policy governs
              their data handling.
            </P>

            <P>
              <strong>Inbound messages.</strong> Replies you send (including STOP, HELP,
              feedback ratings, and confirmation keywords) are received by our platform
              and used only to update your queue or appointment record or to honor your
              opt-out request. We do not sell or share inbound message content.
            </P>

          </Section>

          {/* ── SECTION 2: Who We Are ── */}
          <Section id="who-we-are" title="Who We Are">
            <P>
              {APP_NAME} ("we," "us," or "our") operates a business management platform
              that helps local service businesses manage queues, appointments, customer
              communications, and co-op partnerships. We provide tools for both business
              operators (staff and administrators) and their customers (people who book
              services, join waitlists, or redeem perks).
            </P>
            <P>
              This Privacy Policy is the single authoritative policy covering all data
              practices of the {APP_NAME} platform. There is no other privacy policy for
              this platform or brand.
            </P>
          </Section>

          {/* ── SECTION 3: Data We Collect ── */}
          <Section id="data-we-collect" title="Data We Collect">
            <P><strong>From consumers (customers of businesses on our platform):</strong></P>
            <Ul items={[
              'Name — provided when joining a queue, booking an appointment, or signing up for the Local Perks wallet.',
              'Phone number — provided to receive transactional SMS updates or to log in to the Local Perks wallet via one-time verification code.',
              'Email address — optionally provided for booking confirmations.',
              'SMS opt-in status — whether you have consented to receive text messages from the business you are visiting.',
              'Service and appointment history — services booked, staff who served you, dates and times, and any payment associated with each visit.',
              'Perk redemption history — perks collected and redeemed at participating businesses.',
              'Device information (browser type, IP address) — collected when you access the web booking page or wallet.',
            ]} />
            <P><strong>From business operators and staff:</strong></P>
            <Ul items={[
              'Business name, subdomain, and contact information.',
              'Staff names and role assignments.',
              'Service menus, pricing, and scheduling configuration.',
              'Twilio phone number configuration used to send messages to their customers.',
              'Stripe-connected payment configuration for deposit-hold and no-show protection.',
              'Session data tied to your admin login.',
            ]} />
            <P><strong>Automatically collected:</strong></P>
            <Ul items={[
              'Server and application logs (API requests, response codes, timestamps).',
              'Outbound SMS delivery records (delivery status, Twilio message SID) — not content shared with third parties.',
              'Webhook event logs from Stripe and Twilio.',
            ]} />
          </Section>

          {/* ── SECTION 4: How We Use Your Data ── */}
          <Section id="how-we-use" title="How We Use Your Data">
            <P>We use the information we collect to:</P>
            <Ul items={[
              'Operate the queue, waitlist, and appointment system.',
              'Send transactional SMS notifications to customers who have opted in — about their queue position, appointment, or visit status.',
              'Process booking deposits and no-show protection charges through Stripe.',
              'Provide business operators with customer history, reports, and analytics for their own business.',
              'Operate the Local Perks wallet — issuing redemption passes and recording perk stamps.',
              'Enable customers to redeem co-op perks at partner businesses using a pass code (not by sharing their phone number).',
              'Prevent fraud, duplicate redemptions, and platform abuse.',
              'Comply with legal obligations, including tax reporting for co-op revenue-share transactions.',
              'Diagnose and fix technical problems.',
            ]} />
          </Section>

          {/* ── SECTION 5: Payments ── */}
          <Section id="payments" title="Payments & Financial Data">
            <P>
              Some businesses use our platform to collect appointment deposits or
              no-show protection holds via Stripe. When you provide payment information
              on a booking page:
            </P>
            <Ul items={[
              'Card details are collected and tokenized directly by Stripe. We never see or store raw card numbers, CVVs, or magnetic stripe data.',
              'We store a Stripe PaymentIntent or SetupIntent identifier, the hold amount, and the charge status.',
              'Deposits and holds are initiated and released by the business; we process the webhook events that update the status in our system.',
            ]} />
            <P>
              Stripe's Privacy Policy governs how Stripe processes your payment data.
            </P>
          </Section>

          {/* ── SECTION 6: Local Perks Wallet ── */}
          <Section id="perks-wallet" title="Local Perks Wallet & Neighborhood Passport">
            <P>
              The Local Perks wallet lets you collect and redeem perks from participating
              businesses. Your wallet account is identified by your phone number, which
              is used only within our platform. Your phone number is not shared with
              partner businesses for any purpose, including perk redemption.
            </P>
            <Ul items={[
              'Wallet login uses a one-time SMS verification code sent to your phone. No password is stored.',
              'Your wallet session is stored in an HttpOnly cookie not accessible to third-party scripts.',
              'Perk passes issued to your wallet carry a redemption code. When you redeem a perk, the redeeming business receives only the redemption code and confirmation that the pass is valid — not your phone number.',
              'The Neighborhood Passport records stamps earned across participating businesses, tied to your wallet account within our platform.',
              'Ambassador reward balances and referral codes are linked to your wallet account within our platform.',
            ]} />
            <P>
              Your phone number and SMS opt-in status are not shared with co-op partner
              businesses for any purpose, including perk redemption, marketing, or
              promotions.
            </P>
          </Section>

          {/* ── SECTION 7: Co-Op Network ── */}
          <Section id="coop-network" title="Co-Op Business Network">
            <P>
              Get Next In Line operates a co-op network where independent businesses
              partner to offer mutual perks and cross-referrals. Your mobile phone number
              and SMS opt-in consent are not shared with any co-op partner business for
              any purpose.
            </P>
            <Ul items={[
              'Perk redemption is validated using a redemption code — the redeeming business confirms a pass is valid without receiving your phone number or contact information.',
              'Revenue-share obligations and settlement data are recorded in a compliance ledger for tax and audit purposes.',
              'Franchise networks may share operational service data across their own locations, but not customer phone numbers or SMS consent data for marketing.',
              'Anonymous aggregate statistics (e.g., redemption counts) may be shared within a partnership to measure co-op program value.',
            ]} />
            <P>
              We do not sell customer data to co-op partners. Mobile phone numbers, SMS
              opt-in data, and messaging consent are excluded from all co-op data sharing.
            </P>
          </Section>

          {/* ── SECTION 8: Sharing & Disclosure ── */}
          <Section id="sharing" title="Sharing & Disclosure">

            <Callout>
              <strong>We do not share, sell, or provide your mobile phone number or
              messaging consent data to third parties or affiliates for marketing or
              promotional purposes.</strong> Mobile information and SMS opt-in consent
              are provided only to Twilio, our messaging service provider, when
              necessary to transmit text messages you have consented to receive. This
              information is not used by Twilio or anyone else for marketing. All other
              data-sharing categories below exclude mobile phone numbers, SMS opt-in
              data, and messaging consent.
            </Callout>

            <P>We share personal information only in the following circumstances:</P>
            <Ul items={[
              "With the business you are visiting — your name, service history, and visit status are visible to that business's staff. Your phone number is visible to the business only so they can serve you directly; it is not shared for marketing.",
              'With Twilio (messaging service provider) — solely to transmit text messages you have opted in to receive. Twilio does not receive your information for marketing.',
              'With Stripe (payment processor) — solely to process payment holds and deposits you authorize.',
              'With infrastructure providers (database hosting, cloud compute) — under data processing agreements, solely to operate the platform.',
              'When required by law, court order, or to protect rights and safety.',
              'In connection with a merger, acquisition, or asset sale — affected users will be notified via the contact information on file and/or a prominent notice on this page.',
            ]} />

            <P>
              We do not sell personal information to any third party. We do not share
              mobile phone numbers, SMS opt-in data, or messaging consent with
              advertisers, affiliates, co-op partners, or any other party for marketing
              or promotional purposes.
            </P>

          </Section>

          {/* ── SECTION 9: Data Retention ── */}
          <Section id="retention" title="Data Retention">
            <P>
              We retain customer records (name, phone, visit history) for as long as the
              business relationship is active and for a reasonable period afterward to
              support dispute resolution, chargebacks, and legal compliance.
            </P>
            <P>
              SMS delivery records are retained for up to 12 months for operational
              debugging and dispute resolution. Message content is not retained beyond
              what is needed for operational purposes.
            </P>
            <P>
              Co-op compliance and tax ledger entries are retained for 7 years to meet
              financial record-keeping obligations.
            </P>
            <P>
              Wallet login codes expire within minutes of issue. Wallet sessions expire
              after a period of inactivity (typically 30 days).
            </P>
            <P>
              You may request deletion of your consumer records; see Your Rights below.
              Some records (e.g., completed financial transactions) may need to be
              retained to comply with legal obligations even after a deletion request.
            </P>
          </Section>

          {/* ── SECTION 10: Security ── */}
          <Section id="security" title="Security">
            <Ul items={[
              'All data is transmitted over TLS (HTTPS). The platform refuses plain-HTTP connections.',
              'Admin sessions use HttpOnly, Secure, SameSite cookies backed by a server-side session store — tokens are never exposed in URLs or page scripts.',
              'Customer wallet sessions use the same cookie security model, scoped to the /api/wallet path.',
              'Inbound Twilio webhook requests are validated against Twilio\'s X-Twilio-Signature before processing.',
              'Stripe webhook events are validated using Stripe\'s webhook signature header.',
              'Co-op pass QR codes are cryptographically signed so they cannot be forged.',
              'Rate limiting is applied to login, wallet, and SMS-sending endpoints to prevent abuse.',
              'Developer API tokens are stored as SHA-256 hashes — the plaintext is shown only once at issuance.',
            ]} />
            <P>
              No system is perfectly secure. If you believe your information has been
              compromised, please contact us immediately at{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">{CONTACT_EMAIL}</a>.
            </P>
          </Section>

          {/* ── SECTION 11: Your Rights ── */}
          <Section id="your-rights" title="Your Rights & Choices">
            <P>Depending on where you live, you may have rights including:</P>
            <Ul items={[
              'Access — request a copy of the personal data we hold about you.',
              'Correction — ask us to fix inaccurate or incomplete records.',
              'Deletion — ask us to delete your consumer profile and associated records (subject to legal retention requirements).',
              'Opt-out of SMS — reply STOP to any message at any time, or contact us to update your preferences.',
              'Portability — request your data in a structured, machine-readable format.',
            ]} />
            <P>
              To exercise any of these rights, email{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">{CONTACT_EMAIL}</a>{' '}
              with your name and the phone number associated with your account. We will
              respond within 30 days. California residents: we honor rights under the
              CCPA/CPRA. EEA/UK residents: we honor rights under the GDPR/UK GDPR.
            </P>
            <P>
              <strong>Business operators:</strong> your account data and configuration
              can be managed from within the platform. Contact us to request full account
              closure and data deletion.
            </P>
          </Section>

          {/* ── SECTION 12: Children ── */}
          <Section id="children" title="Children's Privacy">
            <P>
              Get Next In Line is not directed to children under 13. We do not knowingly
              collect personal information from children under 13. If you believe a child
              has provided us with their information, please contact us and we will
              delete it promptly.
            </P>
          </Section>

          {/* ── SECTION 13: Changes ── */}
          <Section id="changes" title="Changes to This Policy">
            <P>
              We may update this Privacy Policy from time to time. When we make material
              changes, we will update the effective date at the top of this page and,
              where we have contact information, notify affected users by SMS or email.
              Your continued use of the platform after the effective date of the updated
              policy constitutes your acceptance of the changes.
            </P>
          </Section>

          {/* ── SECTION 14: Contact ── */}
          <Section id="contact" title="Contact Us">
            <P>Questions or requests about this Privacy Policy:</P>
            <div className="mt-3 inline-block bg-slate-100 rounded-lg px-5 py-4 text-slate-700 text-sm leading-relaxed">
              <strong>{APP_NAME}</strong><br />
              Privacy inquiries:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">{CONTACT_EMAIL}</a><br />
              Policy URL:{' '}
              <a href={PRIVACY_POLICY_URL} className="text-indigo-600 hover:underline">{PRIVACY_POLICY_URL}</a>
            </div>
          </Section>

        </main>
      </div>

      {/* Footer */}
      <div className="border-t border-slate-200 bg-white mt-4">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-wrap gap-4 items-center justify-between text-sm text-slate-400">
          <span>© {new Date().getFullYear()} {APP_NAME}. All rights reserved.</span>
          <div className="flex gap-4">
            <Link href="/terms" className="hover:text-indigo-600 transition-colors">
              Terms and Conditions
            </Link>
            <span>Effective {EFFECTIVE_DATE}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
