import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/layout/Shell';

import Dashboard from '@/pages/Dashboard';
import Tenants from '@/pages/Tenants';
import Marketing from '@/pages/Marketing';
import Operations from '@/pages/Operations';
import Partners from '@/pages/Partners';
import Media from '@/pages/Media';
import Billing from '@/pages/Billing';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();

function Router() {
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
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
