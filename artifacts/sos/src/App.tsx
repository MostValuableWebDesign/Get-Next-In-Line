import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';

import { Shell } from '@/components/layout/shell';
import { DashboardPage } from '@/pages/dashboard';
import { OperationsPage } from '@/pages/operations';
import { CalendarPage } from '@/pages/calendar';
import { CustomersPage } from '@/pages/customers';
import { ReportsPage } from '@/pages/reports';
import { SettingsPage } from '@/pages/settings';
import { PosPage } from '@/pages/pos';
import { MarketingPage } from '@/pages/marketing';
import { EmployeesPage, PayrollPage, BusinessProtectionPage, EmployeeBenefitsPage } from '@/pages/static-pages';

const queryClient = new QueryClient();

function Router() {
  return (
    <Shell>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/operations" component={OperationsPage} />
        <Route path="/calendar" component={CalendarPage} />
        <Route path="/customers" component={CustomersPage} />
        <Route path="/pos" component={PosPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/marketing" component={MarketingPage} />
        
        {/* Static Pages */}
        <Route path="/employees" component={EmployeesPage} />
        <Route path="/payroll" component={PayrollPage} />
        <Route path="/business-protection" component={BusinessProtectionPage} />
        <Route path="/employee-benefits" component={EmployeeBenefitsPage} />
        
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
