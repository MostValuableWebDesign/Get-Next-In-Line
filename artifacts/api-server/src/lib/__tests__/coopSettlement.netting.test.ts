import { describe, it, expect } from "vitest";
import { netObligations } from "../coopSettlement";

const names = new Map<number, string>([
  [1, "Alpha"],
  [2, "Bravo"],
  [3, "Charlie"],
]);

const entry = (debtor: number, creditor: number, amount: string) => ({
  debtorTenantId: debtor,
  creditorTenantId: creditor,
  amount,
});

describe("netObligations — pairwise netting math", () => {
  it("nets a two-way pair to a single antisymmetric balance", () => {
    const stmts = netObligations(
      [entry(1, 2, "10.00"), entry(2, 1, "4.00"), entry(1, 2, "1.50")],
      names,
    );
    expect(stmts).toHaveLength(2);
    const a = stmts.find((s) => s.tenantId === 1)!;
    const b = stmts.find((s) => s.tenantId === 2)!;
    expect(a.totalOwedToOthers).toBe(11.5);
    expect(a.totalOwedByOthers).toBe(4);
    expect(a.netAmount).toBe(-7.5);
    expect(b.netAmount).toBe(7.5);
    expect(a.lines[0]).toMatchObject({
      counterpartyTenantId: 2,
      counterpartyName: "Bravo",
      owedToCounterparty: 11.5,
      owedByCounterparty: 4,
      net: -7.5,
    });
  });

  it("handles three-party webs; net amounts always sum to zero", () => {
    const stmts = netObligations(
      [
        entry(1, 2, "10.00"),
        entry(2, 3, "10.00"),
        entry(3, 1, "10.00"),
        entry(2, 1, "2.25"),
      ],
      names,
    );
    expect(stmts).toHaveLength(3);
    const total = stmts.reduce((s, x) => s + Math.round(x.netAmount * 100), 0);
    expect(total).toBe(0);
    const a = stmts.find((s) => s.tenantId === 1)!;
    // Alpha: owes 10 to Bravo, is owed 2.25 by Bravo and 10 by Charlie.
    expect(a.netAmount).toBeCloseTo(2.25, 2);
    expect(a.lines).toHaveLength(2);
  });

  it("uses exact cents math (no float drift on 0.1-style amounts)", () => {
    const stmts = netObligations(
      [entry(1, 2, "0.10"), entry(1, 2, "0.20"), entry(2, 1, "0.30")],
      names,
    );
    expect(stmts.find((s) => s.tenantId === 1)!.netAmount).toBe(0);
    expect(stmts.find((s) => s.tenantId === 2)!.netAmount).toBe(0);
  });

  it("returns an empty list for no entries", () => {
    expect(netObligations([], names)).toEqual([]);
  });

  it("falls back to a placeholder name for unknown tenants", () => {
    const stmts = netObligations([entry(1, 99, "5.00")], names);
    const a = stmts.find((s) => s.tenantId === 1)!;
    expect(a.lines[0].counterpartyName).toBe("Business #99");
  });
});
