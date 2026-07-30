/**
 * Connector-proxy Twilio transport in lib/sms.ts.
 *
 * Guards three contracts the live SMS path depends on:
 *  - deliverSms proxy-mode outcomes: sent / failed (non-2xx, thrown fetch
 *    error, Twilio status "failed"/"undelivered") / invalid recipient — a
 *    live-mode failure must NEVER downgrade to "simulated";
 *  - getTwilioProxy single-flight: concurrent refreshes share one discovery
 *    fetch, and a transient failed refresh never clobbers a working proxy;
 *  - the NODE_ENV=test gate: the proxy transport stays disabled under test
 *    so integration suites can never send real texts.
 *
 * The connectors SDK, DB, and logger are all mocked; no network calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mutable per-test implementation of ReplitConnectors#proxy.
const proxyMock = vi.fn<
  (connector: string, path: string, init?: unknown) => Promise<unknown>
>();

vi.mock("@replit/connectors-sdk", () => ({
  ReplitConnectors: class {
    proxy(connector: string, path: string, init?: unknown) {
      return proxyMock(connector, path, init);
    }
  },
}));

// sms.ts reads sos_settings for a From-number override; return no rows so
// the env From number is used. (Any @workspace/db mock must export `pool`.)
vi.mock("@workspace/db", () => ({
  pool: undefined,
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: async () => [] }),
        }),
      }),
    }),
  },
  sosSettingsTable: { tenantId: "tenant_id", id: "id" },
}));
vi.mock("drizzle-orm", () => ({ eq: () => ({}), isNull: () => ({}) }));
vi.mock("twilio", () => ({ default: vi.fn() }));
vi.mock("../logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../inboundSms", () => ({
  getStatusCallbackUrl: () => null,
  getInboundWebhookUrl: () => null,
}));

type Sms = typeof import("../sms");

const SAVED_ENV_KEYS = [
  "NODE_ENV",
  "REPLIT_CONNECTORS_HOSTNAME",
  "REPL_IDENTITY",
  "WEB_REPL_RENEWAL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PHONE_NUMBER",
] as const;
let savedEnv: Record<string, string | undefined>;

function jsonRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

/** Standard happy-path account discovery response. */
function accountsOk() {
  return jsonRes(200, { accounts: [{ sid: "ACtest" }] });
}

/** Fresh import of sms.ts so its module-level caches start empty. */
async function freshSms(): Promise<Sms> {
  vi.resetModules();
  return await import("../sms");
}

beforeEach(() => {
  savedEnv = Object.fromEntries(SAVED_ENV_KEYS.map((k) => [k, process.env[k]]));
  // Proxy-only environment: connector hostname present, no raw creds
  // anywhere (env or identity token for the legacy creds fetch).
  process.env.REPLIT_CONNECTORS_HOSTNAME = "connectors.test.invalid";
  delete process.env.REPL_IDENTITY;
  delete process.env.WEB_REPL_RENEWAL;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_PHONE_NUMBER = "+15550001111";
  // Most tests exercise the live proxy path, which is gated off under test.
  process.env.NODE_ENV = "development";
  proxyMock.mockReset();
});

