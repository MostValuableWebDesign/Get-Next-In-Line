import { describe, expect, it } from "vitest";
import { serializeRequestForLog } from "./app";

describe("request log serialization", () => {
  it("does not retain a tracking capability in the logged URL", () => {
    const capability = "Mbww8SsjOLrN7jiUp1q4Z4n06pGOxhcOe337VPrXW-M";
    const serialized = serializeRequestForLog({
      id: 1,
      method: "GET",
      url: `/api/public/check-in/apex-digital/status/5612#${capability}?ignored=true`,
    });

    expect(serialized).toEqual({
      id: 1,
      method: "GET",
      url: "/api/public/check-in/apex-digital/status/5612",
    });
    expect(JSON.stringify(serialized)).not.toContain(capability);
  });
});