import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter, Redirect } from "wouter";
import { Shell } from "@/components/layout/Shell";
import { useAuth } from "@/hooks/useAuth";

import Dashboard from "@/pages/Dashboard";
import Tenants from "@/pages/Tenants";
import TenantDetail from "@/pages/TenantDetail";
import Concierge from "@/pages/Concierge";
import OperationsHub from "@/pages/OperationsHub";
import Media from "@/pages/Media";
import Billing from "@/pages/Billing";
import ModuleConsole from "@/pages/ModuleConsole";
import ConnectorRegistry from "@/pages/ConnectorRegistry";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

// SOS Operations section (merged from the former standalone SOS app)
import { CustomersPage as SosCustomers } from "@/pages/sos/customers";
import { PosPage as SosPos } from "@/pages/sos/pos";
import { ReportsPage as SosReports } from "@/pages/sos/reports";
import { AiReceptionistPage } from "@/pages/sos/ai-receptionist";
import { BookingsPage as SosBookings } from "@/pages/sos/bookings";
import { MembershipsPage as SosMemberships } from "@/pages/sos/memberships";
import Settings from "@/pages/Settings";

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
        <Route path="/tenants/:id/settings" component={Settings} />
        {/* Tenant-scoped AI Receptionist configuration — the single editing
            home for that tenant's receptionist settings. */}
        <Route path="/tenants/:id/ai-receptionist" component={AiReceptionistPage} />
        <Route path="/tenants/:id" component={TenantDetail} />
        <Route path="/tenants/:id/concierge" component={Concierge} />
        {/* Unified Operations hub — Marketing tab (old GNIL Bridge URL) */}
        <Route path="/marketing" component={OperationsHub} />
        {/* Unified Operations hub — Modules tab */}
        <Route path="/operations" component={OperationsHub} />
        {/* Unified Operations hub — Partner Integrations tab */}
        <Route path="/partners" component={OperationsHub} />
        <Route path="/media" component={Media} />
        <Route path="/modules/:id" component={ModuleConsole} />
        <Route path="/billing" component={Billing} />
        <Route path="/connectors" component={ConnectorRegistry} />
        {/* /modules/:id is the canonical Module Console route — the old admin
            path redirects so bookmarks and stale links keep working. */}
        <Route path="/admin/modules/:id">
          {(params) => <Redirect to={`/modules/${params.id}`} replace />}
        </Route>
        <Route path="/settings" component={Settings} />
        {/* SOS Operations section — the old standalone SOS Dashboard is folded
            into Business Bookings (its KPI stats now render there) */}
        <Route path="/sos">
          <Redirect to="/sos/bookings" replace />
        </Route>
        {/* Unified Operations hub — Live Operations tab (old SOS Operations Center URL) */}
        <Route path="/sos/operations" component={OperationsHub} />
        {/* Calendar is now a view inside Business Bookings */}
        <Route path="/sos/calendar">
          <Redirect to="/sos/bookings" replace />
        </Route>
        <Route path="/sos/customers" component={SosCustomers} />
        <Route path="/sos/pos" component={SosPos} />
        <Route path="/sos/reports" component={SosReports} />
        <Route path="/sos/bookings" component={SosBookings} />
        <Route path="/sos/memberships" component={SosMemberships} />
        <Route path="/sos/ai-receptionist" component={AiReceptionistPage} />
        {/* Old Marketing & Comms page — its receptionist and SMS tabs are now
            part of the unified AI Receptionist view, so any ?tab= deep link
            lands there too. */}
        <Route path="/sos/marketing">
          <Redirect to="/sos/ai-receptionist" replace />
        </Route>
        {/* Old standalone SOS settings page — folded into the unified Configuration screen */}
        <Route path="/sos/settings">
          <Redirect to="/settings" replace />
        </Route>
        {/* Unified Operations hub — combined Partner Services tab. The four
            former per-partner placeholder URLs redirect to it. */}
        <Route path="/sos/partner-services" component={OperationsHub} />
        <Route path="/sos/employees">
          <Redirect to="/sos/partner-services" replace />
        </Route>
        <Route path="/sos/payroll">
          <Redirect to="/sos/partner-services" replace />
        </Route>
        <Route path="/sos/business-protection">
          <Redirect to="/sos/partner-services" replace />
        </Route>
        <Route path="/sos/employee-benefits">
          <Redirect to="/sos/partner-services" replace />
        </Route>
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
