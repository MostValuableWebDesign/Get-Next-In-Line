import React from 'react';
import { StaticPlaceholderPage } from '@/components/static-page';

export function EmployeesPage() {
  return (
    <StaticPlaceholderPage
      title="Team Management"
      partner="Deel"
      description="Manage your entire workforce from a single dashboard. Onboard new staff, track hours, and manage schedules with automated compliance."
      features={[
        "Automated Onboarding Flows",
        "Time & Attendance Tracking",
        "Shift Scheduling",
        "Performance Reviews"
      ]}
    />
  );
}

export function PayrollPage() {
  return (
    <StaticPlaceholderPage
      title="Payroll & Compliance"
      partner="Gusto"
      description="Run payroll in minutes. We handle tax filings, W-2s, and 1099s automatically so you can focus on running your business."
      features={[
        "Next-Day Direct Deposit",
        "Automated Tax Filings",
        "Contractor Payments",
        "Time Tracking Sync"
      ]}
    />
  );
}

export function BusinessProtectionPage() {
  return (
    <StaticPlaceholderPage
      title="Business Protection"
      partner="Next Insurance"
      description="Comprehensive coverage tailored to your industry. Get insured in minutes and manage your certificates of insurance directly from SOS."
      features={[
        "General Liability",
        "Professional Liability",
        "Workers' Compensation",
        "Instant COI Generation"
      ]}
    />
  );
}

export function EmployeeBenefitsPage() {
  return (
    <StaticPlaceholderPage
      title="Employee Benefits"
      partner="Guideline"
      description="Offer Fortune 500 benefits to your team. 401(k), health, dental, and vision plans fully integrated with your payroll."
      features={[
        "Zero-Fee 401(k) Administration",
        "National Health Networks",
        "Flexible Spending Accounts",
        "Automated Payroll Deductions"
      ]}
    />
  );
}
