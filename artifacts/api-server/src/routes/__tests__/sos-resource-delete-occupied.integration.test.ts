import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// ---------------------------------------------------------------------------
// DELETE /api/sos/resources/:id must refuse (409) to delete a resource that
// still has a customer in it — occupied status or an active visit assignment —
// so a direct API call (or a stale UI) can't orphan a mid-visit assignment.
//
// Isolation: one throwaway tenant per run (rows cascade on tenant delete),
// unique per-run names.
// ---------------------------------------------------------------------------

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "test-admin-password";
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret";
delete process.env.REPLIT_DEV_DOMAIN; // plain-HTTP session cookies in supertest

const RUN = `resdel-${Date.now()}-${process.pid}`;

let agent: ReturnType<typeof request.agent>;
let tenantId: number;

const asTenant = () => ({ "x-tenant-id": String(tenantId) });

beforeAll(async () => {
  const app = (await import("../../app")).default;
  agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ password: process.env.ADMIN_PASSWORD })
    .expect(200);

  const [tenant] = await db
    .insert(tenantsTable)
    .values({ brandName: `ResDel ${RUN}`, subdomain: RUN, status: "active" })
    .returning({ id: tenantsTable.id });
  tenantId = tenant.id;
});

afterAll(async () => {
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
});

async function createResource(name: string): Promise<number> {
  const res = await agent
    .post("/api/sos/resources")
    .set(asTenant())
    .send({ name, resourceType: "Station" })
    .expect(201);
  return res.body.id;
}

describe("deleting an occupied resource is rejected", () => {
  it("returns 409 when the resource status is occupied", async () => {
    const id = await createResource(`Occupied Station ${RUN}`);
    await agent
      .patch(`/api/sos/resources/${id}`)
      .set(asTenant())
      .send({ status: "occupied" })
      .expect(200);

    const res = await agent.delete(`/api/sos/resources/${id}`).set(asTenant());
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/occupied/i);

    // Still present.
    const list = await agent.get("/api/sos/resources").set(asTenant()).expect(200);
    expect(list.body.some((r: { id: number }) => r.id === id)).toBe(true);
  });

  it("returns 409 when the resource has an active visit assigned", async () => {
    const id = await createResource(`Assigned Station ${RUN}`);

    // Check in a customer and assign them to the resource.
    const cust = await agent
      .post("/api/sos/customers")
      .set(asTenant())
      .send({ name: `Visitor ${RUN}`, phone: `+1555${String(Date.now()).slice(-7)}`, smsOptIn: false })
      .expect(201);
    const visit = await agent
      .post("/api/sos/visits")
      .set(asTenant())
      .send({ customerId: cust.body.id, serviceType: `Svc ${RUN}`, partySize: 1 })
      .expect(201);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant())
      .send({ action: "queue" })
      .expect(200);
    await agent
      .post(`/api/sos/visits/${visit.body.id}/advance`)
      .set(asTenant())
      .send({ action: "assign", resourceId: id })
      .expect(200);

    const res = await agent.delete(`/api/sos/resources/${id}`).set(asTenant());
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/occupied/i);
  });

  it("still deletes a free resource (204) and 404s on a missing one", async () => {
    const id = await createResource(`Free Station ${RUN}`);
    await agent.delete(`/api/sos/resources/${id}`).set(asTenant()).expect(204);
    await agent.delete(`/api/sos/resources/${id}`).set(asTenant()).expect(404);
  });
});
