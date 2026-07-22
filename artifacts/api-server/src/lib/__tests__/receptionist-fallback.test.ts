/**
 * Deterministic fallback parser for the AI receptionist (used when the AI
 * proxy is unconfigured or fails). Guards:
 *  - intent detection: booking, reschedule, question, other;
 *  - service keywords stay industry-neutral (no business-specific bias);
 *  - relative-time parsing for "today" / "tomorrow";
 *  - summary truncation and usedAi flag.
 */
import { describe, it, expect } from "vitest";
import { fallbackParse, parseServiceNames } from "../receptionist";

describe("fallbackParse — intent detection", () => {
  it("detects booking intent", () => {
    expect(fallbackParse("I'd like to book an appointment").intent).toBe(
      "book_appointment",
    );
    expect(fallbackParse("Can I schedule a visit?").intent).toBe(
      "book_appointment",
    );
    expect(fallbackParse("Do you have an opening this week").intent).toBe(
      "book_appointment",
    );
  });

  it("detects reschedule intent, taking priority over booking words", () => {
    expect(fallbackParse("I need to reschedule my appointment").intent).toBe(
      "reschedule",
    );
    expect(fallbackParse("Please change my booking time").intent).toBe(
      "reschedule",
    );
  });

  it("detects questions", () => {
    expect(fallbackParse("How much does it cost?").intent).toBe("question");
    expect(fallbackParse("when are you open").intent).toBe("question");
  });

  it("falls back to other for unrecognized inquiries", () => {
    expect(fallbackParse("Hello there").intent).toBe("other");
  });
});

describe("fallbackParse — service keywords are industry-neutral", () => {
  const NEUTRAL = [
    "consultation",
    "appointment",
    "checkup",
    "estimate",
    "cleaning",
    "repair",
    "maintenance",
    "service",
    "reservation",
    "follow-up",
  ];

  it.each(NEUTRAL)("recognizes the neutral keyword %s", (keyword) => {
    expect(fallbackParse(`I need a ${keyword} soon`).serviceType).toBe(keyword);
  });

  it("does not match industry-specific terms (no bias in the fallback)", () => {
    for (const biased of ["haircut", "root canal", "oil change", "botox"]) {
      expect(fallbackParse(`I want a ${biased}`).serviceType).toBeNull();
    }
  });

  it("returns null serviceType when nothing matches", () => {
    expect(fallbackParse("just calling to say hi").serviceType).toBeNull();
  });
});

describe("fallbackParse — business-defined service names", () => {
  it("matches a configured service name case-insensitively", () => {
    expect(
      fallbackParse("I want a Haircut tomorrow", ["haircut", "color"]).serviceType,
    ).toBe("haircut");
    expect(
      fallbackParse("need an oil change asap", ["Oil Change", "brake service"])
        .serviceType,
    ).toBe("Oil Change");
  });

  it("prefers business service names over generic keywords", () => {
    expect(
      fallbackParse("book a cleaning appointment", ["appointment"]).serviceType,
    ).toBe("appointment");
  });

  it("falls back to generic keywords when no business service matches", () => {
    expect(
      fallbackParse("I need a repair", ["haircut", "color"]).serviceType,
    ).toBe("repair");
  });
});

describe("parseServiceNames", () => {
  it("splits a comma-separated string, trimming whitespace and empties", () => {
    expect(parseServiceNames("haircut, color , , blowout")).toEqual([
      "haircut",
      "color",
      "blowout",
    ]);
  });

  it("returns an empty list for null/undefined/empty input", () => {
    expect(parseServiceNames(null)).toEqual([]);
    expect(parseServiceNames(undefined)).toEqual([]);
    expect(parseServiceNames("")).toEqual([]);
  });
});

describe("fallbackParse — relative time parsing", () => {
  it("parses 'tomorrow' as 10:00 local the next day", () => {
    const before = new Date();
    const result = fallbackParse("Can I come in tomorrow?");
    expect(result.requestedTime).not.toBeNull();
    const t = new Date(result.requestedTime!);
    const expected = new Date(before);
    expected.setDate(expected.getDate() + 1);
    expect(t.getFullYear()).toBe(expected.getFullYear());
    expect(t.getMonth()).toBe(expected.getMonth());
    expect(t.getDate()).toBe(expected.getDate());
    expect(t.getHours()).toBe(10);
    expect(t.getMinutes()).toBe(0);
  });

  it("parses 'today' as now+2h capped at 17:00, same day", () => {
    const now = new Date();
    const result = fallbackParse("any slot today?");
    expect(result.requestedTime).not.toBeNull();
    const t = new Date(result.requestedTime!);
    expect(t.getDate()).toBe(now.getDate());
    expect(t.getHours()).toBe(Math.min(now.getHours() + 2, 17));
    expect(t.getMinutes()).toBe(0);
  });

  it("leaves requestedTime null when no relative time appears", () => {
    expect(fallbackParse("book me an appointment").requestedTime).toBeNull();
  });
});

describe("fallbackParse — output shape", () => {
  it("never claims AI was used", () => {
    expect(fallbackParse("book tomorrow").usedAi).toBe(false);
  });

  it("truncates the summary to 300 chars", () => {
    const long = "a".repeat(500);
    expect(fallbackParse(long).summary).toHaveLength(300);
  });
});
