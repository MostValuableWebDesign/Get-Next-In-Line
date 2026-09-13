import { render, screen, waitFor } from "@testing-library/react";
import { describe, test, expect, vi } from "vitest";
import App from "../App";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router as WouterRouter } from "wouter";

// Mock matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // Deprecated
    removeListener: vi.fn(), // Deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock hooks
vi.mock("@/hooks/useAuth", () => {
  let currentRole: string | null = "merchant";
  
  return {
    useAuth: () => ({ authState: "authenticated" }),
    useSessionRole: () => currentRole,
    // Test helper to switch roles
    __setMockRole: (role: string) => { currentRole = role; }
  };
});

// Mock network calls for App
vi.mock("@workspace/api-client-react", () => ({
  useGetAgencyDashboard: () => ({ data: null, isLoading: true }),
  useGetTenantActivity: () => ({ data: null, isLoading: true }),
  useListTenants: () => ({ data: [], isLoading: true }),
  useGetTenant: () => ({ data: null, isLoading: true }),
  useGetTenantModules: () => ({ data: [], isLoading: true }),
  useListModules: () => ({ data: [], isLoading: true }),
  useGetBillingSummary: () => ({ data: null, isLoading: true }),
  useListGovernanceUsers: () => ({ data: [], isLoading: true }),
  useListCoopApplications: () => ({ data: [], isLoading: true }),
  useListFranchiseOrgs: () => ({ data: [], isLoading: true }),
  useGetFranchiseRollup: () => ({ data: null, isLoading: true }),
  useHealthCheck: () => ({ data: { status: 'ok' }, isError: false, isFetched: true }),
  getHealthCheckQueryKey: () => ['health'],
  useGetModulesPricing: () => ({ data: [], isLoading: true }),
  useGetSosSettings: () => ({ data: null, isLoading: true }),
  useUpdateSosSettings: () => ({ mutate: () => {}, isPending: false }),
  useGetConnectorRegistry: () => ({ data: [], isLoading: true }),
  useGetTipSplitPreview: () => ({ data: null, isLoading: false }),
  useGetAgencySettings: () => ({ data: null, isLoading: true }),
}));

describe("Platform Control Plane Access", () => {
  const renderAppAt = (path: string) => {
    // Reset path
    window.history.pushState({}, "", path);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <WouterRouter>
          <App />
        </WouterRouter>
      </QueryClientProvider>
    );
  };

  test("merchant is denied access to /platform", async () => {
    const { __setMockRole } = await import("@/hooks/useAuth") as any;
    __setMockRole("merchant");
    
    renderAppAt("/platform");
    
    // Should see Access Denied screen instead of Dashboard
    expect(await screen.findByText("Access Denied")).toBeInTheDocument();
    expect(screen.getByText(/does not grant access to the platform control plane/i)).toBeInTheDocument();
  });

  test("staff is denied access to /platform/tenants", async () => {
    const { __setMockRole } = await import("@/hooks/useAuth") as any;
    __setMockRole("staff");
    
    renderAppAt("/platform/tenants");
    
    expect(await screen.findByText("Access Denied")).toBeInTheDocument();
  });
  
  test("district_manager is denied access to /platform/billing", async () => {
    const { __setMockRole } = await import("@/hooks/useAuth") as any;
    __setMockRole("district_manager");
    
    renderAppAt("/platform/billing");
    
    expect(await screen.findByText("Access Denied")).toBeInTheDocument();
  });

  test("super_admin is granted access to /platform and sees platform shell", async () => {
    const { __setMockRole } = await import("@/hooks/useAuth") as any;
    __setMockRole("super_admin");
    
    renderAppAt("/platform");
    
    // PlatformShell elements
    expect(await screen.findByText("Platform Control")).toBeInTheDocument();
    expect(screen.getByText("Exit to Merchant")).toBeInTheDocument();
    // Dashboard loading state mocked above
    expect(screen.getByText("Loading telemetry...")).toBeInTheDocument();
  });

  test("super_admin sees Platform Control link in merchant shell, merchant does not", async () => {
    const { __setMockRole } = await import("@/hooks/useAuth") as any;
    
    // As merchant
    __setMockRole("merchant");
    const { unmount } = renderAppAt("/");
    
    // Verify shell loaded by looking for standard nav
    const commandCenters = await screen.findAllByText("Command Center");
    expect(commandCenters.length).toBeGreaterThan(0);
    // Platform link should NOT be present
    expect(screen.queryByText("Platform Control")).not.toBeInTheDocument();
    unmount();
    
    // As super_admin
    __setMockRole("super_admin");
    renderAppAt("/");
    
    expect((await screen.findAllByText("Command Center")).length).toBeGreaterThan(0);
    // Platform link SHOULD be present
    expect(screen.getByText("Platform Control")).toBeInTheDocument();
  });
});
