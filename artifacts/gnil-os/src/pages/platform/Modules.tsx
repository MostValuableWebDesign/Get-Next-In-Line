import { useListModules } from "@workspace/api-client-react";
import { Layers, CheckCircle2 } from "lucide-react";

export default function PlatformModules() {
  const { data: modules, isLoading } = useListModules();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white tracking-tight">Module Catalog</h2>
        <p className="text-sm text-zinc-400 mt-1">Global platform modules, pricing logic, and adoption visibility.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading ? (
          <div className="col-span-full text-zinc-500 animate-pulse font-mono text-sm py-8">Loading modules...</div>
        ) : modules?.length === 0 ? (
          <div className="col-span-full bg-zinc-900 border border-zinc-800 rounded-xl p-12 text-center">
            <Layers className="size-10 text-zinc-600 mx-auto mb-4" />
            <p className="text-zinc-400">No modules registered in the platform catalog.</p>
          </div>
        ) : (
          modules?.map((mod) => (
            <div key={mod.id} className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden flex flex-col group hover:border-zinc-700 transition-colors">
              <div className="p-5 border-b border-zinc-800 flex-1">
                <div className="flex items-start justify-between mb-3">
                  <div className="size-10 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shadow-inner group-hover:border-teal-500/30 transition-colors">
                    <Layers className="size-5 text-teal-500" />
                  </div>
                </div>
                <h3 className="text-lg font-medium text-white mb-1">{mod.name}</h3>
                <p className="text-sm text-zinc-400 mb-4">{mod.description}</p>
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
                  <span className="bg-zinc-950 px-2 py-1 rounded border border-zinc-800">{mod.categorySlug}</span>
                </div>
              </div>
              
              <div className="p-5 bg-zinc-950/50 flex flex-col gap-3 shrink-0">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-zinc-500">Base Price</span>
                  <span className="text-white font-medium">${(mod.wholesalePrice / 100).toFixed(2)}/mo</span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
