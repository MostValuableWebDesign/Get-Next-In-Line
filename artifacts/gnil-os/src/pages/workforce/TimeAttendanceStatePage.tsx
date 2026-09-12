import { CapabilityStateView } from "./CapabilityStateView";

export function TimeAttendanceStatePage() {
  return (
    <CapabilityStateView 
      capability="time_tracking" 
      title="Time & Attendance" 
      description="Timesheets, PTO balances, and attendance records."
    />
  );
}
