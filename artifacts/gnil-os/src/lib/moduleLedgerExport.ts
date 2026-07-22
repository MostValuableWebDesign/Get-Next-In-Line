/**
 * Client-side CSV export for a module's tenant-assignment ledger.
 * Rows come from the admin module-detail endpoint when available (includes
 * cadence + MRR contribution) or from the public module-tenants list.
 */

export interface ModuleLedgerRow {
  tenantId: number;
  brandName: string;
  subdomain: string;
  status: string;
  provisionedAt: string;
  cadence: string;
  /** Monthly revenue contribution in dollars; empty when unknown. */
  mrrContribution?: number | null;
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildModuleLedgerCsv(moduleName: string, rows: ModuleLedgerRow[]): string {
  const header = [
    'Module',
    'Tenant ID',
    'Brand Name',
    'Subdomain',
    'Status',
    'Provisioned At',
    'Billing Cadence',
    'MRR Contribution',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(moduleName),
        String(r.tenantId),
        csvEscape(r.brandName),
        csvEscape(r.subdomain),
        csvEscape(r.status),
        csvEscape(r.provisionedAt),
        csvEscape(r.cadence),
        r.mrrContribution != null ? r.mrrContribution.toFixed(2) : '',
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** Builds the CSV and triggers a browser download. Returns the filename. */
export function downloadModuleLedgerCsv(moduleName: string, rows: ModuleLedgerRow[]): string {
  const csv = buildModuleLedgerCsv(moduleName, rows);
  const slug = moduleName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'module';
  const filename = `${slug}-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}
