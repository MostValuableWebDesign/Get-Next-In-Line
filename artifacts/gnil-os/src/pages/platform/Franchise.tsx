import { useListFranchiseOrgs, useGetFranchiseRollup } from "@workspace/api-client-react";
import { Users, LayoutTemplate, Briefcase, Map, ArrowUpRight, ShieldCheck } from "lucide-react";
import { Link } from "wouter";

export default function PlatformFranchise() {
  const { data: orgs, isLoading: isLoadingOrgs } = useListFranchiseOrgs();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Franchise Operations</h2>
        <p className="text-sm text-zinc-400 mt-1">Cross-organization rollup and template enforcement visibility.</p>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
            <Users className="size-4 text-zinc-400" /> Managed Organizations
          </h2>
        </div>
        <div className="divide-y divide-zinc-800">
          {isLoadingOrgs ? (
            <div className="p-8 text-center text-zinc-500 font-mono text-sm animate-pulse">Loading organizations...</div>
          ) : orgs?.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <ShieldCheck className="size-10 text-zinc-600 mb-4" />
              <p className="text-zinc-400">No franchise organizations registered.</p>
            </div>
          ) : (
            orgs?.map((org) => (
              <div key={org.id} className="p-5 flex flex-col lg:flex-row gap-6 justify-between hover:bg-zinc-800/30 transition-colors">
                <div className="flex gap-4">
                  <div className="size-12 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shrink-0">
                    <Briefcase className="size-6 text-teal-500" />
                  </div>
                  <div>
                    <h3 className="text-lg font-medium text-white mb-1">{org.name}</h3>
                    <div className="flex items-center gap-4 mt-3">
                      <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-500">
                        <Map className="size-3" />
                        Autonomy: {org.autonomyPolicy}
                      </div>
                    </div>
                  </div>
                </div>
                
                <div className="lg:w-72 bg-zinc-950 border border-zinc-800 rounded-lg p-4 shrink-0 flex flex-col justify-center">
                  <FranchiseRollupSummary orgId={org.id} />
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function FranchiseRollupSummary({ orgId }: { orgId: number }) {
  const { data: rollup, isLoading } = useGetFranchiseRollup(orgId, { query: { enabled: !!orgId, queryKey: ["franchise-rollup", orgId] } });

  if (isLoading) return <div className="text-xs text-zinc-500 font-mono animate-pulse">Computing rollup...</div>;
  if (!rollup) return <div className="text-xs text-zinc-500 font-mono">No data</div>;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Network Influenced Revenue</p>
        <p className="text-lg font-semibold text-white tracking-tight">${(rollup.totals.revenueInfluenced / 100).toFixed(2)}</p>
      </div>
      <div className="flex gap-4">
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">Claims</p>
          <p className="text-sm text-zinc-300 font-mono">{rollup.totals.claims}</p>
        </div>
        <div>
          <p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-0.5">Redemptions</p>
          <p className="text-sm text-zinc-300 font-mono">{rollup.totals.redemptions}</p>
        </div>
      </div>
    </div>
  );
}
