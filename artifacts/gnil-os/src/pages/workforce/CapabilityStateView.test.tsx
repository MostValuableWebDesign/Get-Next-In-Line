import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CapabilityStateView } from "./CapabilityStateView";
import * as apiClient from "@workspace/api-client-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual("@workspace/api-client-react");
  return {
    ...actual,
    useGetOperationsOverview: vi.fn(),
  };
});

describe("CapabilityStateView", () => {
  const queryClient = new QueryClient();

  const renderComponent = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <CapabilityStateView 
          capability="time_tracking" 
          title="Time & Attendance" 
          description="Track hours, manage shifts, and handle time off."
        />
      </QueryClientProvider>
    );

  it("shows exact unavailable copy when no provider is connected", () => {
    vi.mocked(apiClient.useGetOperationsOverview).mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        capabilityAssignments: [
          { capability: "time_tracking", state: "unavailable", providerId: null }
        ],
        providers: []
      },
    } as any);

    renderComponent();
    expect(screen.getByText("No provider currently manages this capability.")).toBeInTheDocument();
  });
});
