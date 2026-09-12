import { Link, Route, Switch, useLocation, useSearch } from "wouter";
import { LayoutDashboard, Users, Clock, DollarSign, Calendar, Zap } from "lucide-react";
import { OperationsOverviewPage } from "./OperationsOverviewPage";
import { IntegrationsCatalogPage } from "./IntegrationsCatalogPage";
import { WorkforceStatePage } from "./WorkforceStatePage";
import { PayrollStatePage } from "./PayrollStatePage";
import { TimeAttendanceStatePage } from "./TimeAttendanceStatePage";
import { SchedulingStatePage } from "./SchedulingStatePage";
import { withSosTenant } from "@/lib/sos-tenant-url";

const NAV_ITEMS = [
  { path: "/operations", label: "Overview", icon: LayoutDashboard },
  { path: "/operations/integrations", label: "Integrations", icon: Zap },
  { path: "/operations/workforce", label: "Staff", icon: Users },
  { path: "/operations/payroll", label: "Payroll", icon: DollarSign },
  { path: "/operations/time", label: "Time & Attendance", icon: Clock },
  { path: "/operations/scheduling", label: "Scheduling", icon: Calendar },
];

export default function WorkforceHub() {
  const [location] = useLocation();
  const search = useSearch();

  return (
    <div className="flex flex-col space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Workforce Hub</h1>
          <p className="text-muted-foreground mt-1">
            Connect the tools you already use and manage workforce operations from one place.
          </p>
        </div>
      </div>

      <div className="flex overflow-x-auto pb-2 border-b border-border/50 scrollbar-hide">
        <nav className="flex space-x-1" aria-label="Workforce Hub Tabs">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.path;
            return (
              <Link
                key={item.path}
                href={withSosTenant(item.path, search)}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors whitespace-nowrap ${
                  isActive
                    ? "bg-primary/10 text-primary border-b-2 border-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="mt-4 pb-12">
        <Switch>
          <Route path="/operations" component={OperationsOverviewPage} />
          <Route path="/operations/integrations" component={IntegrationsCatalogPage} />
          <Route path="/operations/workforce" component={WorkforceStatePage} />
          <Route path="/operations/payroll" component={PayrollStatePage} />
          <Route path="/operations/time" component={TimeAttendanceStatePage} />
          <Route path="/operations/scheduling" component={SchedulingStatePage} />
        </Switch>
      </div>
    </div>
  );
}
