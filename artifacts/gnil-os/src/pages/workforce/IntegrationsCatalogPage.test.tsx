import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    useReconcileGusto: vi.fn(),
    useSyncGustoWorkforce: vi.fn(),
    useSyncGustoPayrollReadOnly: vi.fn(),
    useSyncGustoCompensationReadOnly: vi.fn(),
  };
});

describe("IntegrationsCatalogPage", () => {
  const queryClient = new QueryClient();
  beforeEach(() => {
    vi.mocked(apiClient.useReconcileGusto).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as any);
  });

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
        capabilityAssignments: [
          { capability: "employees", providerId: "gusto", state: "connected" },
          { capability: "payroll", providerId: "gusto", state: "connected" },
          { capability: "compensation", providerId: "gusto", state: "connected" },
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
    expect(screen.getByRole("menuitem", { name: /Sync staff/i })).not.toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: /Sync payroll/i })).not.toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: /Sync compensation/i })).not.toHaveAttribute("data-disabled");
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
        capabilityAssignments: [
          { capability: "employees", providerId: "gusto", state: "connected" },
          { capability: "payroll", providerId: "gusto", state: "connected" },
          { capability: "compensation", providerId: "gusto", state: "connected" },
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

  it("shows Retry Setup only for the capability-configuration degraded state and refreshes overview", async () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        providers: [{
          providerId: "gusto",
          name: "Gusto",
          description: "Payroll",
          status: "degraded",
          capabilities: ["employees", "payroll", "compensation"],
          connectedAt: "2023-10-18T00:00:00Z",
          lastSuccessfulSyncAt: null,
          lastError: "Capability configuration failed. Retry integration setup.",
          preferred: true,
        }],
        capabilityAssignments: [],
      },
    } as any);
    vi.mocked(apiClient.useConnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useDisconnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoWorkforce).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoPayrollReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoCompensationReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    const mutate = vi.fn();
    let reconcileSuccess: (() => void) | undefined;
    vi.mocked(apiClient.useReconcileGusto).mockImplementation(((options: any) => {
      reconcileSuccess = options.mutation.onSuccess;
      return { mutate, isPending: false };
    }) as any);
    const invalidateQueriesSpy = vi.spyOn(queryClient, "invalidateQueries");

    renderComponent();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Retry Setup" }));

    expect(mutate).toHaveBeenCalledOnce();
    reconcileSuccess!();
    expect(invalidateQueriesSpy).toHaveBeenCalledWith({
      queryKey: apiClient.getGetOperationsOverviewQueryKey(),
    });
  });

  it.each([
    { status: "connected", lastError: null },
    { status: "degraded", lastError: "Payroll sync failed" },
    { status: "reauthorization_required", lastError: "Gusto authorization required" },
  ])("does not show Retry Setup for $status with an unrelated condition", async ({ status, lastError }) => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        providers: [{
          providerId: "gusto",
          name: "Gusto",
          description: "Payroll",
          status,
          capabilities: ["employees", "payroll", "compensation"],
          connectedAt: "2023-10-18T00:00:00Z",
          lastSuccessfulSyncAt: null,
          lastError,
          preferred: true,
        }],
        capabilityAssignments: [],
      },
    } as any);
    vi.mocked(apiClient.useConnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useDisconnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoWorkforce).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoPayrollReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoCompensationReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);

    renderComponent();
    const manage = screen.queryByRole("button", { name: /Manage/i });
    if (manage) await userEvent.click(manage);
    expect(screen.queryByText("Retry Setup")).not.toBeInTheDocument();
  });

  it.each([
    {
      name: "payroll is owned by another provider",
      assignments: [
        { capability: "employees", providerId: "gusto", state: "connected" },
        { capability: "payroll", providerId: "adp", state: "connected" },
        { capability: "compensation", providerId: "gusto", state: "connected" },
      ],
      action: "Sync payroll",
      reason: "Managed by another provider",
    },
    {
      name: "compensation needs another scope",
      assignments: [
        { capability: "employees", providerId: "gusto", state: "connected" },
        { capability: "payroll", providerId: "gusto", state: "connected" },
        { capability: "compensation", providerId: "gusto", state: "missing_scope" },
      ],
      action: "Sync compensation",
      reason: "Additional Gusto permission required",
    },
    {
      name: "payroll capability failed",
      assignments: [
        { capability: "employees", providerId: "gusto", state: "connected" },
        { capability: "payroll", providerId: "gusto", state: "failed" },
        { capability: "compensation", providerId: "gusto", state: "connected" },
      ],
      action: "Sync payroll",
      reason: "Capability sync needs attention",
    },
  ])("disables unavailable actions when $name", async ({ assignments, action, reason }) => {
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
            capabilities: ["employees", "payroll", "compensation"],
            connectedAt: "2023-10-18T00:00:00Z",
            lastSuccessfulSyncAt: null,
            lastError: null,
            preferred: true,
          },
        ],
        capabilityAssignments: assignments,
      },
    } as any);
    vi.mocked(apiClient.useConnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useDisconnectGusto).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoWorkforce).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoPayrollReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);
    vi.mocked(apiClient.useSyncGustoCompensationReadOnly).mockReturnValue({ mutate: vi.fn(), isPending: false } as any);

    renderComponent();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: new RegExp(action, "i") })).toHaveAttribute(
      "data-disabled",
    );
  });
});
