import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { 
  Activity, Users, Shield, Receipt, Layers, Building2, LogOut
} from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online";

const NAV = [
  { path: "/platform", name: "Overview", icon: Activity },
  { path: "/platform/tenants", name: "Installations", icon: Building2 },
  { path: "/platform/modules", name: "Module Catalog", icon: Layers },
  { path: "/platform/governance", name: "Governance", icon: Shield },
  { path: "/platform/billing", name: "Billing", icon: Receipt },
  { path: "/platform/franchise", name: "Franchises", icon: Users },
];

export function PlatformShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { isOnline } = useOnlineStatus();

  return (
    <div className="min-h-screen w-full bg-zinc-950 text-zinc-300 font-sans selection:bg-teal-500/30 flex flex-col md:flex-row">
      <aside className="w-full md:w-64 border-b md:border-b-0 md:border-r border-zinc-800 bg-zinc-950 flex flex-col shrink-0">
        <div className="h-16 flex items-center px-6 border-b border-zinc-800 shrink-0">
          <div className="flex items-center gap-3 text-white font-semibold tracking-tight">
            <div className="size-8 rounded bg-teal-500 flex items-center justify-center text-zinc-950">
              <Shield className="size-4" strokeWidth={3} />
            </div>
            <span>Platform Control</span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-4 space-y-1">
          <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 mb-3 px-2">Core Services</div>
          {NAV.map((item) => {
            const isActive = location === item.path || (location.startsWith(item.path + "/") && item.path !== "/platform");
            return (
              <Link 
                key={item.path} 
                href={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  isActive 
                    ? "bg-zinc-800 text-teal-400" 
                    : "hover:bg-zinc-800/50 hover:text-white"
                }`}
              >
                <item.icon className="size-4" />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-zinc-800 shrink-0">
          <Link href="/" className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-zinc-400 hover:text-white hover:bg-zinc-800/50 transition-colors">
            <LogOut className="size-4" />
            Exit to Merchant
          </Link>
        </div>
      </aside>
      
      <main className="flex-1 flex flex-col min-w-0 max-h-screen overflow-hidden">
        <header className="h-16 flex items-center px-8 border-b border-zinc-800 bg-zinc-950 shrink-0 justify-between">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-medium text-white tracking-tight">
              {NAV.find(n => location === n.path || (location.startsWith(n.path + "/") && n.path !== "/platform"))?.name || "Platform"}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span className={`flex h-2 w-2 rounded-full ${isOnline ? 'bg-teal-500 animate-pulse' : 'bg-red-500'}`}></span>
            <span className={`text-xs font-mono uppercase tracking-widest ${isOnline ? 'text-zinc-500' : 'text-red-400'}`}>
              {isOnline ? 'Sys.Status: Nominal' : 'Sys.Status: Offline'}
            </span>
          </div>
        </header>
        
        <div className="flex-1 overflow-auto bg-zinc-950/50 p-6 md:p-8">
          <div className="max-w-6xl mx-auto space-y-6">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
