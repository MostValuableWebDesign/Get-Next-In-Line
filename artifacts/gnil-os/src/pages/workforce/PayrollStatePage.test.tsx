import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PayrollStatePage } from "./PayrollStatePage";
import * as apiClient from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useListOperationsPayroll: vi.fn(),
    useGetOperationsOverview: vi.fn(),
  };
});

describe("PayrollStatePage", () => {
  const queryClient = new QueryClient();

  const renderComponent = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <PayrollStatePage />
      </QueryClientProvider>
    );

  it("shows loading state", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: true,
      data: undefined,
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsPayroll).mockReturnValue({
      isLoading: false,
      data: undefined,
      isError: false,
    } as any);

    renderComponent();
    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows error state", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      data: {
        capabilityAssignments: [{ capability: "payroll", state: "connected", providerId: "gusto" }],
        providers: [{ providerId: "gusto", status: "connected", name: "Gusto" }]
      },
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsPayroll).mockReturnValue({
      isLoading: false,
      data: undefined,
      isError: true,
    } as any);

    renderComponent();
    expect(screen.getByText(/Unable to load payroll/i)).toBeInTheDocument();
  });

  it("shows provider attention required when disconnected", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      data: {
        capabilityAssignments: [{ capability: "payroll", state: "connected", providerId: "gusto" }],
        providers: [{ providerId: "gusto", status: "error", name: "Gusto" }]
      },
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsPayroll).mockReturnValue({
      isLoading: false,
      data: [],
      isError: false,
    } as any);

    renderComponent();
    expect(screen.getByText(/Provider Attention Required/i)).toBeInTheDocument();
  });

  it("shows empty state and provider explanation copy", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      data: {
        capabilityAssignments: [{ capability: "payroll", state: "connected", providerId: "gusto" }],
        providers: [{ providerId: "gusto", status: "connected", name: "Gusto" }]
      },
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsPayroll).mockReturnValue({
      isLoading: false,
      data: [],
      isError: false,
    } as any);

    renderComponent();
    expect(
      screen.getByText(
        /Payroll is managed by Gusto. GNIL provides operational visibility into recent runs, not payroll processing./i
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/No payroll runs found./i)).toBeInTheDocument();
  });

  it("renders payroll data", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      data: {
        capabilityAssignments: [{ capability: "payroll", state: "connected", providerId: "gusto" }],
        providers: [{ providerId: "gusto", status: "connected", name: "Gusto" }]
      },
      isError: false,
    } as any);

    vi.mocked(apiClient.useListOperationsPayroll).mockReturnValue({
      isLoading: false,
      data: [
        {
          id: 1,
          status: "paid",
          payPeriodStart: "2023-10-01T00:00:00Z",
          payPeriodEnd: "2023-10-15T00:00:00Z",
          paymentDate: "2023-10-17T00:00:00Z",
          processed: true,
          processedDate: "2023-10-16T00:00:00Z",
          calculatedAt: null,
          grossPayCents: "500000", // $5,000.00
          netPayCents: "400000",   // $4,000.00
          currency: "USD",
          lastSyncedAt: "2023-10-18T00:00:00Z",
        },
      ],
      isError: false,
    } as any);

    renderComponent();
    
    // Check formatted money
    expect(screen.getByText("$5,000.00")).toBeInTheDocument();
    expect(screen.getByText("$4,000.00")).toBeInTheDocument();
    
    // Check status
    expect(screen.getByText("Paid")).toBeInTheDocument();
  });
});
