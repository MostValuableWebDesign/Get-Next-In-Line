import { CapabilityStateView } from "./CapabilityStateView";

export function SchedulingStatePage() {
  return (
    <CapabilityStateView 
      capability="scheduling" 
      title="Scheduling" 
      description="Shift management and schedule synchronization."
    />
  );
}
