import React from 'react';
import { Link } from 'wouter';

const EFFECTIVE_DATE = 'August 6, 2026';
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
  { id: 'acceptance', label: 'Acceptance of These Terms' },
  { id: 'our-platform', label: 'Our Platform' },
  { id: 'business-accounts', label: 'Business Accounts' },
  { id: 'customer-use', label: 'Customer Use' },
  { id: 'sms', label: 'SMS Communications' },
  { id: 'payments', label: 'Payments & Deposits' },
  { id: 'wallet', label: 'Wallet & Co-Op Perks' },
  { id: 'acceptable-use', label: 'Acceptable Use' },
  { id: 'third-party', label: 'Third-Party Services' },
  { id: 'intellectual-property', label: 'Intellectual Property' },
  { id: 'disclaimers', label: 'Disclaimers' },
  { id: 'liability', label: 'Limitation of Liability' },
  { id: 'indemnification', label: 'Indemnification' },
  { id: 'termination', label: 'Suspension & Termination' },
  { id: 'changes', label: 'Changes to These Terms' },
  { id: 'contact', label: 'Contact Us' },
];

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-10">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm select-none">
              GN
            </div>
            <span className="text-sm font-medium text-slate-500">{APP_NAME}</span>
          </div>
          <h1 className="text-3xl font-bold text-slate-900 mb-2">Terms and Conditions</h1>
          <p className="text-slate-500 text-sm">Effective date: {EFFECTIVE_DATE}</p>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-10 flex gap-10">
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

        <main className="flex-1 min-w-0">
          <div className="mb-10 rounded-lg border border-indigo-100 bg-indigo-50 px-5 py-4 text-sm text-indigo-900 leading-relaxed">
            These Terms and Conditions govern your use of {APP_NAME}. By creating an
            account, booking an appointment, joining a queue, using the Local Perks
            wallet, or otherwise using the platform, you agree to these Terms.
          </div>

          <Section id="acceptance" title="Acceptance of These Terms">
            <P>
              These Terms and Conditions (the “Terms”) are an agreement between you
              and {APP_NAME} (“GNIL,” “we,” “us,” or “our”). They apply to the GNIL
              web application, public booking pages, Local Perks wallet, SMS
              communications, APIs, and related services (collectively, the
              “Platform”).
            </P>
            <P>
              If you use the Platform on behalf of a business, you represent that you
              have authority to bind that business to these Terms. If you do not agree
              to these Terms, do not use the Platform.
            </P>
            <P>
              Our{' '}
              <Link href="/privacy" className="text-indigo-600 hover:underline">
                Privacy Policy
              </Link>{' '}
              explains how we handle personal information and is incorporated into
              these Terms.
            </P>
          </Section>

          <Section id="our-platform" title="Our Platform">
            <P>
              GNIL provides software tools for independent service businesses and
              their customers. Features may include customer check-in, queues and
              waitlists, appointments, service menus, staff scheduling, point of sale,
              customer communications, payment holds, reporting, co-op partnerships,
              and customer wallets.
            </P>
            <P>
              GNIL is a technology provider. Each business controls its own services,
              prices, hours, appointment availability, cancellation rules, deposits,
              refunds, and customer relationships. GNIL does not provide the underlying
              salon, barber, wellness, retail, or other professional service.
            </P>
            <P>
              Features may change, be temporarily unavailable, or be limited by the
              business using them. We will use reasonable efforts to keep the Platform
              available, but do not promise uninterrupted or error-free operation.
            </P>
          </Section>

          <Section id="business-accounts" title="Business Accounts">
            <P>
              Business operators are responsible for providing accurate account,
              business, service, pricing, hours, staff, and payment information.
              Businesses are also responsible for the actions of their team members
              and for keeping account credentials and administrative access secure.
            </P>
            <Ul items={[
              'Use customer information only for legitimate business, service, support, and communication purposes.',
              'Honor the business’s published prices, hours, cancellation rules, and booking commitments.',
              'Obtain any consent required before sending marketing messages or sharing customer information.',
              'Configure connected services, including Stripe and Twilio, accurately and keep those accounts in good standing.',
              'Review queue, appointment, payment, and message records before taking action that affects a customer.',
              'Comply with laws and regulations applicable to the business, its industry, and its location.',
            ]} />
            <P>
              A business may not use GNIL to impersonate another business, misrepresent
              its services, or collect information it does not need for its stated
              business purpose.
            </P>
          </Section>

          <Section id="customer-use" title="Customer Use">
            <P>
              Customers may use public booking pages, queues, waitlists, and the Local
              Perks wallet without creating a staff account. You agree to provide
              information that is accurate and current, including a reachable phone
              number or email address when required to confirm a booking.
            </P>
            <P>
              A booking is a request to reserve the selected service, staff member,
              and time. A booking is confirmed only when the Platform or the business
              displays a confirmation. The business may contact you about the booking,
              request additional information, or apply its disclosed cancellation and
              no-show policies.
            </P>
            <P>
              You are responsible for arriving on time, providing accurate contact
              information, following the business’s instructions, and paying amounts
              properly due for services you receive.
            </P>
          </Section>

          <Section id="sms" title="SMS Communications">
            <P>
              If you provide a phone number and consent to text communications, GNIL
              or the business you interact with may send appointment confirmations,
              reminders, queue updates, waitlist alerts, service messages, feedback
              requests, and other messages related to your interaction.
            </P>
            <P>
              Message frequency varies. Message and data rates may apply. Reply
              <strong> STOP</strong> to unsubscribe or <strong>HELP</strong> for help.
              Opting out of non-essential messages may prevent you from receiving some
              queue, appointment, or waitlist updates. Essential service messages may
              still be sent where permitted and necessary to complete a transaction.
            </P>
            <P>
              SMS delivery depends on carriers and third-party messaging providers.
              GNIL does not guarantee that a message will arrive immediately or at all.
              You should not rely on an SMS as the only way to track an appointment,
              queue position, payment event, or emergency situation.
            </P>
          </Section>

          <Section id="payments" title="Payments & Deposits">
            <P>
              Some businesses use Stripe to collect appointment deposits, payment
              authorizations, or no-show protection holds. The business—not GNIL—sets
              the applicable amount and policy and is responsible for explaining it
              before you book.
            </P>
            <Ul items={[
              'Payment details are processed by Stripe and are subject to Stripe’s terms and privacy policy.',
              'A temporary authorization or deposit hold is not necessarily a completed charge.',
              'A business may capture, release, or adjust a hold according to its disclosed policy and applicable law.',
              'Refunds, disputes, chargebacks, and service-quality disagreements should first be directed to the business that accepted the booking.',
              'GNIL does not guarantee that a bank, card issuer, Stripe, or business will approve or complete a payment.',
            ]} />
            <P>
              You authorize the business and its payment processor to process amounts
              that you approve or that are properly due under the booking terms shown
              to you.
            </P>
          </Section>

          <Section id="wallet" title="Wallet & Co-Op Perks">
            <P>
              The Local Perks wallet lets customers receive, view, and redeem offers
              from participating businesses. A pass may have an expiration date,
              usage limit, customer restriction, location restriction, or other
              redemption condition shown with the offer.
            </P>
            <Ul items={[
              'A pass is not cash and cannot be exchanged for cash unless the issuing business says otherwise.',
              'Only the business that issued or accepts a perk can decide whether a redemption condition has been met.',
              'Do not copy, sell, transfer, forge, or attempt to reuse a pass after redemption.',
              'Neighborhood Passport stamps and ambassador rewards are promotional benefits, not money or guaranteed property.',
              'Co-op businesses may change or end an offer subject to the terms displayed with that offer and applicable law.',
            ]} />
            <P>
              GNIL may refuse a redemption, suspend a wallet, or reverse a reward when
              it reasonably believes there has been fraud, duplicate use, technical
              abuse, or a violation of these Terms.
            </P>
          </Section>

          <Section id="acceptable-use" title="Acceptable Use">
            <P>You may not use the Platform to:</P>
            <Ul items={[
              'Break the law, violate another person’s rights, or evade a legal obligation.',
              'Upload malware, probe or disrupt the Platform, bypass security, or access another account or tenant.',
              'Scrape, harvest, copy, reverse engineer, or resell Platform data or functionality except as expressly permitted.',
              'Submit false bookings, spam businesses or customers, abuse SMS opt-in, or interfere with queue and appointment operations.',
              'Forge passes, QR codes, webhook requests, payment events, delivery statuses, or other Platform records.',
              'Send deceptive, abusive, harassing, discriminatory, or unlawful content.',
              'Use the Platform for emergency response, medical diagnosis, financial advice, or another purpose for which it is not designed.',
            ]} />
          </Section>

          <Section id="third-party" title="Third-Party Services">
            <P>
              The Platform connects with third-party services such as Stripe for
              payments and Twilio for SMS and voice. Those services have their own
              terms, privacy policies, availability, and requirements. Your use of a
              third-party service through GNIL is also subject to that provider’s
              terms.
            </P>
            <P>
              We are not responsible for a third party’s actions, outages, content,
              fees, delivery decisions, account restrictions, or privacy practices.
              Businesses are responsible for authorizing and maintaining their own
              third-party accounts where required.
            </P>
          </Section>

          <Section id="intellectual-property" title="Intellectual Property">
            <P>
              GNIL and its licensors own the Platform, including its software,
              designs, names, logos, documentation, interfaces, and underlying
              technology. These Terms grant you a limited, non-exclusive,
              non-transferable, revocable right to use the Platform for its intended
              purpose. No other license is granted.
            </P>
            <P>
              You retain ownership of content and business materials you submit.
              You grant GNIL the limited license needed to host, process, display,
              transmit, and back up that content to operate, secure, and improve the
              Platform and provide the features you request.
            </P>
            <P>
              If you send us suggestions or feedback, you allow us to use it without
              restriction or compensation, provided we do not identify you publicly
              without permission.
            </P>
          </Section>

          <Section id="disclaimers" title="Disclaimers">
            <P>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE PLATFORM IS PROVIDED “AS IS”
              AND “AS AVAILABLE.” GNIL DISCLAIMS WARRANTIES OF MERCHANTABILITY,
              FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AND ANY
              WARRANTY THAT THE PLATFORM WILL BE UNINTERRUPTED, SECURE, ACCURATE, OR
              ERROR-FREE.
            </P>
            <P>
              GNIL does not guarantee the quality, safety, legality, availability,
              price, or outcome of any service offered by a business. We do not
              guarantee that a booking, queue position, perk, SMS, payment, or reward
              will be available or completed as expected. Business and customer
              disputes are primarily between the parties who made the booking or
              provided the service.
            </P>
          </Section>

          <Section id="liability" title="Limitation of Liability">
            <P>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, GNIL AND ITS OFFICERS,
              EMPLOYEES, CONTRACTORS, AND LICENSORS WILL NOT BE LIABLE FOR INDIRECT,
              INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR
              FOR LOST PROFITS, REVENUE, DATA, GOODWILL, BOOKINGS, OR OPPORTUNITIES,
              ARISING FROM OR RELATED TO THE PLATFORM.
            </P>
            <P>
              TO THE MAXIMUM EXTENT PERMITTED BY LAW, GNIL’S TOTAL LIABILITY FOR
              CLAIMS ARISING FROM THE PLATFORM WILL NOT EXCEED THE GREATER OF THE
              AMOUNT YOU PAID GNIL FOR THE PLATFORM DURING THE THREE MONTHS BEFORE THE
              EVENT GIVING RISE TO THE CLAIM OR ONE HUNDRED U.S. DOLLARS ($100).
            </P>
            <P>
              Some jurisdictions do not allow certain limitations, so some of the
              above limits may not apply to you. Nothing in these Terms limits
              liability that cannot legally be limited.
            </P>
          </Section>

          <Section id="indemnification" title="Indemnification">
            <P>
              To the extent permitted by law, you agree to defend, indemnify, and hold
              harmless GNIL and its officers, employees, contractors, and licensors
              from claims, losses, liabilities, damages, costs, and expenses
              (including reasonable attorneys’ fees) arising from your use of the
              Platform, your content, your violation of these Terms, your violation
              of law or another person’s rights, or your operation of a business
              through the Platform.
            </P>
          </Section>

          <Section id="termination" title="Suspension & Termination">
            <P>
              You may stop using the Platform at any time. A business may request
              account closure through its account administrator or by contacting us.
              We may suspend or terminate access when reasonably necessary to protect
              the Platform, users, businesses, payment or messaging providers, or the
              public; to investigate abuse; to comply with law; or when these Terms
              are violated.
            </P>
            <P>
              Termination does not cancel amounts already due, completed transactions,
              applicable payment obligations, or provisions that by their nature
              should survive termination. We may retain records where required for
              legal, security, fraud-prevention, financial, or dispute-resolution
              purposes, as described in the{' '}
              <Link href="/privacy" className="text-indigo-600 hover:underline">
                Privacy Policy
              </Link>.
            </P>
          </Section>

          <Section id="changes" title="Changes to These Terms">
            <P>
              We may update these Terms as the Platform changes or as required by law.
              We will update the effective date above and may provide additional notice
              for material changes. Your continued use of the Platform after updated
              Terms become effective means you accept the revised Terms.
            </P>
            <P>
              If you do not agree to a material change, stop using the Platform and,
              for a business account, contact us about closing the account.
            </P>
          </Section>

          <Section id="contact" title="Contact Us">
            <P>Questions about these Terms or the Platform may be sent to:</P>
            <div className="mt-3 inline-block bg-slate-100 rounded-lg px-5 py-4 text-slate-700 text-sm leading-relaxed">
              <strong>{APP_NAME}</strong><br />
              Terms inquiries:{' '}
              <a href={`mailto:${CONTACT_EMAIL}`} className="text-indigo-600 hover:underline">
                {CONTACT_EMAIL}
              </a>
            </div>
            <P>
              These Terms are intended to describe the Platform’s current rules in
              plain language. They are not legal advice for your business or a
              substitute for advice from a qualified attorney about your specific
              circumstances.
            </P>
          </Section>
        </main>
      </div>

      <footer className="border-t border-slate-200 bg-white mt-4">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-wrap gap-4 items-center justify-between text-sm text-slate-400">
          <span>© {new Date().getFullYear()} {APP_NAME}. All rights reserved.</span>
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-indigo-600 transition-colors">
              Privacy Policy
            </Link>
            <span>Effective {EFFECTIVE_DATE}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}