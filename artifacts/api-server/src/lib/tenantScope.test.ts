import { describe, expect, it } from "vitest";
import {
  AppBusinessConfigurationError,
  resolveSingleActiveBusiness,
} from "./tenantScope";

const business = (id: number) => ({
  id,
  brandName: `Business ${id}`,
  status: "active",
});

describe("resolveSingleActiveBusiness", () => {
  it("rejects a deployment with no active business", () => {
    expect(() => resolveSingleActiveBusiness([])).toThrow(AppBusinessConfigurationError);
  });

  it("returns the sole active business", () => {
    expect(resolveSingleActiveBusiness([business(7)])).toEqual(business(7));
  });

  it("rejects a deployment with multiple active businesses", () => {
    expect(() => resolveSingleActiveBusiness([business(7), business(8)])).toThrow(
      "multiple active businesses",
    );
  });
});