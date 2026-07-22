import { describe, it, expect } from "vitest";
import { parseInboundKeyword } from "../inboundSms";
import { normalizeToE164 } from "../sms";

describe("parseInboundKeyword", () => {
  it("matches YES case-insensitively with whitespace and punctuation", () => {
    for (const body of ["YES", "yes", " Yes ", "YES!", "  y ", "Yeah", "yep.", '"YES"']) {
      expect(parseInboundKeyword(body), body).toBe("yes");
    }
  });

  it("matches Twilio-standard opt-out keywords", () => {
    for (const body of ["STOP", "stop", " Stop. ", "UNSUBSCRIBE", "Cancel", "END", "quit"]) {
      expect(parseInboundKeyword(body), body).toBe("stop");
    }
  });

  it("matches opt-in keywords", () => {
    for (const body of ["START", "start", " Unstop ", "SUBSCRIBE"]) {
      expect(parseInboundKeyword(body), body).toBe("start");
    }
  });

  it("returns none for non-keyword, ambiguous, or empty messages", () => {
    for (const body of [
      "",
      "   ",
      null,
      undefined,
      "yes please book me",
      "what time is my appointment?",
      "stop it, that tickles",
      "1",
      "no",
    ]) {
      expect(parseInboundKeyword(body), String(body)).toBe("none");
    }
  });
});

describe("normalizeToE164 (inbound matching)", () => {
  it("matches differently formatted versions of the same number", () => {
    expect(normalizeToE164("(555) 123-4567")).toBe("+15551234567");
    expect(normalizeToE164("+1 555 123 4567")).toBe("+15551234567");
    expect(normalizeToE164("15551234567")).toBe("+15551234567");
  });
  it("rejects garbage", () => {
    expect(normalizeToE164("hello")).toBeNull();
    expect(normalizeToE164("")).toBeNull();
  });
});
