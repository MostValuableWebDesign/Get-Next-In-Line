import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsCatalogPage } from "./IntegrationsCatalogPage";
import * as apiClient from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useGetOperationsOverview: vi.fn(),
    useConnectGusto: vi.fn(),
    useDisconnectGusto: vi.fn(),
    useSyncGustoWorkforce: vi.fn(),
    useSyncGustoPayrollReadOnly: vi.fn(),
    useSyncGustoCompensationReadOnly: vi.fn(),
  };
});

describe("IntegrationsCatalogPage", () => {
  const queryClient = new QueryClient();

  const renderComponent = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <IntegrationsCatalogPage />
      </QueryClientProvider>
    );

  it("renders specific sync buttons for Gusto", async () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        providers: [
          {
            providerId: "gusto",
            name: "Gusto",
            description: "Payroll",
            status: "connected",
            capabilities: ["payroll", "compensation", "employees"],
            connectedAt: "2023-10-18T00:00:00Z",
            lastSuccessfulSyncAt: "2023-10-18T00:00:00Z",
            lastError: null,
            preferred: true,
          }
        ],
      },
    } as any);

    vi.mocked(apiClient.useConnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useDisconnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoWorkforce).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoPayrollReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoCompensationReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);

    renderComponent();
    
    const manageBtn = screen.getByRole("button", { name: /Manage/i });
    await userEvent.click(manageBtn);

    expect(await screen.findByText("Sync staff")).toBeInTheDocument();
    expect(screen.getByText("Sync payroll")).toBeInTheDocument();
    expect(screen.getByText("Sync compensation")).toBeInTheDocument();
  });

  it("invalidates both overview and specific data queries on sync success", async () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        providers: [
          {
            providerId: "gusto",
            name: "Gusto",
            description: "Payroll",
            status: "connected",
            capabilities: ["payroll", "compensation", "employees"],
            connectedAt: "2023-10-18T00:00:00Z",
            lastSuccessfulSyncAt: "2023-10-18T00:00:00Z",
            lastError: null,
            preferred: true,
          }
        ],
      },
    } as any);

    // Provide a mocked mutation function that we can inspect
    let workforceSyncSuccess: (() => void) | undefined;
    vi.mocked(apiClient.useSyncGustoWorkforce).mockImplementation(((options: any) => {
      workforceSyncSuccess = options.mutation.onSuccess;
      return { mutate: vi.fn(), isPending: false };
    }) as any);
    
    let payrollSyncSuccess: (() => void) | undefined;
    vi.mocked(apiClient.useSyncGustoPayrollReadOnly).mockImplementation(((options: any) => {
      payrollSyncSuccess = options.mutation.onSuccess;
      return { mutate: vi.fn(), isPending: false };
    }) as any);
    
    let compSyncSuccess: (() => void) | undefined;
    vi.mocked(apiClient.useSyncGustoCompensationReadOnly).mockImplementation(((options: any) => {
      compSyncSuccess = options.mutation.onSuccess;
      return { mutate: vi.fn(), isPending: false };
    }) as any);

    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderComponent();

    // Trigger workforce sync success
    expect(workforceSyncSuccess).toBeDefined();
    workforceSyncSuccess!();
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: apiClient.getGetOperationsOverviewQueryKey() });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: apiClient.getListOperationsWorkforceQueryKey() });
    invalidateQueriesSpy.mockClear();
    
    // Trigger payroll sync success
    expect(payrollSyncSuccess).toBeDefined();
    payrollSyncSuccess!();
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: apiClient.getGetOperationsOverviewQueryKey() });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: apiClient.getListOperationsPayrollQueryKey() });
    invalidateQueriesSpy.mockClear();

    // Trigger compensation sync success
    expect(compSyncSuccess).toBeDefined();
    compSyncSuccess!();
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: apiClient.getGetOperationsOverviewQueryKey() });
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({ queryKey: apiClient.getListOperationsCompensationQueryKey() });
  });
});
