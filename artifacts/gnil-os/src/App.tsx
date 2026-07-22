import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter, Redirect } from "wouter";
import { Shell } from "@/components/layout/Shell";
import { useAuth } from "@/hooks/useAuth";

import Dashboard from "@/pages/Dashboard";
import Tenants from "@/pages/Tenants";
import TenantDetail from "@/pages/TenantDetail";
import Marketing from "@/pages/Marketing";
import Operations from "@/pages/Operations";
import Partners from "@/pages/Partners";
import Media from "@/pages/Media";
import Billing from "@/pages/Billing";
import ModuleConsole from "@/pages/ModuleConsole";
import ConnectorRegistry from "@/pages/ConnectorRegistry";
import AdminModuleDetail from "@/pages/AdminModuleDetail";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

// SOS Operations section (merged from the former standalone SOS app)
import { DashboardPage as SosDashboard } from "@/pages/sos/dashboard";
import { OperationsPage as SosOperations } from "@/pages/sos/operations";
import { CalendarPage as SosCalendar } from "@/pages/sos/calendar";
import { CustomersPage as SosCustomers } from "@/pages/sos/customers";
import { PosPage as SosPos } from "@/pages/sos/pos";
import { ReportsPage as SosReports } from "@/pages/sos/reports";
import { MarketingPage as SosMarketing } from "@/pages/sos/marketing";
import Settings from "@/pages/Settings";
import {
  EmployeesPage as SosEmployees,
  PayrollPage as SosPayroll,
  BusinessProtectionPage as SosBusinessProtection,
  EmployeeBenefitsPage as SosEmployeeBenefits,
} from "@/pages/sos/static-pages";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Treat 401 responses as a non-retryable auth failure
      retry: (failureCount, error: unknown) => {
        const status = (error as { status?: number })?.status;
        if (status === 401) return false;
        return failureCount < 2;
      },
    },
  },
});

/** Wraps all protected pages — redirects to /login until session is confirmed. */
function ProtectedApp() {
  const { authState } = useAuth();

  if (authState === "loading") {
    return (
      <div className="min-h-screen bg-[hsl(210,20%,98%)] flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-500">Verifying session…</p>
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    // useAuth already navigates to /login; render nothing while that happens
    return null;
  }

  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/tenants" component={Tenants} />
        <Route path="/tenants/:id" component={TenantDetail} />
        <Route path="/marketing" component={Marketing} />
        <Route path="/operations" component={Operations} />
        <Route path="/partners" component={Partners} />
        <Route path="/media" component={Media} />
        <Route path="/modules/:id" component={ModuleConsole} />
        <Route path="/billing" component={Billing} />
        <Route path="/connectors" component={ConnectorRegistry} />
        <Route path="/admin/modules/:id" component={AdminModuleDetail} />
        <Route path="/settings" component={Settings} />
        {/* SOS Operations section */}
        <Route path="/sos" component={SosDashboard} />
        <Route path="/sos/operations" component={SosOperations} />
        <Route path="/sos/calendar" component={SosCalendar} />
        <Route path="/sos/customers" component={SosCustomers} />
        <Route path="/sos/pos" component={SosPos} />
        <Route path="/sos/reports" component={SosReports} />
        <Route path="/sos/marketing" component={SosMarketing} />
        {/* Old standalone SOS settings page — folded into the unified Configuration screen */}
        <Route path="/sos/settings">
          <Redirect to="/settings" replace />
        </Route>
        <Route path="/sos/employees" component={SosEmployees} />
        <Route path="/sos/payroll" component={SosPayroll} />
        <Route path="/sos/business-protection" component={SosBusinessProtection} />
        <Route path="/sos/employee-benefits" component={SosEmployeeBenefits} />
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route component={ProtectedApp} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
