import { useRoute } from "wouter";
import { useGetTenant, useGetTenantModules } from "@workspace/api-client-react";
import { Building2, Layers, Calendar, Link as LinkIcon, AlertCircle } from "lucide-react";
import { Link } from "wouter";

export default function PlatformTenantDetail() {
  const [, params] = useRoute("/platform/tenants/:id");
  const tenantId = Number(params?.id);

  const { data: tenant, isLoading: isLoadingTenant } = useGetTenant(tenantId, { query: { enabled: !!tenantId, queryKey: ["tenant", tenantId] } });
  const { data: modules, isLoading: isLoadingModules } = useGetTenantModules(tenantId, { query: { enabled: !!tenantId, queryKey: ["tenant-modules", tenantId] } });

  if (isLoadingTenant) {
    return <div className="text-zinc-500 animate-pulse font-mono text-sm">Loading installation data...</div>;
  }

  if (!tenant) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center">
        <AlertCircle className="size-8 text-red-400 mx-auto mb-3" />
        <h2 className="text-white font-medium mb-1">Installation Not Found</h2>
        <p className="text-sm text-zinc-400 mb-4">The requested installation could not be located.</p>
        <Link href="/platform/tenants" className="text-sm text-teal-400 hover:text-teal-300">Return to Directory</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-zinc-500 font-mono mb-2">
        <Link href="/platform/tenants" className="hover:text-zinc-300 transition-colors">DIRECTORY</Link>
        <span>/</span>
        <span className="text-zinc-300">{tenant.subdomain}</span>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6 flex flex-col sm:flex-row gap-6 items-start sm:items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="size-16 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shrink-0 shadow-inner">
            <Building2 className="size-8 text-teal-500" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-white tracking-tight">{tenant.brandName}</h1>
            <div className="flex items-center gap-4 mt-2">
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400 border border-teal-500/20">Active</span>
              <span className="text-sm text-zinc-400 font-mono">{tenant.subdomain}.gnil.app</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="md:col-span-2 space-y-6">
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="p-5 border-b border-zinc-800">
              <h2 className="text-sm font-semibold text-white uppercase tracking-wider flex items-center gap-2">
                <Layers className="size-4 text-zinc-400" /> Provisioned Modules
              </h2>
            </div>
            <div className="divide-y divide-zinc-800">
              {isLoadingModules ? (
                <div className="p-5 text-zinc-500 text-sm">Loading modules...</div>
              ) : modules?.length === 0 ? (
                <div className="p-5 text-zinc-500 text-sm">No modules provisioned for this installation.</div>
              ) : (
                modules?.map((mod) => (
                  <div key={mod.moduleId} className="p-4 flex flex-col sm:flex-row gap-4 justify-between hover:bg-zinc-800/30 transition-colors">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{mod.name}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-zinc-400">Provisioned</p>
                      <p className="text-sm text-zinc-300">{new Date(mod.provisionedAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
              <Calendar className="size-4 text-zinc-400" /> Platform Record
            </h2>
            <div className="space-y-4">
              <div>
                <p className="text-xs text-zinc-500 mb-1">Status</p>
                <p className="text-sm text-zinc-300">{tenant.status}</p>
              </div>
              <div className="pt-4 border-t border-zinc-800">
                <p className="text-xs text-zinc-500 mb-1">Co-op Network ID</p>
                <p className="text-sm font-mono text-zinc-300">{tenant.id}</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
