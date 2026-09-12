import type { WorkforceProvider, WorkforceProviderDefinition } from "./types";
import { gustoProvider } from "./gustoProvider";
import { listWorkforceProviderDefinitions } from "./providerDefinitions";

const PROVIDERS: readonly WorkforceProvider[] = [gustoProvider];

export function listWorkforceProviders(): readonly WorkforceProviderDefinition[] {
  return listWorkforceProviderDefinitions();
}

export function getWorkforceProvider(providerId: string): WorkforceProvider {
  const provider = PROVIDERS.find((candidate) => candidate.definition.providerId === providerId);
  if (!provider) {
    throw new UnknownWorkforceProviderError(providerId);
  }
  return provider;
}

export class UnknownWorkforceProviderError extends Error {
  constructor(providerId: string) {
    super(`Unknown workforce provider: ${providerId}`);
    this.name = "UnknownWorkforceProviderError";
  }
}