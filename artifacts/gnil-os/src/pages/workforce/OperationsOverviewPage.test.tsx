import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OperationsOverviewPage } from "./OperationsOverviewPage";
import * as apiClient from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useGetOperationsOverview: vi.fn(),
  };
});

describe("OperationsOverviewPage", () => {
  const queryClient = new QueryClient();

  const renderComponent = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <OperationsOverviewPage />
      </QueryClientProvider>
    );

  it("shows workforce counts", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        connectedProviderCount: 1,
        attentionRequiredCount: 0,
        lastSuccessfulSyncAt: "2023-10-18T00:00:00Z",
        workforceCount: 42,
        unlinkedWorkforceCount: 3,
        capabilityAssignments: [],
        providers: []
      },
    } as any);

    renderComponent();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText(/3 unlinked/i)).toBeInTheDocument();
  });

  it("renders meaningful capability assignment labels based on state", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        connectedProviderCount: 1,
        attentionRequiredCount: 2,
        lastSuccessfulSyncAt: "2023-10-18T00:00:00Z",
        workforceCount: 42,
        unlinkedWorkforceCount: 3,
        providers: [],
        capabilityAssignments: [
          {
            capability: "employees",
            providerId: "gusto",
            providerName: "Gusto",
            state: "connected",
            providerStatus: "connected",
            missingScopes: [],
            syncStatus: null,
            syncLastError: null,
          },
          {
            capability: "payroll",
            providerId: "gusto",
            providerName: "Gusto",
            state: "missing_scope",
            providerStatus: "reauthorization_required",
            missingScopes: ["payroll:read", "payroll:write"],
            syncStatus: null,
            syncLastError: null,
          },
          {
            capability: "compensation",
            providerId: "gusto",
            providerName: "Gusto",
            state: "failed",
            providerStatus: "error",
            missingScopes: [],
            syncStatus: "failed",
            syncLastError: "Invalid token",
          },
          {
            capability: "time_tracking",
            providerId: "gusto",
            providerName: "Gusto",
            state: "unavailable",
            providerStatus: "disconnected",
            missingScopes: [],
            syncStatus: null,
            syncLastError: null,
          },
          {
            capability: "scheduling",
            providerId: null,
            providerName: null,
            state: "unavailable",
            providerStatus: null,
            missingScopes: [],
            syncStatus: null,
            syncLastError: null,
          }
        ],
      },
    } as any);

    renderComponent();
    
    // Connected
    expect(screen.getByText("Employees")).toBeInTheDocument();
    
    // Missing Scope
    expect(screen.getByText("Payroll")).toBeInTheDocument();
    expect(screen.getByText("Needs Auth")).toBeInTheDocument();
    expect(screen.getByText("Missing: payroll:read, payroll:write")).toBeInTheDocument();
    
    // Failed
    expect(screen.getByText("Compensation")).toBeInTheDocument();
    expect(screen.getByText("Sync Failed")).toBeInTheDocument();
    expect(screen.getByText("Invalid token")).toBeInTheDocument();
    
    // Unavailable but assigned
    expect(screen.getByText("Time Tracking")).toBeInTheDocument();
    expect(screen.getByText("disconnected")).toBeInTheDocument();
    
    // Not assigned
    expect(screen.getByText("Scheduling")).toBeInTheDocument();
    expect(screen.getByText("Not Assigned")).toBeInTheDocument();
    expect(screen.getByText("No provider connected")).toBeInTheDocument();
  });
});

