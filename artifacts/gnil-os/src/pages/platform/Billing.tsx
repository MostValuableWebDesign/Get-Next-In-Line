import { useGetBillingSummary } from "@workspace/api-client-react";
import { Receipt, DollarSign, ArrowUpRight, TrendingUp } from "lucide-react";
import { Link } from "wouter";

export default function PlatformBilling() {
  const { data: summary, isLoading } = useGetBillingSummary();

  if (isLoading) {
    return <div className="text-zinc-500 animate-pulse font-mono text-sm">Loading financial data...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Platform Billing</h2>
        <p className="text-sm text-zinc-400 mt-1">Cross-installation revenue and module subscription summary.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col gap-2">
          <div className="flex items-center text-zinc-400 mb-2 gap-2">
            <DollarSign className="size-4" />
            <h3 className="text-sm font-medium">Total MRR</h3>
          </div>
          <div className="text-4xl font-semibold text-white tracking-tight">
            ${((summary?.totalMrr ?? 0)).toFixed(2)}
          </div>
          <div className="text-xs text-zinc-500 mt-1">Monthly Recurring Revenue</div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col gap-2">
          <div className="flex items-center text-zinc-400 mb-2 gap-2">
            <Receipt className="size-4" />
            <h3 className="text-sm font-medium">Billed Tenants</h3>
          </div>
          <div className="text-4xl font-semibold text-white tracking-tight">
            {summary?.topTenants.length ?? 0}
          </div>
          <div className="text-xs text-zinc-500 mt-1">Active Accounts</div>
        </div>
        
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col gap-2">
          <div className="flex items-center text-zinc-400 mb-2 gap-2">
            <TrendingUp className="size-4" />
            <h3 className="text-sm font-medium">Yield per Tenant</h3>
          </div>
          <div className="text-4xl font-semibold text-white tracking-tight">
            ${summary?.topTenants.length ? ((summary.totalMrr ?? 0) / summary.topTenants.length).toFixed(2) : "0.00"}
          </div>
          <div className="text-xs text-zinc-500 mt-1">Average MRR</div>
        </div>
      </div>

      <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden mt-8">
        <div className="p-5 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Installation Billing Ledger</h2>
        </div>
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-zinc-950 text-zinc-400 border-b border-zinc-800">
            <tr>
              <th className="px-6 py-4 font-medium">Installation</th>
              <th className="px-6 py-4 font-medium text-right">MRR</th>
              <th className="px-6 py-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {summary?.topTenants.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-6 py-8 text-center text-zinc-500">No billing data found.</td>
              </tr>
            ) : (
              summary?.topTenants.map((t) => (
                <tr key={t.tenantId} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-medium text-white">{t.brandName}</div>
                    <div className="text-xs text-zinc-500 font-mono mt-1">ID: {t.tenantId}</div>
                  </td>
                  <td className="px-6 py-4 text-right font-mono text-zinc-300">
                    ${(t.mrr).toFixed(2)}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link href={`/platform/tenants/${t.tenantId}`} className="inline-flex items-center text-teal-500 hover:text-teal-400 transition-colors">
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
