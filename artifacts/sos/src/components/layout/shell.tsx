import React from 'react';
import { Link, useLocation } from 'wouter';
import { 
  LayoutDashboard, 
  Calendar as CalendarIcon, 
  Users, 
  Activity, 
  CreditCard,
  UserCircle,
  Briefcase,
  ShieldCheck,
  Heart,
  BarChart3,
  Megaphone,
  Settings
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export function Sidebar() {
  const [location] = useLocation();

  const navigation = [
    { name: 'Dashboard', href: '/', icon: LayoutDashboard },
    { name: 'Calendar', href: '/calendar', icon: CalendarIcon },
    { name: 'Customers', href: '/customers', icon: Users },
    { name: 'Operations Center', href: '/operations', icon: Activity },
    { name: 'POS', href: '/pos', icon: CreditCard },
    { name: 'Employees', href: '/employees', icon: UserCircle },
    { name: 'Payroll (Gusto)', href: '/payroll', icon: Briefcase },
    { name: 'Business Protection', href: '/business-protection', icon: ShieldCheck },
    { name: 'Employee Benefits', href: '/employee-benefits', icon: Heart },
    { name: 'Reports', href: '/reports', icon: BarChart3 },
    { name: 'Marketing', href: '/marketing', icon: Megaphone },
    { name: 'Settings', href: '/settings', icon: Settings },
  ];

  return (
    <div className="flex h-screen w-64 flex-col bg-sidebar border-r border-sidebar-border">
      <div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-6">
        <span className="font-bold text-lg tracking-tight text-sidebar-foreground">SOS Command</span>
      </div>
      <div className="flex-1 overflow-y-auto py-4">
        <nav className="space-y-1 px-3">
          {navigation.map((item) => {
            const isActive = location === item.href || (location.startsWith(item.href) && item.href !== '/');
            return (
              <Link key={item.name} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium cursor-pointer transition-colors",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                  )}
                  data-testid={`nav-${item.name.toLowerCase().replace(/[^a-z]/g, '-')}`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.name}
                </div>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full bg-background overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  );
}
