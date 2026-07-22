import { ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';
import {
  Activity, LayoutDashboard, Users, Zap, Radio, CreditCard, Cable, WifiOff, X,
  Megaphone, Settings, BookOpenCheck,
} from 'lucide-react';

type NavItem = {
  name: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Extra paths that should highlight this entry (e.g. tab deep links). */
  aliases?: string[];
};

const NAV_ITEMS: NavItem[] = [
  { name: 'Command Center', path: '/', icon: LayoutDashboard },
  { name: 'Tenant Dashboards', path: '/tenants', icon: Users },
  { name: 'GNIL Bridge', path: '/marketing', icon: Zap },
  // Unified hub: Modules (/operations), Live Operations (/sos/operations),
  // Partner Integrations (/partners), and the SOS partner tabs
  {
    name: 'Operations',
    path: '/operations',
    icon: Activity,
    aliases: [
      '/sos/operations',
      '/partners',
      '/sos/employees',
      '/sos/payroll',
      '/sos/business-protection',
      '/sos/employee-benefits',
    ],
  },
  { name: 'Media & Assets', path: '/media', icon: Radio },
  { name: 'Billing', path: '/billing', icon: CreditCard },
  { name: 'Connector Registry', path: '/connectors', icon: Cable },
  { name: 'Configuration', path: '/settings', icon: Settings },
];

const SOS_NAV_ITEMS: NavItem[] = [
  // Consolidated hub: appointments + checkout, plus entry points to the
  // SOS Dashboard (/sos), Customers, and Reports views
  {
    name: 'Business Bookings',
    path: '/sos/bookings',
    icon: BookOpenCheck,
    aliases: ['/sos', '/sos/customers', '/sos/reports'],
  },
  // Live communications logs (AI calls + SMS); setup lives in Configuration.
  { name: 'Marketing & Comms', path: '/sos/marketing', icon: Megaphone },
];

import { useOnlineStatus } from '@/hooks/use-online';

/** Nav list — closes the mobile drawer after each click */
function NavMenu({ location, items }: { location: string; items: typeof NAV_ITEMS }) {
  const { isMobile, setOpenMobile } = useSidebar();

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.path}>
          <SidebarMenuButton
            asChild
            isActive={location === item.path || (item.aliases?.includes(location) ?? false)}
            tooltip={item.name}
            className="data-[active=true]:bg-sidebar-primary data-[active=true]:text-sidebar-primary-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground font-medium h-10"
          >
            <Link
              href={item.path}
              className="flex items-center gap-3 px-3"
              onClick={() => {
                if (isMobile) setOpenMobile(false);
              }}
            >
              <item.icon className="size-5" />
              <span>{item.name}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

/**
 * Slim, dismissible banner shown when the API connection drops.
 * Appears on the online → offline transition; clears automatically on recovery.
 */
function ConnectionBanner({ isOnline, settled }: { isOnline: boolean; settled: boolean }) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Reset the dismissal once the connection recovers, so a future
    // outage surfaces the banner again.
    if (isOnline) setDismissed(false);
  }, [isOnline]);

  // Only show once the health check has settled (avoids a flash during
  // initial startup), whether the app started offline or dropped later.
  if (!settled || isOnline || dismissed) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 bg-amber-500/15 border-b border-amber-500/40 text-amber-700 dark:text-amber-400 px-4 py-2 text-sm shrink-0"
    >
      <WifiOff className="size-4 shrink-0" />
      <span className="flex-1 min-w-0">
        Connection lost — trying to reconnect. Changes may not save until the connection is restored.
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss connection notice"
        className="p-1 rounded hover:bg-amber-500/20 shrink-0"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { isOnline, settled } = useOnlineStatus();
  const currentLabel =
    [...NAV_ITEMS, ...SOS_NAV_ITEMS].find(
      (n) => n.path === location || n.aliases?.includes(location),
    )?.name || 'Agency OS';

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <Sidebar variant="sidebar" collapsible="icon" className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          <SidebarHeader className="p-4 border-b border-sidebar-border/50 group-data-[collapsible=icon]:p-2">
            <div className="flex items-center gap-2 font-bold text-xl tracking-tight">
              <div className="size-8 shrink-0 bg-primary rounded flex items-center justify-center text-primary-foreground shadow-sm">
                GN
              </div>
              <span className="text-white group-data-[collapsible=icon]:hidden">GNIL OS</span>
            </div>
            <div className="text-xs text-sidebar-foreground/60 font-mono tracking-widest mt-1 uppercase group-data-[collapsible=icon]:hidden">
              Operator Terminal
            </div>
          </SidebarHeader>
          <SidebarContent className="p-2">
            <NavMenu location={location} items={NAV_ITEMS} />
            <div className="px-3 pt-4 pb-1 text-xs font-mono uppercase tracking-widest text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden">
              Business (SOS)
            </div>
            <NavMenu location={location} items={SOS_NAV_ITEMS} />
          </SidebarContent>
        </Sidebar>
        <main className="flex-1 flex flex-col h-[100dvh] overflow-hidden">
          <header className="h-16 border-b bg-card flex items-center px-4 shrink-0 justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {/* Always-visible sidebar toggle — prominent on narrow viewports */}
              <SidebarTrigger className="h-9 w-9 shrink-0 text-foreground hover:bg-accent" />
              <h2 className="font-semibold text-lg truncate">{currentLabel}</h2>
            </div>
            <div className="flex items-center gap-4 text-sm font-mono text-muted-foreground shrink-0">
              {/* Full status text at md+ widths */}
              <span className="hidden md:inline">SYS.STATUS: <span className={isOnline ? "text-emerald-500 font-bold" : "text-amber-500 font-bold"}>{isOnline ? 'ONLINE' : 'CONNECTING'}</span></span>
              {/* Compact status dot below md — keeps the title readable */}
              <span
                className="md:hidden flex items-center"
                title={isOnline ? 'SYS.STATUS: ONLINE' : 'SYS.STATUS: CONNECTING'}
                aria-label={isOnline ? 'System status: online' : 'System status: connecting'}
                role="status"
              >
                <span className={`size-2.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
              </span>
            </div>
          </header>
          <ConnectionBanner isOnline={isOnline} settled={settled} />
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
