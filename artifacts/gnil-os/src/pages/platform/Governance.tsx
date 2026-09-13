import { useListGovernanceUsers, useListCoopApplications } from "@workspace/api-client-react";
import { Shield, ShieldAlert, CheckCircle2, User, Key, Building2 } from "lucide-react";

export default function PlatformGovernance() {
  const { data: users, isLoading: isLoadingUsers } = useListGovernanceUsers();
  const { data: apps, isLoading: isLoadingApps } = useListCoopApplications();

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Platform Governance</h2>
        <p className="text-sm text-zinc-400 mt-1">Manage administrative access and review incoming network applications.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <ShieldAlert className="size-4 text-zinc-400" /> Pending Applications
            </h2>
          </div>
          <div className="divide-y divide-zinc-800 max-h-[500px] overflow-y-auto">
            {isLoadingApps ? (
              <div className="p-5 text-zinc-500 text-sm">Loading applications...</div>
            ) : apps?.length === 0 ? (
              <div className="p-5 text-zinc-500 text-sm flex flex-col items-center justify-center py-8">
                <CheckCircle2 className="size-8 text-zinc-600 mb-2" />
                <p>Application queue is empty.</p>
              </div>
            ) : (
              apps?.map((app) => (
                <div key={app.id} className="p-4 hover:bg-zinc-800/30 transition-colors">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="font-medium text-white">{app.businessName}</h3>
                      <p className="text-xs text-zinc-400 font-mono">{app.subdomain}.gnil.app</p>
                    </div>
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider bg-amber-500/10 text-amber-500 border border-amber-500/20">
                      {app.status}
                    </span>
                  </div>
                  <div className="text-sm text-zinc-300 mt-3 bg-zinc-950 p-3 rounded border border-zinc-800">
                    <p className="font-medium mb-1">{app.contactName} ({app.contactEmail})</p>
                    <p className="text-zinc-400 italic line-clamp-2">"{app.pitch}"</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
              <Shield className="size-4 text-zinc-400" /> Network Accounts
            </h2>
          </div>
          <div className="divide-y divide-zinc-800 max-h-[500px] overflow-y-auto">
            {isLoadingUsers ? (
              <div className="p-5 text-zinc-500 text-sm">Loading accounts...</div>
            ) : users?.length === 0 ? (
              <div className="p-5 text-zinc-500 text-sm">No accounts found.</div>
            ) : (
              users?.map((user) => (
                <div key={user.id} className="p-4 hover:bg-zinc-800/30 transition-colors flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className={`size-10 rounded-full flex items-center justify-center shrink-0 ${user.role === 'super_admin' ? 'bg-teal-500/20 text-teal-400' : 'bg-zinc-800 text-zinc-400'}`}>
                      <User className="size-5" />
                    </div>
                    <div>
                      <h3 className="font-medium text-white">{user.username}</h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-zinc-500 font-mono">{user.role}</span>
                        {user.isPlatformAdmin && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] uppercase font-bold tracking-wider bg-red-500/10 text-red-400 border border-red-500/20">
                            Admin
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-col items-end text-xs text-zinc-500">
                    <div className="flex items-center gap-1">
                      <Key className="size-3" />
                      {user.hasLoginToken ? "Token Active" : "No Token"}
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <Building2 className="size-3" />
                      {user.tenants.length} Scopes
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
