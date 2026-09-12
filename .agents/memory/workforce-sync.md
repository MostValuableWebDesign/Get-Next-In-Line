---
name: Workforce synchronization
description: Authority, identity-linking, and lifecycle rules for external workforce imports.
---

External workforce providers may update only normalized provider-owned records for capabilities explicitly assigned to them. Employee, payroll, and compensation synchronization remain independent. Missing records and omitted optional values are retained; imports never update GNIL operational or payroll-processing records.

**Why:** GNIL remains authoritative for salon and barbershop operations, while provider list responses and scopes can be incomplete or change over time. One capability failure must not erase good data or misstate another capability.

**How to apply:** Require primary ownership and required granted scopes before sync. Track success/failure per capability, serialize lifecycle and sync per tenant, and preserve exact money as decimal cent strings through storage/API/UI. Auto-link only on exact, unique same-tenant email matches.