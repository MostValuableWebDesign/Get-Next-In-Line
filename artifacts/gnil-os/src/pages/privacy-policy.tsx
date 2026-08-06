/**
 * Privacy Policy — public, no-login page served at /privacy.
 * Covers the data practices of the Get Next In Line platform:
 * queue/check-in, SMS, bookings, wallet/perks, Passport, Stripe payments,
 * and the co-op network.
 */
import React from 'react';
import { Link } from 'wouter';

const EFFECTIVE_DATE = 'August 4, 2026';
const CONTACT_EMAIL = 'privacy@getnextinline.com';
const APP_NAME = 'Get Next In Line';

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

const TOC = [
  { id: 'who-we-are',           label: 'Who We Are' },
  { id: 'data-we-collect',      label: 'Data We Collect' },
  { id: 'how-we-use',           label: 'How We Use Your Data' },
  { id: 'sms-communications',   label: 'SMS Communications' },
  { id: 'payments',             label: 'Payments & Financial Data' },
  { id: 'wallet-passport',      label: 'Local Perks Wallet & Neighborhood Passport' },
  { id: 'coop-network',         label: 'Co-Op Business Network' },
  { id: 'sharing',              label: 'Sharing & Disclosure' },
  { id: 'retention',            label: 'Data Retention' },
  { id: 'security',             label: 'Security' },
  { id: 'your-rights',          label: 'Your Rights & Choices' },
  { id: 'children',             label: "Children's Privacy" },
  { id: 'changes',              label: 'Changes to This Policy' },
  { id: 'contact',              label: 'Contact Us' },
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

          <Section id="who-we-are" title="Who We Are">
            <P>
              {APP_NAME} ("we," "us," or "our") operates a business management platform
              that helps local service businesses manage their queues, appointments,
              customer communications, and co-op partnerships. We provide tools for
              both business operators (staff and administrators) and their customers
              (people who book services, join waitlists, or redeem perks).
            </P>
            <P>
              This Privacy Policy explains how we collect, use, share, and protect
              personal information when you interact with our platform — whether as a
              business customer, a consumer, or a visitor.
            </P>
          </Section>

          <Section id="data-we-collect" title="Data We Collect">
            <P><strong>From consumers (customers of businesses on our platform):</strong></P>
            <Ul items={[
              'Name and phone number — provided when joining a queue, booking an appointment, or signing up for the Local Perks wallet.',
              'Email address — optionally provided for booking confirmations.',
              'Service and appointment history — the services you booked, staff who served you, dates and times, and any deposit or payment associated with each visit.',
              'SMS opt-in status and communication preferences.',
              'Perk redemptions and visit stamps collected at co-op partner businesses.',
              'Device information (browser type, IP address) when you access the web booking page or wallet.',
            ]} />
            <P><strong>From business operators and staff:</strong></P>
            <Ul items={[
              'Business name, subdomain, and contact information.',
              'Staff names and role assignments.',
              'Service menus, pricing, and scheduling configuration.',
              'Twilio phone number and webhook configuration (no Twilio auth credentials are stored by us).',
              'Stripe-connected payment configuration for deposit-hold and no-show protection.',
              'Session data tied to your admin login.',
            ]} />
            <P><strong>Automatically collected:</strong></P>
            <Ul items={[
              'Server and application logs (API requests, response codes, timestamps).',
              'Inbound and outbound SMS message records (body, delivery status, Twilio message SID).',
              'Webhook event logs from Stripe and Twilio.',
            ]} />
          </Section>

          <Section id="how-we-use" title="How We Use Your Data">
            <P>We use the information we collect to:</P>
            <Ul items={[
              'Operate the queue, waitlist, and appointment system — tracking visit state from check-in through checkout.',
              'Send you SMS notifications about your place in line, appointment confirmations, reminders, and follow-ups (see SMS Communications below).',
              'Process booking deposits and no-show protection charges through Stripe.',
              'Provide business operators with customer history, reports, and analytics for their own tenant.',
              'Operate the Local Perks wallet — issuing passes, recording perk redemptions, and managing your Neighborhood Passport stamps.',
              'Facilitate co-op perk sharing among network partner businesses (see Co-Op Network below).',
              'Prevent fraud, duplicate redemptions, and abuse of the platform.',
              'Comply with legal obligations, including tax reporting for co-op revenue-share transactions.',
              'Diagnose and fix technical problems.',
            ]} />
          </Section>

          <Section id="sms-communications" title="SMS Communications">
            <P>
              When you provide your phone number to a business on our platform, you may
              receive SMS messages from that business via Get Next In Line. These include:
            </P>
            <Ul items={[
              "Queue position updates and \u201cyou\u2019re next\u201d notifications.",
              'Appointment confirmations, reminders, and cancellation notices.',
              'Waitlist availability alerts.',
              'Perk availability announcements or co-op campaign messages (only if the business sends them and you have not opted out).',
              'Post-visit feedback requests (a one-time SMS after your visit).',
            ]} />
            <P>
              <strong>Opt-out:</strong> Reply <strong>STOP</strong> to any message to
              unsubscribe. Reply <strong>HELP</strong> for assistance. Message and data
              rates may apply. We honor carrier-level STOP and carrier unsubscribe signals.
            </P>
            <P>
              SMS messages are delivered via Twilio. Your phone number is shared with
              Twilio solely to send and receive messages on behalf of the business you
              interact with. Twilio's privacy policy applies to their processing.
            </P>
            <P>
              Inbound SMS replies (including feedback ratings, confirmation keywords, and
              opt-out requests) are received and processed by our platform. We use your
              reply only to update your queue/appointment record or your subscription
              preferences — we do not sell inbound message content.
            </P>
          </Section>

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
              Our platform's Stripe integration is subject to Stripe's usage requirements.
            </P>
          </Section>

          <Section id="wallet-passport" title="Local Perks Wallet & Neighborhood Passport">
            <P>
              The Local Perks wallet is a consumer-facing feature that lets you collect
              and redeem perks from co-op network businesses using only your phone number.
            </P>
            <Ul items={[
              'We identify wallet accounts by phone number. Login is via a one-time SMS verification code — no password is stored.',
              'Your wallet session is stored in an HttpOnly cookie and is not accessible to third-party scripts.',
              'Perk passes issued to your wallet show the offering business, perk description, redemption code, and expiry.',
              'The Neighborhood Passport records stamps earned across participating businesses; this is a single global identity tied to your phone number across the co-op network.',
              'Ambassador reward balances and referral codes are linked to your wallet identity.',
            ]} />
            <P>
              Your wallet data is shared among participating co-op businesses only to
              the extent necessary to validate a perk redemption (e.g., the scanning
              business sees that a valid pass exists and whether it has been redeemed).
              Your full redemption history is not broadly visible across the network.
            </P>
          </Section>

          <Section id="coop-network" title="Co-Op Business Network">
            <P>
              Get Next In Line operates a co-op network where independent businesses
              partner to offer mutual perks, cross-referrals, and shared promotions.
              Within this network:
            </P>
            <Ul items={[
              'Businesses can issue perk passes redeemable at partner locations. Your phone number and pass code are shared with the redeeming partner business when you present a pass.',
              'Revenue-share obligations, referral fees, and co-op settlement data are recorded in a compliance ledger for tax and audit purposes.',
              'Franchise networks (multi-location businesses) may share customer data across their own locations.',
              'Anonymous aggregate statistics (redemption counts, campaign reach) may be shared within a partnership to measure co-op value.',
            ]} />
            <P>
              We do not sell consumer data to co-op partners. Data shared between
              partner businesses through the platform is limited to what is needed to
              deliver the perk or service you requested.
            </P>
          </Section>

          <Section id="sharing" title="Sharing & Disclosure">
            <P>We share personal information only in these circumstances:</P>
            <Ul items={[
              "With the business you are visiting — your name, phone number, service history, and visit status are visible to that business's staff through their dashboard.",
              'With co-op partner businesses, as described above, to the extent required to deliver a perk.',
              'With Twilio to send and receive SMS messages on behalf of the business.',
              'With Stripe to process payment holds and deposits.',
              'With our infrastructure providers (database hosting, cloud compute) under data processing agreements.',
              'When required by law, court order, or to protect rights and safety.',
              'In connection with a merger, acquisition, or asset sale — we will notify you via the email or phone on file and/or a prominent notice on this page.',
            ]} />
            <P>We do not sell personal information to third parties.</P>
          </Section>

          <Section id="retention" title="Data Retention">
            <P>
              We retain customer records (name, phone, visit history) for as long as
              the business relationship is active and for a reasonable period afterward
              to support dispute resolution, chargebacks, and legal compliance.
            </P>
            <P>
              SMS message records are retained for up to 12 months for operational
              debugging and dispute resolution. Delivery status webhooks are retained
              for a shorter period.
            </P>
            <P>
              Co-op compliance and tax ledger entries are retained for 7 years to meet
              financial record-keeping obligations.
            </P>
            <P>
              Wallet login codes and sessions expire automatically — login codes within
              minutes of issue, wallet sessions within the period set by each business
              (typically 30 days of inactivity).
            </P>
            <P>
              You may request deletion of your consumer records; see Your Rights below.
              Note that some records (e.g. completed financial transactions) may need to
              be retained to comply with legal obligations even after a deletion request.
            </P>
          </Section>

          <Section id="security" title="Security">
            <Ul items={[
              'All data is transmitted over TLS (HTTPS). The platform refuses plain-HTTP connections.',
              'Admin sessions use HttpOnly, Secure, SameSite cookies backed by a server-side session store — session tokens are never exposed in URLs or page scripts.',
              'Customer wallet sessions use the same cookie security model and are scoped to the /api/wallet path.',
              'Inbound Twilio webhook requests are validated against Twilio\'s X-Twilio-Signature before processing.',
              'Stripe webhook events are validated using Stripe\'s signature header.',
              'Co-op pass QR codes are signed with P-256 keys so they cannot be forged offline.',
              'Rate limiting is applied to login and SMS-sending endpoints to prevent abuse.',
              'Developer API gateway tokens are stored as SHA-256 hashes — the plaintext is shown only once at issuance.',
            ]} />
            <P>
              No system is perfectly secure. If you believe your information has been
              compromised, please contact us immediately at{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">{CONTACT_EMAIL}</a>.
            </P>
          </Section>

          <Section id="your-rights" title="Your Rights & Choices">
            <P>Depending on where you live, you may have rights including:</P>
            <Ul items={[
              'Access — request a copy of the personal data we hold about you.',
              'Correction — ask us to fix inaccurate or incomplete records.',
              'Deletion — ask us to delete your consumer profile and associated records (subject to legal retention requirements).',
              'Opt-out of SMS — reply STOP to any message, or contact us to update your preferences.',
              'Portability — request your data in a structured, machine-readable format.',
            ]} />
            <P>
              To exercise any of these rights, email{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">{CONTACT_EMAIL}</a>{' '}
              with your name and phone number. We will respond within 30 days. For
              California residents, we honor rights under the CCPA/CPRA. For EEA/UK
              residents, we honor rights under the GDPR/UK GDPR.
            </P>
            <P>
              <strong>Business operators:</strong> your account data and tenant
              configuration can be managed from within the platform settings. Contact
              us to request full account closure and data deletion.
            </P>
          </Section>

          <Section id="children" title="Children's Privacy">
            <P>
              Get Next In Line is not directed to children under 13. We do not
              knowingly collect personal information from children under 13. If you
              believe a child has provided us with their information, please contact us
              and we will delete it promptly.
            </P>
          </Section>

          <Section id="changes" title="Changes to This Policy">
            <P>
              We may update this Privacy Policy from time to time. When we make
              material changes, we will update the effective date at the top of this
              page and, where we have contact information, notify affected users by
              SMS or email. Your continued use of the platform after the effective
              date of the updated policy constitutes your acceptance of the changes.
            </P>
          </Section>

          <Section id="contact" title="Contact Us">
            <P>Questions or requests about this Privacy Policy:</P>
            <div className="mt-3 inline-block bg-slate-100 rounded-lg px-5 py-4 text-slate-700 text-sm leading-relaxed">
              <strong>{APP_NAME}</strong><br />
              Privacy inquiries:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">{CONTACT_EMAIL}</a>
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
