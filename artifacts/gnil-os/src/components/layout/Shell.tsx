import { ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
} from '@/components/ui/sidebar';
import { Activity, LayoutDashboard, Users, Zap, Briefcase, Radio, CreditCard } from 'lucide-react';

const NAV_ITEMS = [
  { name: 'Command Center', path: '/', icon: LayoutDashboard },
  { name: 'Tenant Ops', path: '/tenants', icon: Users },
  { name: 'GHL Bridge', path: '/marketing', icon: Zap },
  { name: 'Core Ops', path: '/operations', icon: Activity },
  { name: 'Partners (0%)', path: '/partners', icon: Briefcase },
  { name: 'Media Resale', path: '/media', icon: Radio },
  { name: 'Billing', path: '/billing', icon: CreditCard },
];

import { useHealthCheck } from '@workspace/api-client-react';

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { data: health } = useHealthCheck();
  
  const isOnline = health?.status === 'ok';

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar variant="sidebar" className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="p-4 border-b border-sidebar-border/50">
            <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
              <div className="size-8 bg-primary rounded flex items-center justify-center text-primary-foreground shadow-sm">
                GN
              </div>
              <span className="text-white">GNIL OS</span>
            </div>
            <div className="text-xs text-sidebar-foreground/60 font-mono tracking-widest mt-1 uppercase">
              Operator Terminal
            </div>
          </SidebarHeader>
          <SidebarContent className="p-2">
            <SidebarMenu>
              {NAV_ITEMS.map((item) => (
                <SidebarMenuItem key={item.path}>
                  <SidebarMenuButton
                    asChild
                    isActive={location === item.path}
                    className="data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground font-medium h-10"
                  >
                    <Link href={item.path} className="flex items-center gap-3 px-3">
                      <item.icon className="size-5" />
                      <span>{item.name}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarContent>
        </Sidebar>
        <main className="flex-1 flex flex-col h-[100dvh] overflow-hidden">
          <header className="h-16 border-b bg-card flex items-center px-8 shrink-0 justify-between">
            <h2 className="font-semibold text-lg">{NAV_ITEMS.find((n) => n.path === location)?.name || 'Agency OS'}</h2>
            <div className="flex items-center gap-4 text-sm font-mono text-muted-foreground">
              <span>SYS.STATUS: <span className={isOnline ? "text-emerald-500 font-bold" : "text-amber-500 font-bold"}>{isOnline ? 'ONLINE' : 'CONNECTING'}</span></span>
            </div>
          </header>
          <div className="flex-1 overflow-auto p-8 bg-background">
            <div className="max-w-7xl mx-auto">
              {children}
            </div>
          </div>
        </main>
      </div>
    </SidebarProvider>
  );
}
