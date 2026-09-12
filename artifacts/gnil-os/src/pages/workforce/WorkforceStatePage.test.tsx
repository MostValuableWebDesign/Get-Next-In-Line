import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkforceStatePage } from "./WorkforceStatePage";
import * as apiClient from "@workspace/api-client-react";
import * as useAuth from "@/hooks/useAuth";
import * as tenantScope from "@/lib/sos-tenant";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useListOperationsWorkforce: vi.fn(),
    useListOperationsCompensation: vi.fn(),
    useListSosStaff: vi.fn(),
    useLinkOperationsWorkforcePerson: vi.fn(),
  };
});

vi.mock("@/hooks/useAuth", () => ({
  useSessionRole: vi.fn(),
}));

vi.mock("@/lib/sos-tenant", () => ({
  getCurrentSosTenantId: vi.fn(),
}));

describe("WorkforceStatePage", () => {
  const queryClient = new QueryClient();

  beforeEach(() => {
    vi.mocked(tenantScope.getCurrentSosTenantId).mockReturnValue(1);
  });

  const renderComponent = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <WorkforceStatePage />
      </QueryClientProvider>
    );

  it("does not request tenant-owned workforce data until a business is selected", () => {
    vi.mocked(tenantScope.getCurrentSosTenantId).mockReturnValue(null);
    vi.mocked(useAuth.useSessionRole).mockReturnValue("super_admin");
    vi.mocked(apiClient.useListOperationsWorkforce).mockReturnValue({ isLoading: false } as any);
    vi.mocked(apiClient.useListOperationsCompensation).mockReturnValue({ isLoading: false } as any);
    vi.mocked(apiClient.useListSosStaff).mockReturnValue({ isLoading: false } as any);
    vi.mocked(apiClient.useLinkOperationsWorkforcePerson).mockReturnValue({ isPending: false } as any);

    renderComponent();

    expect(screen.getByRole("heading", { name: "Select a business" })).toBeInTheDocument();
    expect(apiClient.useListOperationsWorkforce).toHaveBeenCalledWith({
      query: expect.objectContaining({ enabled: false }),
    });
    expect(apiClient.useListOperationsCompensation).toHaveBeenCalledWith({
      query: expect.objectContaining({ enabled: false }),
    });
  });

  it("does not fetch or render compensation for staff role", () => {
    vi.mocked(useAuth.useSessionRole).mockReturnValue("staff");
    
    vi.mocked(apiClient.useListOperationsWorkforce).mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 1,
          providerId: "gusto",
          externalId: "ext1",
          personType: "employee",
          displayName: "Alice",
          employmentStatus: "active",
          lastSyncedAt: "2023-10-18T00:00:00Z",
          linked: false,
        },
      ],
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsCompensation).mockReturnValue({
      isLoading: false,
      data: undefined,
    } as any);

    vi.mocked(apiClient.useListSosStaff).mockReturnValue({
      isLoading: false,
      data: [],
    } as any);

    vi.mocked(apiClient.useLinkOperationsWorkforcePerson).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as any);

    renderComponent();
    
    // Compensation header should not exist
    expect(screen.queryByText("Compensation")).not.toBeInTheDocument();
  });

  it("renders compensation for privileged roles", () => {
    vi.mocked(useAuth.useSessionRole).mockReturnValue("super_admin");
    
    vi.mocked(apiClient.useListOperationsWorkforce).mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 1,
          providerId: "gusto",
          externalId: "ext1",
          personType: "employee",
          displayName: "Alice",
          employmentStatus: "active",
          lastSyncedAt: "2023-10-18T00:00:00Z",
          linked: false,
        },
      ],
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsCompensation).mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 42,
          workforcePersonId: 1,
          amountCents: "500000",
          currency: "USD",
          interval: "monthly",
          lastSyncedAt: "2023-10-18T00:00:00Z",
          displayName: null,
          effectiveFrom: null,
          effectiveTo: null,
        }
      ],
    } as any);

    vi.mocked(apiClient.useListSosStaff).mockReturnValue({
      isLoading: false,
      data: [],
    } as any);

    vi.mocked(apiClient.useLinkOperationsWorkforcePerson).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as any);

    renderComponent();
    
    // Compensation header should exist
    expect(screen.getByText("Compensation")).toBeInTheDocument();
    
    // Check formatted money
    expect(screen.getByText("$5,000.00 / monthly")).toBeInTheDocument();
  });

  it("handles compensation fetch error without blocking workforce rows", () => {
    vi.mocked(useAuth.useSessionRole).mockReturnValue("super_admin");
    
    vi.mocked(apiClient.useListOperationsWorkforce).mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 1,
          providerId: "gusto",
          externalId: "ext1",
          personType: "employee",
          displayName: "Bob",
          employmentStatus: "active",
          lastSyncedAt: "2023-10-18T00:00:00Z",
          linked: false,
        },
      ],
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsCompensation).mockReturnValue({
      isLoading: false,
      isError: true,
      data: undefined,
    } as any);

    vi.mocked(apiClient.useListSosStaff).mockReturnValue({
      isLoading: false,
      data: [],
    } as any);

    renderComponent();
    
    // Compensation error message should be visible
    expect(screen.getByText(/Unable to load compensation data/i)).toBeInTheDocument();
    
    // Workforce row should still render
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });
});
