import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch, Router as WouterRouter, Redirect } from "wouter";
import { Shell } from "@/components/layout/Shell";
import { useAuth } from "@/hooks/useAuth";

import Dashboard from "@/pages/Dashboard";
import Tenants from "@/pages/Tenants";
import Marketing from "@/pages/Marketing";
import Operations from "@/pages/Operations";
import Partners from "@/pages/Partners";
import Media from "@/pages/Media";
import Billing from "@/pages/Billing";
import ConnectorRegistry from "@/pages/ConnectorRegistry";
import Login from "@/pages/Login";
import NotFound from "@/pages/not-found";

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
        <Route path="/marketing" component={Marketing} />
        <Route path="/operations" component={Operations} />
        <Route path="/partners" component={Partners} />
        <Route path="/media" component={Media} />
        <Route path="/billing" component={Billing} />
        <Route path="/connectors" component={ConnectorRegistry} />
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