afterEach(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

describe("NODE_ENV=test gate", () => {
  it("keeps the proxy transport disabled under test — simulated, no proxy calls", async () => {
    process.env.NODE_ENV = "test";
    const sms = await freshSms();
    const res = await sms.deliverSms("+15551234567", "hello");
    expect(res.status).toBe("simulated");
    expect(proxyMock).not.toHaveBeenCalled();
  });
});

describe("deliverSms via connector proxy", () => {
  it("reports sent with the provider sid on a successful send", async () => {
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) return accountsOk();
      return jsonRes(201, { sid: "SM123", status: "queued" });
    });
    const sms = await freshSms();
    const res = await sms.deliverSms("+15551234567", "hello");
    expect(res.status).toBe("sent");
    expect(res.providerSid).toBe("SM123");
    expect(res.toNumber).toBe("+15551234567");
    expect(res.errorCode).toBeNull();
    // The send hit the Messages endpoint under the discovered account.
    const sendCall = proxyMock.mock.calls.find(([, p]) =>
      p.includes("Messages.json"),
    );
    expect(sendCall?.[1]).toBe("/2010-04-01/Accounts/ACtest/Messages.json");
  });

  it("maps a non-2xx Twilio response to failed (never simulated)", async () => {
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) return accountsOk();
      return jsonRes(400, { code: 21211, message: "Invalid 'To' number" });
    });
    const sms = await freshSms();
    const res = await sms.deliverSms("+15551234567", "hello");
    expect(res.status).toBe("failed");
    expect(res.errorCode).toBe("21211");
    expect(res.errorMessage).toBe("Invalid 'To' number");
  });

  it("falls back to the HTTP status as errorCode when the error body is unreadable", async () => {
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) return accountsOk();
      return {
        ok: false,
        status: 502,
        json: async () => {
          throw new Error("not json");
        },
      };
    });
    const sms = await freshSms();
    const res = await sms.deliverSms("+15551234567", "hello");
    expect(res.status).toBe("failed");
    expect(res.errorCode).toBe("502");
  });

  it.each(["failed", "undelivered"] as const)(
    "maps an accepted message with Twilio status %s to failed",
    async (twStatus) => {
      proxyMock.mockImplementation(async (_c, path) => {
        if (path.includes("Accounts.json")) return accountsOk();
        return jsonRes(201, {
          sid: "SM456",
          status: twStatus,
          error_code: 30006,
          error_message: "Landline or unreachable carrier",
        });
      });
      const sms = await freshSms();
      const res = await sms.deliverSms("+15551234567", "hello");
      expect(res.status).toBe("failed");
      expect(res.providerSid).toBe("SM456");
      expect(res.errorCode).toBe("30006");
      expect(res.errorMessage).toBe("Landline or unreachable carrier");
    },
  );

  it("maps a thrown fetch error to failed (never simulated)", async () => {
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) return accountsOk();
      throw new Error("socket hang up");
    });
    const sms = await freshSms();
    const res = await sms.deliverSms("+15551234567", "hello");
    expect(res.status).toBe("failed");
    expect(res.errorMessage).toBe("socket hang up");
  });

  it("flags an invalid recipient as failed while the proxy transport is live", async () => {
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) return accountsOk();
      throw new Error("should not attempt a send for an invalid recipient");
    });
    const sms = await freshSms();
    const res = await sms.deliverSms("not-a-number", "hello");
    expect(res.status).toBe("failed");
    expect(res.errorCode).toBe("invalid_number");
    expect(res.toNumber).toBeNull();
    expect(
      proxyMock.mock.calls.filter(([, p]) => p.includes("Messages.json")),
    ).toHaveLength(0);
  });
});

describe("getTwilioProxy caching", () => {
  it("shares one discovery fetch across concurrent callers (single-flight)", async () => {
    let resolveAccounts!: (v: unknown) => void;
    const pending = new Promise((r) => (resolveAccounts = r));
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) return pending;
      return jsonRes(201, { sid: "SM789", status: "queued" });
    });
    const sms = await freshSms();
    const p1 = sms.deliverSms("+15551234567", "one");
    const p2 = sms.deliverSms("+15557654321", "two");
    // Let both callers reach the proxy refresh before resolving discovery.
    await new Promise((r) => setImmediate(r));
    resolveAccounts(accountsOk());
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.status).toBe("sent");
    expect(r2.status).toBe("sent");
    const discoveryCalls = proxyMock.mock.calls.filter(([, p]) =>
      p.includes("Accounts.json"),
    );
    expect(discoveryCalls).toHaveLength(1);
  });

  it("keeps a working proxy when a later refresh transiently fails", async () => {
    let discoveryHealthy = true;
    proxyMock.mockImplementation(async (_c, path) => {
      if (path.includes("Accounts.json")) {
        return discoveryHealthy ? accountsOk() : jsonRes(503, {});
      }
      return jsonRes(201, { sid: "SMok", status: "queued" });
    });
    let now = 1_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    const sms = await freshSms();
    expect((await sms.deliverSms("+15551234567", "first")).status).toBe("sent");

    // Expire the cache TTL, then make the refresh fail.
    now += 61_000;
    discoveryHealthy = false;
    const res = await sms.deliverSms("+15551234567", "second");
    // The failed refresh must not regress the valid cached proxy to null:
    // the send still goes out through the previously working proxy.
    expect(res.status).toBe("sent");
    expect(res.providerSid).toBe("SMok");
    expect(
      proxyMock.mock.calls.filter(([, p]) => p.includes("Accounts.json")),
    ).toHaveLength(2);
  });
});
