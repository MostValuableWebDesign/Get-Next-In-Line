import { describe, expect, it } from "vitest";
import { listWorkforceProviders } from "./providerRegistry";

describe("workforce provider registry", () => {
  it("exposes only providers with a real connection path", () => {
    expect(listWorkforceProviders().map((provider) => provider.providerId)).toEqual(["gusto"]);
  });

  it("keeps optional Gusto capabilities disabled until verified", () => {
    const [gusto] = listWorkforceProviders();
    expect(gusto.preferred).toBe(true);
    expect(gusto.capabilities).toEqual([
      "employees",
      "contractors",
      "payroll",
      "compensation",
      "onboarding",
    ]);
    expect(gusto.capabilities).not.toContain("benefits");
    expect(gusto.capabilities).not.toContain("tax_documents");
    expect(gusto.capabilities).not.toContain("time_tracking");
    expect(gusto.capabilities).not.toContain("time_off");
    expect(gusto.capabilities).not.toContain("scheduling");
  });
});