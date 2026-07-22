import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter, Redirect, useSearch } from "wouter";
import { Shell } from "@/components/layout/Shell";
import { useAuth } from "@/hooks/useAuth";

import Dashboard from "@/pages/Dashboard";
import Tenants from "@/pages/Tenants";
import TenantDetail from "@/pages/TenantDetail";
import OperationsHub from "@/pages/OperationsHub";
import Billing from "@/pages/Billing";
import ModuleConsole from "@/pages/ModuleConsole";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

// SOS Operations section (merged from the former standalone SOS app)
import { BookingsPage as SosBookings } from "@/pages/sos/bookings";
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

/**
 * Redirect the old standalone /sos/customers page into Business Bookings,
 * preserving the tab (?tab=plans) and customer deep-link (?customer=<id>).
 */
function RedirectSosCustomers() {
  const params = new URLSearchParams(useSearch());
  const tab = params.get('tab') === 'plans' ? 'plans' : 'customers';
  const customer = params.get('customer');
  const to = `/sos/bookings?tab=${tab}${customer ? `&customer=${encodeURIComponent(customer)}` : ''}`;
  return <Redirect to={to} replace />;
}

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
        {/* Tenant Settings and AI Receptionist are now tabs inside Tenant
            Detail — old standalone URLs redirect to the matching tab. */}
        <Route path="/tenants/:id/settings">
          {(params) => <Redirect to={`/tenants/${params.id}?tab=settings`} replace />}
        </Route>
        <Route path="/tenants/:id/ai-receptionist">
          {(params) => <Redirect to={`/tenants/${params.id}?tab=ai-receptionist`} replace />}
        </Route>
        <Route path="/tenants/:id" component={TenantDetail} />
        {/* Concierge is folded into Tenant Detail as tabs — old deep links
            land on the Engagement Rules tab. */}
        <Route path="/tenants/:id/concierge">
          {(params) => <Redirect to={`/tenants/${params.id}?tab=rules`} replace />}
        </Route>
        {/* Unified Operations hub — Marketing tab (old GNIL Bridge URL) */}
        <Route path="/marketing" component={OperationsHub} />
        {/* Unified Operations hub — Modules tab */}
        <Route path="/operations" component={OperationsHub} />
        {/* Unified Operations hub — merged Partners tab (grid + services) */}
        <Route path="/partners" component={OperationsHub} />
        {/* Unified Operations hub — Media tab (old Media & Assets page URL) */}
        <Route path="/media" component={OperationsHub} />
        <Route path="/modules/:id" component={ModuleConsole} />
        <Route path="/billing" component={Billing} />
        {/* Connector Registry is folded into Configuration — old links land
            on its Connectors section. */}
        <Route path="/connectors">
          <Redirect to="/settings#connectors" replace />
        </Route>
        {/* /modules/:id is the canonical Module Console route — the old admin
            path redirects so bookmarks and stale links keep working. */}
        <Route path="/admin/modules/:id">
          {(params) => <Redirect to={`/modules/${params.id}`} replace />}
        </Route>
        <Route path="/settings">
          <Settings />
        </Route>
        {/* SOS Operations section — the old standalone SOS Dashboard is folded
            into Business Bookings (its KPI stats now render there) */}
        <Route path="/sos">
          <Redirect to="/sos/bookings" replace />
        </Route>
        {/* Live Operations now lives on the Command Center landing page */}
        <Route path="/sos/operations">
          <Redirect to="/" replace />
        </Route>
        {/* Calendar is now a view inside Business Bookings */}
        <Route path="/sos/calendar">
          <Redirect to="/sos/bookings" replace />
        </Route>
        {/* Customers (and its Plans tab) is now folded into Business Bookings —
            preserve tab + customer-id deep links from old URLs. */}
        <Route path="/sos/customers">
          <RedirectSosCustomers />
        </Route>
        {/* Point of Sale is folded into Business Bookings (tickets + in-service) */}
        <Route path="/sos/pos">
          <Redirect to="/sos/bookings" replace />
        </Route>
        {/* Reports is now a tab inside Business Bookings */}
        <Route path="/sos/reports">
          <Redirect to="/sos/bookings?tab=reports" replace />
        </Route>
        <Route path="/sos/bookings" component={SosBookings} />
        {/* Membership plan management is now a tab inside Business Bookings */}
        <Route path="/sos/memberships">
          <Redirect to="/sos/bookings?tab=plans" replace />
        </Route>
        {/* The AI Receptionist console is now a tab inside Business Bookings.
            The tenant-scoped embed (/tenants/:id?tab=ai-receptionist) is
            unaffected. */}
        <Route path="/sos/ai-receptionist">
          <Redirect to="/sos/bookings?tab=ai-receptionist" replace />
        </Route>
        {/* Old Marketing & Comms page — its receptionist and SMS tabs are now
            part of the AI Receptionist tab in Business Bookings. */}
        <Route path="/sos/marketing">
          <Redirect to="/sos/bookings?tab=ai-receptionist" replace />
        </Route>
        {/* Old standalone SOS settings page — folded into the unified Configuration screen */}
        <Route path="/sos/settings">
          <Redirect to="/settings" replace />
        </Route>
        {/* Partner Services is merged into the Partners tab of the Operations
            hub — its old URL and the four former per-partner placeholder URLs
            all redirect to /partners. */}
        <Route path="/sos/partner-services">
          <Redirect to="/partners" replace />
        </Route>
        <Route path="/sos/employees">
          <Redirect to="/partners" replace />
        </Route>
        <Route path="/sos/payroll">
          <Redirect to="/partners" replace />
        </Route>
        <Route path="/sos/business-protection">
          <Redirect to="/partners" replace />
        </Route>
        <Route path="/sos/employee-benefits">
          <Redirect to="/partners" replace />
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
