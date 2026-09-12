import { describe, expect, it } from "vitest";
import { formatMoneyExact } from "./formatMoneyExact";

describe("formatMoneyExact", () => {
  it("formats normal values", () => {
    expect(formatMoneyExact(123456, "USD")).toBe("$1,234.56");
    expect(formatMoneyExact("123456", "USD")).toBe("$1,234.56");
  });

  it("handles negative values", () => {
    expect(formatMoneyExact("-123456", "USD")).toBe("-$1,234.56");
  });

  it("handles small values (under 1 dollar)", () => {
    expect(formatMoneyExact("99", "USD")).toBe("$0.99");
    expect(formatMoneyExact("5", "USD")).toBe("$0.05");
    expect(formatMoneyExact("-5", "USD")).toBe("-$0.05");
    expect(formatMoneyExact("0", "USD")).toBe("$0.00");
  });

  it("handles non-USD currencies", () => {
    expect(formatMoneyExact("123456", "EUR")).toBe("€1,234.56");
    expect(formatMoneyExact("123456", "GBP")).toBe("£1,234.56");
    expect(formatMoneyExact("123456", "JPY")).toBe("¥1,234.56");
  });

  it("formats exact > MAX_SAFE_INTEGER cent values (regression test)", () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2
    // If parsed as a number, it will lose precision and end with 992
    const giantAmount = "900719925474099312"; 
    expect(formatMoneyExact(giantAmount, "USD")).toBe("$9,007,199,254,740,993.12");
  });

  it("rejects non-numeric inputs", () => {
    expect(formatMoneyExact("12.34", "USD")).toBe("—");
    expect(formatMoneyExact("abc", "USD")).toBe("—");
    expect(formatMoneyExact(null, "USD")).toBe("—");
    expect(formatMoneyExact(undefined, "USD")).toBe("—");
  });
});