import { CapabilityStateView } from "./CapabilityStateView";

export function PayrollStatePage() {
  return (
    <CapabilityStateView 
      capability="payroll" 
      title="Payroll & Compensation" 
      description="W-2 and 1099 payroll runs, tax documentation, and compensation structures."
    />
  );
}
