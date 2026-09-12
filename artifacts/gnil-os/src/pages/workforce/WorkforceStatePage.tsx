import { CapabilityStateView } from "./CapabilityStateView";

export function WorkforceStatePage() {
  return (
    <CapabilityStateView 
      capability="employees" 
      title="Staff & Workforce" 
      description="Employee and contractor directory syncing."
    />
  );
}
