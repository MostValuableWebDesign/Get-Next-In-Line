# Twilio A2P digital check-in CTA

Use a live, active business's public digital check-in URL in the campaign's
**Message Flow / Call-to-Action** field:

```text
https://www.getnextinline.com/check-in/<business-slug>
```

Replace `<business-slug>` with the active business's configured public slug
before submitting. Do not submit the placeholder URL or a staff-only SOS link.

## Reviewer flow

1. Open the business's public digital check-in URL. No account or staff login is
   required.
2. Select a service, enter a customer name and mobile number, and optionally
   set the guest count.
3. Review the optional, **unchecked by default** “Optional SMS queue updates”
   checkbox before selecting it.
4. The check-in form discloses that messages are transactional queue updates,
   names the business and Get Next In Line, states that message frequency varies
   and message/data rates may apply, and explains **STOP** and **HELP**.
5. The same screen links directly to the privacy policy and terms:
   - https://www.getnextinline.com/privacy
   - https://www.getnextinline.com/terms
6. Submit the form. The customer is added to the business's live staff queue.
   A checked SMS box records affirmative transactional-SMS consent; leaving it
   unchecked still completes the digital queue check-in without consent.

## Accurate campaign wording

> Customers opt in on the public digital check-in page for the business they
> are visiting. They enter their name and mobile number, select a service, and
> may optionally select an unchecked SMS consent checkbox to receive
> transactional messages about their check-in and queue status. Consent is not
> a condition of purchase. Message frequency varies; message and data rates may
> apply. Customers can reply STOP to opt out and HELP for assistance.

The program sends transactional messages only: queue updates, check-in
confirmations, appointment or visit notifications, and waitlist availability
alerts. It does not use this opt-in for marketing or promotional messaging.