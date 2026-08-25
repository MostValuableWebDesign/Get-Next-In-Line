import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter, Redirect, useSearch } from "wouter";
import { Shell } from "@/components/layout/Shell";
import { useAuth } from "@/hooks/useAuth";

import CommandCenter from "@/pages/Dashboard";
import TenantDetail from "@/pages/TenantDetail";
import OperationsHub from "@/pages/OperationsHub";
import ModuleConsole from "@/pages/ModuleConsole";
import Login from "@/pages/Login";
import PublicBookingPage from "@/pages/public-booking";
import PublicCheckInPage, {
  PublicCheckInStatusPage,
  PublicCheckInStatusUnavailablePage,
} from "@/pages/public-checkin";
import JoinInvitePage from "@/pages/join-invite";
import WalletPage from "@/pages/wallet";
import { ApplyPage, ApplyStatusPage } from "@/pages/apply";
import NotFound from "@/pages/not-found";
import PrivacyPolicyPage from "@/pages/privacy-policy";
import TermsOfServicePage from "@/pages/terms-of-service";

// SOS Operations section (merged from the former standalone SOS app)
import { BookingsPage as SosBookings } from "@/pages/sos/bookings";
import TaxCompliancePage from "@/pages/sos/tax-compliance";
import { SosTenantSync } from "@/lib/sos-tenant";

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
  const tenant = params.get('tenant');
  const to = `/sos/bookings?tab=${tab}${customer ? `&customer=${encodeURIComponent(customer)}` : ''}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}`;
  return <Redirect to={to} replace />;
}

/**
 * Redirect an old standalone SOS page into Business Bookings, preserving the
 * selected-business context (?tenant=<id>) so links from a tenant's
 * Configuration page land on that business's scoped view.
 */
function RedirectSosBookings({ tab }: { tab?: string }) {
  const params = new URLSearchParams(useSearch());
  const out = new URLSearchParams();
  if (tab) out.set('tab', tab);
  const tenant = params.get('tenant');
  if (tenant) out.set('tenant', tenant);
  const q = out.toString();
  return <Redirect to={q ? `/sos/bookings?${q}` : '/sos/bookings'} replace />;
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
        {/* Command Center hub — tabs for Dashboard (/), Tenants (/tenants),
            Billing (/billing), and Agency Settings (/settings). Each tab
            keeps its own URL so old links/bookmarks land on the right tab. */}
        <Route path="/" component={CommandCenter} />
        <Route path="/master" component={CommandCenter} />
        <Route path="/tenants" component={CommandCenter} />
        <Route path="/governance" component={CommandCenter} />
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
        {/* Old GNIL Bridge marketing URL — its modules were folded into the
            White-Label Resale Engines (Media) tab, which this now selects */}
        <Route path="/marketing" component={OperationsHub} />
        {/* Unified Operations hub — Modules tab */}
        <Route path="/operations" component={OperationsHub} />
        {/* Unified Operations hub — merged Partners tab (grid + services) */}
        <Route path="/partners" component={OperationsHub} />
        {/* Unified Operations hub — Media tab (old Media & Assets page URL) */}
        <Route path="/media" component={OperationsHub} />
        <Route path="/modules/:id" component={ModuleConsole} />
        <Route path="/billing" component={CommandCenter} />
        <Route path="/compliance" component={CommandCenter} />
        <Route path="/partnerships" component={CommandCenter} />
        <Route path="/franchise" component={CommandCenter} />
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
        <Route path="/settings" component={CommandCenter} />
        {/* SOS Operations section — the old standalone SOS Dashboard is folded
            into Business Bookings (its KPI stats now render there) */}
        <Route path="/sos">
          <RedirectSosBookings />
        </Route>
        {/* Live Operations now lives on the Command Center landing page */}
        <Route path="/sos/operations">
          <Redirect to="/" replace />
        </Route>
        {/* Calendar is now a view inside Business Bookings */}
        <Route path="/sos/calendar">
          <RedirectSosBookings />
        </Route>
        {/* Customers (and its Plans tab) is now folded into Business Bookings —
            preserve tab + customer-id deep links from old URLs. */}
        <Route path="/sos/customers">
          <RedirectSosCustomers />
        </Route>
        {/* Point of Sale is folded into Business Bookings (tickets + in-service) */}
        <Route path="/sos/pos">
          <RedirectSosBookings />
        </Route>
        {/* Reports is now a tab inside Business Bookings */}
        <Route path="/sos/reports">
          <RedirectSosBookings tab="reports" />
        </Route>
        <Route path="/sos/bookings" component={SosBookings} />
        {/* Co-Op Tax & Revenue Compliance Ledger — tenant scope via ?tenant= */}
        <Route path="/sos/tax-compliance" component={TaxCompliancePage} />
        {/* Membership plan management is now a tab inside Business Bookings */}
        <Route path="/sos/memberships">
          <RedirectSosBookings tab="plans" />
        </Route>
        {/* The AI Receptionist console is now a tab inside Business Bookings.
            The tenant-scoped embed (/tenants/:id?tab=ai-receptionist) is
            unaffected. */}
        <Route path="/sos/ai-receptionist">
          <RedirectSosBookings tab="ai-receptionist" />
        </Route>
        {/* Old Marketing & Comms page — its receptionist and SMS tabs are now
            part of the AI Receptionist tab in Business Bookings. */}
        <Route path="/sos/marketing">
          <RedirectSosBookings tab="ai-receptionist" />
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
      {/* Public no-login booking page (also the embeddable widget with
          ?embed=1) — must stay outside ProtectedApp so customers can book
          without an account. */}
      <Route path="/book/:slug">
        {(params) => <PublicBookingPage slug={params.slug} />}
      </Route>
      {/* Public digital queue check-in — the visible A2P SMS opt-in CTA. */}
      <Route path="/check-in/:slug/status/:visitId">
        {(params) =>
          /^\d+$/.test(params.visitId) ? (
            <PublicCheckInStatusPage
              slug={params.slug}
              visitId={Number(params.visitId)}
            />
          ) : (
            <NotFound />
          )
        }
      </Route>
      <Route path="/check-in/:slug">
        {(params) => <PublicCheckInPage slug={params.slug} />}
      </Route>
      {/* Public platform-invite fast-track registration — the invited
          business owner has no account yet, so this must stay outside
          ProtectedApp. Token validity is enforced server-side. */}
      {/* Public customer "Local Perks" wallet — phone/SMS sign-in, no staff
          account. Must stay outside ProtectedApp. */}
      <Route path="/wallet" component={WalletPage} />
      {/* Public co-op join application + applicant status page — the
          applying business has no account yet, so these stay outside
          ProtectedApp. */}
      <Route path="/apply" component={ApplyPage} />
      <Route path="/apply/:token">
        {(params) => <ApplyStatusPage token={params.token} />}
      </Route>
      <Route path="/join/:token">
        {(params) => <JoinInvitePage token={params.token} />}
      </Route>
      {/* Public legal pages — no login required */}
      <Route path="/privacy" component={PrivacyPolicyPage} />
      <Route path="/terms" component={TermsOfServicePage} />
      <Route component={ProtectedApp} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          {/* Keeps the x-tenant-id scope on /api/sos/* requests in sync with
              the ?tenant= param on SOS pages (legacy view elsewhere). */}
          <SosTenantSync />
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
