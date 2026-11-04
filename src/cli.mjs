import { AdoClient, selectAccessibleProjects } from './ado/client.mjs';
import { writeReport, writeCsv, failedDiscoveryResult, projectReportSummary, repositoryReportSummary, rollupOrganizationStatus, rollupProjectStatus, rollupRepositoryStatus, successfulDiscoveryResult } from './lib/report.mjs';

const env = process.env;
const command = process.argv[2];
const required = name => { if (!env[name]) throw new Error(`${name} is required`); return env[name]; };
const adoClient = () => new AdoClient(required('ADO_ORG_URL'), required('ADO_PAT'));
function safeProject(project) {
  return {
    id: project.id,
    name: project.name,
    state: project.state,
    visibility: project.visibility,
    lastUpdateTime: project.lastUpdateTime
  };
}
async function capture(task) {
  try { return successfulDiscoveryResult(await task()); }
  catch (error) { return failedDiscoveryResult(error); }
}
function safeRepositoryUrl(ado, url) {
  if (!url) return null;
  try { return ado.validateRepositoryUrl(url); }
  catch { return null; }
}
function buildPipelineSummary(definition) {
  return {
    id: definition.id, name: definition.name, path: definition.path, revision: definition.revision,
    queueStatus: definition.queueStatus, type: definition.type, createdDate: definition.createdDate,
    project: definition.project?.name
  };
}
function releasePipelineSummary(definition) {
  return {
    id: definition.id, name: definition.name, path: definition.path, revision: definition.revision,
    createdOn: definition.createdOn, modifiedOn: definition.modifiedOn,
    environments: (definition.environments ?? []).map(environment => ({ id: environment.id, name: environment.name, rank: environment.rank }))
  };
}
function repositoryPolicyMatches(policy, repositoryId) {
  const scopes = policy.settings?.scope;
  return !Array.isArray(scopes) || scopes.length === 0 || scopes.some(scope => !scope.repositoryId || scope.repositoryId === repositoryId);
}

