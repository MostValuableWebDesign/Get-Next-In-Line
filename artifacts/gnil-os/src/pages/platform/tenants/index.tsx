import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useListTenants } from "@workspace/api-client-react";
import { Search, Building2, ChevronRight } from "lucide-react";

export default function PlatformTenants() {
  const [search, setSearch] = useState("");
  const { data: tenants, isLoading } = useListTenants();

  const filteredTenants = useMemo(() => {
    if (!tenants) return [];
    const q = search.toLowerCase();
    return tenants.filter(t => 
      t.brandName.toLowerCase().includes(q) || 
      t.subdomain.toLowerCase().includes(q)
    );
  }, [tenants, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-white tracking-tight">Installations Directory</h2>
          <p className="text-sm text-zinc-400 mt-1">Search and manage platform business tenants.</p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search by name, subdomain..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-md py-2 pl-9 pr-4 text-sm text-white placeholder:text-zinc-500 focus:outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-500 transition-all"
          />
        </div>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-zinc-950 text-zinc-400">
            <tr>
              <th className="px-6 py-3 font-medium">Installation Name</th>
              <th className="px-6 py-3 font-medium">Subdomain</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {isLoading ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-zinc-500 font-mono">Loading directory...</td>
              </tr>
            ) : filteredTenants.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-8 text-center text-zinc-500">No installations found matching "{search}".</td>
              </tr>
            ) : (
              filteredTenants.map((tenant) => (
                <tr key={tenant.id} className="hover:bg-zinc-800/30 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="size-8 rounded bg-zinc-800 flex items-center justify-center shrink-0">
                        <Building2 className="size-4 text-zinc-400" />
                      </div>
                      <span className="font-medium text-white">{tenant.brandName}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-zinc-400 font-mono text-xs">{tenant.subdomain}</td>
                  <td className="px-6 py-4">
                    <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-teal-500/10 text-teal-400 border border-teal-500/20">
                      Active
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <Link 
                      href={`/platform/tenants/${tenant.id}`}
                      className="inline-flex items-center gap-1 text-teal-500 hover:text-teal-400 font-medium transition-colors"
                    >
                      Inspect <ChevronRight className="size-4" />
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
