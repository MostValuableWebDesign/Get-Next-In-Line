---
name: Workforce provider metadata
description: Why provider capability metadata is isolated from executable adapters.
---

Provider definitions used during OAuth capability reconciliation must remain importable without loading provider adapters or OAuth services.

**Why:** Loading the full provider registry from OAuth reconciliation created a circular dependency through the Gusto adapter, leaving the registered provider undefined in some import orders.

**How to apply:** Put provider identity, capabilities, and required scopes in a metadata-only module. Reconciliation may depend on that module; executable provider lookup may depend on both metadata and adapters.