import { describe, expect, it } from "vitest";
import {
  getWorkforceProvider,
  listWorkforceProviders,
  UnknownWorkforceProviderError,
} from "./providerRegistry";
import type { NormalizedEmployee } from "./types";

describe("workforce provider registry", () => {
  it("exposes only providers with a real connection path", () => {
    expect(listWorkforceProviders().map((provider) => provider.providerId)).toEqual(["gusto"]);
  });

  it("resolves Gusto through the provider abstraction", () => {
    expect(getWorkforceProvider("gusto").definition.providerId).toBe("gusto");
  });

  it("fails safely for an unknown provider", () => {
    expect(() => getWorkforceProvider("unknown")).toThrow(UnknownWorkforceProviderError);
  });

  it("keeps normalized employees provider-neutral", () => {
    const employee: NormalizedEmployee = {
      providerId: "gusto",
      externalId: "employee-1",
      firstName: "Ada",
      lastName: "Lovelace",
      displayName: "Ada Lovelace",
      email: null,
      phone: null,
      employmentType: "employee",
      employmentStatus: "active",
      jobTitle: null,
      hireDate: null,
      terminationDate: null,
      rawUpdatedAt: null,
    };

    expect(employee).not.toHaveProperty("gustoId");
    expect(employee).not.toHaveProperty("companyUuid");
    expect(employee).not.toHaveProperty("providerResponse");
  });

  it("keeps optional Gusto capabilities disabled until verified", () => {
    const [gusto] = listWorkforceProviders();
    expect(gusto.preferred).toBe(true);
    expect(gusto.capabilities).toEqual([
      "employees",
      "payroll",
      "compensation",
    ]);
    expect(gusto.capabilities).not.toContain("onboarding");
    expect(gusto.capabilities).not.toContain("contractors");
    expect(gusto.capabilities).not.toContain("benefits");
    expect(gusto.capabilities).not.toContain("tax_documents");
    expect(gusto.capabilities).not.toContain("time_tracking");
    expect(gusto.capabilities).not.toContain("time_off");
    expect(gusto.capabilities).not.toContain("scheduling");
  });
});