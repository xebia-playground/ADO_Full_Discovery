import { mkdir, writeFile } from 'node:fs/promises';

const discoveryStatuses = new Set(['SUCCESS', 'PARTIAL', 'FAILED', 'NOT_VERIFIED']);

export function successfulDiscoveryResult(items) {
  return { status: 'SUCCESS', items, error: null };
}

export function failedDiscoveryResult(error) {
  const status = [401, 403, 404].includes(error?.status) ? 'NOT_VERIFIED' : 'FAILED';
  return { status, items: [], error: error instanceof Error ? error.message : 'Unexpected API failure.' };
}

export function rollupDiscoveryStatus(statuses, { hasInventory = true, scopeComplete = true } = {}) {
  const validStatuses = statuses.filter(status => discoveryStatuses.has(status));
  if (!hasInventory) return validStatuses.includes('FAILED') ? 'FAILED' : 'NOT_VERIFIED';
  if (!scopeComplete || validStatuses.length === 0) return validStatuses.length === 0 ? 'NOT_VERIFIED' : 'PARTIAL';
  if (validStatuses.every(status => status === 'SUCCESS')) return 'SUCCESS';
  if (validStatuses.every(status => status === 'NOT_VERIFIED')) return 'NOT_VERIFIED';
  return 'PARTIAL';
}

export function rollupRepositoryStatus(statuses) {
  return rollupDiscoveryStatus(statuses, { hasInventory: true });
}

export function rollupProjectStatus({ repositoryInventoryStatus, adapterStatuses = [], repositoryStatuses = [] }) {
  return rollupDiscoveryStatus(
    [repositoryInventoryStatus, ...adapterStatuses, ...repositoryStatuses],
    { hasInventory: repositoryInventoryStatus === 'SUCCESS' }
  );
}

export function rollupOrganizationStatus({ projectCatalogStatus, projectStatuses = [], scopeComplete = true }) {
  return rollupDiscoveryStatus(
    [projectCatalogStatus, ...projectStatuses],
    { hasInventory: projectCatalogStatus === 'SUCCESS', scopeComplete }
  );
}

export function projectReportSummary(inventory) {
  return {
    ...inventory.project,
    repositoryCount: inventory.repositories.length,
    branchPolicyCount: inventory.branchPolicies.length,
    buildPipelineCount: inventory.buildPipelines.length,
    releasePipelineCount: inventory.releasePipelines.length,
    serviceConnectionCount: inventory.serviceConnections.length,
    repositoryInventoryStatus: inventory.repositoryInventoryStatus,
    repositoryInventoryError: inventory.repositoryInventoryError,
    branchPoliciesStatus: inventory.branchPoliciesStatus,
    branchPoliciesError: inventory.branchPoliciesError,
    buildPipelinesStatus: inventory.buildPipelinesStatus,
    buildPipelinesError: inventory.buildPipelinesError,
    releasePipelinesStatus: inventory.releasePipelinesStatus,
    releasePipelinesError: inventory.releasePipelinesError,
    serviceConnectionsStatus: inventory.serviceConnectionsStatus,
    serviceConnectionsError: inventory.serviceConnectionsError,
    discoveryStatus: inventory.discoveryStatus
  };
}

export function repositoryReportSummary(repo) {
  return {
    projectId: repo.projectId,
    project: repo.projectName,
    id: repo.id,
    name: repo.name,
    remoteUrl: repo.remoteUrl,
    defaultBranch: repo.defaultBranch,
    sizeBytes: repo.sizeBytes,
    branchCount: repo.branches.length,
    tagCount: repo.tags.length,
    commitCount: repo.commits.length,
    lfsConfigured: repo.lfs?.lfsConfigured ?? null,
    lfsDetection: repo.lfs?.detection ?? 'unavailable',
    branchesStatus: repo.branchesStatus,
    tagsStatus: repo.tagsStatus,
    commitsStatus: repo.commitsStatus,
    branchPoliciesStatus: repo.branchPoliciesStatus,
    permissionsStatus: repo.permissionsStatus,
    lfsStatus: repo.lfsStatus,
    lfsObjectAvailabilityStatus: repo.lfsObjectAvailabilityStatus,
    discoveryStatus: repo.discoveryStatus
  };
}

export function csv(rows) {
  if (!rows.length) return '';
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => {
    const text = String(value ?? '');
    const safeText = typeof value === 'string' && /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
    return `"${safeText.replaceAll('"', '""')}"`;
  };
  return [headers.map(cell).join(','), ...rows.map(row => headers.map(key => cell(Array.isArray(row[key]) ? row[key].join('; ') : row[key])).join(','))].join('\n');
}
export async function writeReport(name, data) {
  await mkdir('reports', { recursive: true });
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await writeFile(`reports/${name}`, content, { mode: 0o600 });
}
export async function writeCsv(name, rows) { await writeReport(name, csv(rows)); }
