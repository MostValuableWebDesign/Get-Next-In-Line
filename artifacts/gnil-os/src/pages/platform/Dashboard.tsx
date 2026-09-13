import { useGetAgencyDashboard, useGetTenantActivity } from "@workspace/api-client-react";
import { Activity, Building2, Wallet, Users, ArrowUpRight } from "lucide-react";
import { Link } from "wouter";

export default function PlatformDashboard() {
  const { data: dashboard, isLoading: isLoadingDash } = useGetAgencyDashboard();
  const { data: activity, isLoading: isLoadingActivity } = useGetTenantActivity({ limit: 10 });

  if (isLoadingDash) {
    return <div className="text-zinc-500 animate-pulse font-mono text-sm">Loading telemetry...</div>;
  }

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Active Installations" value={dashboard?.activeTenants ?? 0} icon={Building2} />
        <StatCard title="Provisioned Modules" value={dashboard?.totalModulesProvisioned ?? 0} icon={Activity} />
        <StatCard title="Total Tenants" value={dashboard?.totalTenants ?? 0} icon={Users} />
        <StatCard title="Monthly Recurring" value={`$${((dashboard?.totalMrr ?? 0)).toFixed(2)}`} icon={Wallet} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider">Recent Activity</h2>
          </div>
          <div className="divide-y divide-zinc-800">
            {isLoadingActivity ? (
              <div className="p-5 text-zinc-500 text-sm">Loading activity stream...</div>
            ) : activity?.items.length === 0 ? (
              <div className="p-5 text-zinc-500 text-sm">No recent activity detected.</div>
            ) : (
              activity?.items.map(act => (
                <div key={act.id} className="p-4 flex gap-4 hover:bg-zinc-800/30 transition-colors">
                  <div className="size-8 rounded-full bg-zinc-800 flex items-center justify-center shrink-0">
                    <Activity className="size-4 text-zinc-400" />
                  </div>
                  <div>
                    <p className="text-sm text-zinc-300">
                      <span className="font-medium text-white">{act.tenantName}</span> {act.action}
                    </p>
                    <p className="text-xs text-zinc-500 mt-1">{new Date(act.timestamp).toLocaleString()}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
        
        <section className="space-y-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Quick Actions</h2>
            <div className="space-y-2">
              <Link href="/platform/tenants" className="flex items-center justify-between p-3 rounded bg-zinc-950 border border-zinc-800 hover:border-teal-500/50 hover:bg-zinc-800 transition-colors group">
                <span className="text-sm text-zinc-300 font-medium">Browse Installations</span>
                <ArrowUpRight className="size-4 text-zinc-600 group-hover:text-teal-400" />
              </Link>
              <Link href="/platform/governance" className="flex items-center justify-between p-3 rounded bg-zinc-950 border border-zinc-800 hover:border-teal-500/50 hover:bg-zinc-800 transition-colors group">
                <span className="text-sm text-zinc-300 font-medium">Review Governance Apps</span>
                <ArrowUpRight className="size-4 text-zinc-600 group-hover:text-teal-400" />
              </Link>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({ title, value, icon: Icon }: { title: string, value: string | number, icon: any }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between text-zinc-400">
        <h3 className="text-sm font-medium">{title}</h3>
        <Icon className="size-4" />
      </div>
      <div className="text-3xl font-semibold text-white tracking-tight">{value}</div>
    </div>
  );
}