async function discover() {
  const ado = adoClient();
  const pluralSelection = env.ADO_PROJECTS?.trim();
  const legacySelection = env.ADO_PROJECT?.trim();
  if (pluralSelection && legacySelection) throw new Error('Set either ADO_PROJECTS or ADO_PROJECT, not both.');

  const projectCatalog = await capture(() => ado.listProjects());
  const generatedAt = new Date().toISOString();
  const organizationUrl = new URL(required('ADO_ORG_URL')).toString().replace(/\/$/, '');
  if (projectCatalog.status !== 'SUCCESS') {
    const failureReport = {
      generatedAt,
      organizationUrl,
      accessibleProjectCount: null,
      selectedProjectCount: 0,
      projectCatalogStatus: projectCatalog.status,
      discoveryStatus: projectCatalog.status,
      error: projectCatalog.error,
      projects: [],
      projectInventories: [],
      repositories: []
    };
    await writeReport('ado-organization-inventory.json', failureReport);
    await writeCsv('ado-organization-inventory.csv', [{ organizationUrl, discoveryStatus: projectCatalog.status, error: projectCatalog.error }]);
    await writeReport('ado-project-inventory.json', { discoveryStatus: 'NOT_VERIFIED', error: projectCatalog.error, projects: [] });
    await writeCsv('ado-project-inventory.csv', [{ discoveryStatus: 'NOT_VERIFIED', error: projectCatalog.error }]);
    await writeReport('ado-repository-inventory.json', { discoveryStatus: 'NOT_VERIFIED', error: projectCatalog.error, repositories: [] });
    await writeCsv('ado-repository-inventory.csv', [{ discoveryStatus: 'NOT_VERIFIED', error: projectCatalog.error }]);
    await writeReport('ado-full-inventory.json', failureReport);
    throw new Error('ADO project discovery failed; see the organization inventory report.');
  }

  const accessibleProjects = projectCatalog.items;
  const selectedProjects = selectAccessibleProjects(accessibleProjects, [pluralSelection || legacySelection || '']);
  const projectInventories = [];

  for (const project of selectedProjects) {
    const [repositoryResult, policyResult, buildResult, releaseResult, endpointResult] = await Promise.all([
      capture(() => ado.listRepositories(project.id)),
      capture(() => ado.listBranchPolicies(project.id)),
      capture(() => ado.listBuildDefinitions(project.id)),
      capture(() => ado.listReleaseDefinitions(project.id)),
      capture(() => ado.listServiceEndpoints(project.id))
    ]);
    const repositories = [];
    for (const repo of repositoryResult.items) {
      const [branchResult, tagResult, commitResult, permissionResult, lfsResult] = await Promise.all([
        capture(() => ado.listRefs(project.id, repo.id)),
        capture(() => ado.listTags(project.id, repo.id)),
        capture(() => ado.listCommits(project.id, repo.id)),
        capture(() => ado.listRepositoryPermissions(project.id, repo.id)),
        capture(() => ado.detectLfsUsage(project.id, repo.id, repo.defaultBranch))
      ]);
      repositories.push({
        id: repo.id,
        projectId: project.id,
        projectName: project.name,
        name: repo.name,
        remoteUrl: safeRepositoryUrl(ado, repo.remoteUrl),
        defaultBranch: repo.defaultBranch,
        sizeBytes: repo.size ?? null,
        branches: branchResult.items.map(ref => ({ name: ref.name, objectId: ref.objectId })),
        branchesStatus: branchResult.status,
        branchesError: branchResult.error,
        tags: tagResult.items.map(ref => ({ name: ref.name, objectId: ref.objectId })),
        tagsStatus: tagResult.status,
        tagsError: tagResult.error,
        commits: commitResult.items.map(commit => ({
          commitId: commit.commitId,
          parents: commit.parents ?? [],
          author: commit.author?.name,
          authorDate: commit.author?.date,
          committer: commit.committer?.name,
          committerDate: commit.committer?.date
        })),
        commitsStatus: commitResult.status,
        commitsError: commitResult.error,
        lfs: lfsResult.items,
        lfsStatus: lfsResult.status === 'SUCCESS' ? (lfsResult.items.status ?? 'SUCCESS') : lfsResult.status,
        lfsObjectAvailabilityStatus: lfsResult.status === 'SUCCESS' ? (lfsResult.items.objectAvailabilityStatus ?? 'NOT_VERIFIED') : 'NOT_VERIFIED',
        lfsError: lfsResult.error,
        permissions: permissionResult.items,
        permissionsStatus: permissionResult.status,
        permissionsError: permissionResult.error,
        branchPolicies: policyResult.items.filter(policy => repositoryPolicyMatches(policy, repo.id)),
        branchPoliciesStatus: policyResult.status,
        discoveryStatus: rollupRepositoryStatus([
          branchResult.status,
          tagResult.status,
          commitResult.status,
          permissionResult.status,
          lfsResult.status === 'SUCCESS' ? (lfsResult.items.status ?? 'SUCCESS') : lfsResult.status,
          policyResult.status
        ])
      });
    }

    const inventory = {
      project: safeProject(project),
      repositoryInventoryStatus: repositoryResult.status,
      repositoryInventoryError: repositoryResult.error,
      repositories,
      branchPolicies: policyResult.items,
      branchPoliciesStatus: policyResult.status,
      branchPoliciesError: policyResult.error,
      buildPipelines: buildResult.items.map(buildPipelineSummary),
      buildPipelinesStatus: buildResult.status,
      buildPipelinesError: buildResult.error,
      releasePipelines: releaseResult.items.map(releasePipelineSummary),
      releasePipelinesStatus: releaseResult.status,
      releasePipelinesError: releaseResult.error,
      serviceConnections: endpointResult.items,
      serviceConnectionsStatus: endpointResult.status,
      serviceConnectionsError: endpointResult.error
    };
    inventory.discoveryStatus = rollupProjectStatus({
      repositoryInventoryStatus: repositoryResult.status,
      adapterStatuses: [policyResult.status, buildResult.status, releaseResult.status, endpointResult.status],
      repositoryStatuses: repositories.map(repository => repository.discoveryStatus)
    });
    projectInventories.push(inventory);
  }

  const selectedIds = new Set(selectedProjects.map(project => project.id));
  const projectStatusById = new Map(projectInventories.map(inventory => [inventory.project.id, inventory.discoveryStatus]));
  const organizationStatus = rollupOrganizationStatus({
    projectCatalogStatus: projectCatalog.status,
    projectStatuses: projectInventories.map(inventory => inventory.discoveryStatus),
    scopeComplete: selectedProjects.length === accessibleProjects.length
  });
  const organizationInventory = {
    generatedAt,
    organizationUrl,
    projectCatalogStatus: projectCatalog.status,
    discoveryStatus: organizationStatus,
    accessibleProjectCount: accessibleProjects.length,
    selectedProjectCount: selectedProjects.length,
    projects: accessibleProjects.map(project => ({
      ...safeProject(project),
      selected: selectedIds.has(project.id),
      discoveryStatus: projectStatusById.get(project.id) ?? 'NOT_VERIFIED'
    }))
  };
  const projectRows = projectInventories.map(projectReportSummary);
  const repositoryRows = projectInventories.flatMap(inventory => inventory.repositories.map(repositoryReportSummary));
  const branches = projectInventories.flatMap(inventory => inventory.repositories.flatMap(repo => repo.branches.map(branch => ({ project: repo.projectName, repository: repo.name, ...branch }))));
  const tags = projectInventories.flatMap(inventory => inventory.repositories.flatMap(repo => repo.tags.map(tag => ({ project: repo.projectName, repository: repo.name, ...tag }))));
  const commits = projectInventories.flatMap(inventory => inventory.repositories.flatMap(repo => repo.commits.map(commit => ({ project: repo.projectName, repository: repo.name, ...commit }))));
  const policies = projectInventories.flatMap(inventory => inventory.branchPolicies.map(policy => ({
    project: inventory.project.name,
    id: policy.id,
    revision: policy.revision,
    type: policy.type.name,
    enabled: policy.enabled,
    blocking: policy.blocking,
    minimumApproverCount: policy.settings.minimumApproverCount,
    buildDefinitionId: policy.settings.buildDefinitionId,
    scope: (policy.settings.scope ?? []).map(scope => `${scope.repositoryId ?? 'all'}:${scope.refName}:${scope.matchKind}`).join('; '),
    filenamePatterns: (policy.settings.filenamePatterns ?? []).join('; '),
    requiredReviewerIds: (policy.settings.requiredReviewerIds ?? []).join('; ')
  })));
  const buildPipelines = projectInventories.flatMap(inventory => inventory.buildPipelines.map(pipeline => ({ project: inventory.project.name, ...pipeline })));
  const releasePipelines = projectInventories.flatMap(inventory => inventory.releasePipelines.map(pipeline => ({ project: inventory.project.name, ...pipeline, environmentNames: pipeline.environments.map(environment => environment.name) })));
  const serviceConnections = projectInventories.flatMap(inventory => inventory.serviceConnections.map(endpoint => ({ project: inventory.project.name, ...endpoint, projectReferences: endpoint.projectReferences.map(reference => reference.projectName) })));
  const permissions = projectInventories.flatMap(inventory => inventory.repositories.flatMap(repo => repo.permissions.map(permission => ({ project: repo.projectName, repository: repo.name, ...permission }))));
  const fullInventory = { ...organizationInventory, projectInventories, repositories: projectInventories.flatMap(inventory => inventory.repositories) };

  await writeReport('ado-organization-inventory.json', organizationInventory);
  await writeCsv('ado-organization-inventory.csv', organizationInventory.projects);
  await writeReport('ado-project-inventory.json', projectInventories);
  await writeCsv('ado-project-inventory.csv', projectRows);
  await writeReport('ado-repository-inventory.json', projectInventories.flatMap(inventory => inventory.repositories));
  await writeCsv('ado-repository-inventory.csv', repositoryRows);
  await writeReport('ado-full-inventory.json', fullInventory);
  await writeCsv('ado-projects.csv', projectRows);
  await writeCsv('ado-repositories.csv', repositoryRows);
  await writeCsv('ado-branches.csv', branches);
  await writeCsv('ado-tags.csv', tags);
  await writeCsv('ado-commits.csv', commits);
  await writeCsv('ado-branch-policies.csv', policies);
  await writeCsv('ado-build-pipelines.csv', buildPipelines);
  await writeCsv('ado-release-pipelines.csv', releasePipelines);
  await writeCsv('ado-service-connections.csv', serviceConnections);
  await writeCsv('ado-repository-permissions.csv', permissions);
  console.log(`Discovery complete: ${accessibleProjects.length} accessible projects; ${selectedProjects.length} selected; ${repositoryRows.length} repositories inventoried.`);
}
try {
  if (command !== 'discover') throw new Error('Usage: node src/cli.mjs discover');
  await discover();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unexpected failure');
  process.exitCode = 1;
}
