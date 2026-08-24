---
name: Public SMS consent evidence
description: Rules for capturing and respecting consent from public booking and queue check-in surfaces.
---

Public SMS consent evidence is captured for every **successful** public CTA
submission with an explicitly checked SMS box, including a customer who was
already opted in. The immutable record snapshots the business/program,
disclosure version and text, timestamp, source, IP address, and user agent.

**Why:** A mutable opt-in flag can predate the public CTA and cannot prove that
the customer saw the precise disclosure. An existing opt-out may be a STOP
revocation; letting an anonymous browser set that flag back to true could
override the handset owner's choice.

**How to apply:** Treat an unchecked public box as no change. When an
existing customer is opted out and a public form requests SMS, reject the
request and direct the customer to reply START from the phone. Only the
verified inbound SMS path may restore opt-in after a STOP. Add an evidence
record only after all validation and duplicate checks pass, so it corresponds
to an accepted public action.