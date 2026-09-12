import { describe, expect, it } from "vitest";
import {
  decimalDollarsToCents,
  normalizeGustoCompensation,
  normalizeGustoPayroll,
} from "./gustoProvider";

describe("Gusto read-only payroll and compensation normalization", () => {
  it("converts decimal dollars to cents without floating point rounding", () => {
    expect(decimalDollarsToCents("100.05")).toBe("10005");
    expect(decimalDollarsToCents("0")).toBe("0");
    expect(() => decimalDollarsToCents("10.125")).toThrow();
  });

  it("uses only the official processed boolean for payroll status", () => {
    expect(
      normalizeGustoPayroll({
        payroll_uuid: "payroll-1",
        pay_period: { start_date: "2026-01-01", end_date: "2026-01-14" },
        check_date: "2026-01-16",
        processed: true,
        processed_date: "2026-01-15",
        calculated_at: "2026-01-15T12:00:00Z",
        totals: { gross_pay: "1000.25", net_pay: "800.00" },
      }),
    ).toMatchObject({
      externalId: "payroll-1",
      status: "processed",
      processed: true,
      grossPayCents: "100025",
      netPayCents: "80000",
    });
    expect(
      normalizeGustoPayroll({
        uuid: "payroll-2",
        pay_period: { start_date: "2026-01-01", end_date: "2026-01-14" },
        processed: false,
      }).status,
    ).toBe("draft");
  });

  it("preserves compensation units and never annualizes non-year rates", () => {
    expect(
      normalizeGustoCompensation(
        {
          uuid: "comp-1",
          job_uuid: "job-1",
          rate: "25.50",
          payment_unit: "Hour",
          effective_date: "2026-01-01",
        },
        "employee-1",
      ),
    ).toMatchObject({
      amountCents: "2550",
      interval: "hourly",
      externalEmployeeId: "employee-1",
      externalJobId: "job-1",
    });
    expect(() =>
      normalizeGustoCompensation(
        {
          uuid: "comp-2",
          job_uuid: "job-2",
          rate: "100",
          payment_unit: "Unknown",
          effective_date: "2026-01-01",
        },
        "employee-1",
      ),
    ).toThrow();
  });
});