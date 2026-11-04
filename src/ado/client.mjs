import { Buffer } from 'node:buffer';

const organizationNamePattern = /^[a-z0-9][a-z0-9._-]*$/i;
const visualStudioHostPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.visualstudio\.com$/i;
const gitRepositoryNamespaceId = '2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87';
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function appendQuery(path, values) {
  const [pathname, query = ''] = path.split('?');
  const parameters = new URLSearchParams(query);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === '') parameters.delete(key);
    else parameters.set(key, String(value));
  }
  return `${pathname}?${parameters.toString()}`;
}

function collectionValues(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.value)) {
    throw new Error('Azure DevOps API returned a malformed collection response.');
  }
  return data.value;
}

function recordKey(item) {
  for (const field of ['id', 'commitId', 'objectId', 'name', 'path', 'token']) {
    if (item?.[field] !== undefined && item[field] !== null) return `${field}:${item[field]}`;
  }
  return null;
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let failure;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (!failure && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try { results[index] = await callback(items[index], index); }
      catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

function retryDelay(response, attempt) {
  const retryAfter = response.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()));
  }
  const reset = Number(response.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(60_000, Math.max(0, reset * 1000 - Date.now()));
  return Math.min(8_000, 250 * (2 ** attempt));
}

function safeServiceUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safePolicySettings(settings = {}) {
  const allowedFields = [
    'minimumApproverCount', 'creatorVoteCounts', 'allowDownvotes', 'resetOnSourcePush',
    'requireVoteOnLastIteration', 'blockLastPusherVote', 'buildDefinitionId', 'filenamePatterns',
    'addedFilesOnly', 'requiredReviewerIds', 'statusChecks', 'manualQueueOnly', 'queueOnSourceUpdateOnly'
  ];
  const output = {};
  for (const field of allowedFields) {
    if (settings[field] !== undefined) output[field] = settings[field];
  }
  if (Array.isArray(settings.scope)) {
    output.scope = settings.scope.map(({ refName, matchKind, repositoryId }) => ({ refName, matchKind, repositoryId }));
  }
  return output;
}

function parseAdoUrl(value, { repository = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('Invalid Azure DevOps URL.');
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Azure DevOps URL.');
  }

  if (url.protocol !== 'https:') throw new Error('Azure DevOps URLs must use HTTPS.');
 if (url.password || url.port || url.search || url.hash) {
  throw new Error('Azure DevOps URL contains unsupported components.');
}

// Azure DevOps Git clone URLs may contain a username.
// Remove it before validating and using the URL.
url.username = '';

  const segments = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'dev.azure.com') {
    if (!organizationNamePattern.test(segments[0] ?? '') || (!repository && segments.length !== 1)) {
      throw new Error('Invalid Azure DevOps organization URL.');
    }
    if (repository && (segments.length < 3 || segments.at(-2) !== '_git')) {
      throw new Error('Invalid Azure DevOps repository URL.');
    }
    return url;
  }

  if (visualStudioHostPattern.test(url.hostname)) {
    if (!repository && segments.length > 1) throw new Error('Invalid Azure DevOps organization URL.');
    if (repository && (segments.length < 3 || segments.at(-2) !== '_git')) {
      throw new Error('Invalid Azure DevOps repository URL.');
    }
    return url;
  }

  throw new Error('Azure DevOps URL host is not approved.');
}

export function validateAdoRepositoryUrl(orgUrl, repositoryUrl) {
  const organization = parseAdoUrl(orgUrl);
  const repository = parseAdoUrl(repositoryUrl, { repository: true });
  const organizationPath = organization.pathname.replace(/\/+$/, '');
  const repositoryPrefix = organizationPath ? `${organizationPath}/` : '/';

  if (repository.origin !== organization.origin || !repository.pathname.startsWith(repositoryPrefix)) {
    throw new Error('Azure DevOps repository URL does not match the configured organization.');
  }

  return repository.toString();
}

export function selectAccessibleProjects(projects, requestedNames = []) {
  const requested = requestedNames.flatMap(name => String(name ?? '').split(',')).map(name => name.trim()).filter(Boolean);
  if (requested.length === 0) return projects;

  const byName = new Map(projects.map(project => [project.name.toLowerCase(), project]));
  const selected = [];
  const missing = [];
  const seen = new Set();
  for (const name of requested) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const project = byName.get(key);
    if (project) selected.push(project);
    else missing.push(name);
  }
  if (missing.length) throw new Error(`Requested ADO project(s) are unavailable: ${missing.join(', ')}.`);
  return selected;
}

export class AdoClient {
  #orgUrl;
  #pat;
  #fetch;
  #sleep;
  #timeoutMs;
  #maxRetries;
  #maxPages;
  #lfsConcurrency;
  #maxLfsTreeItems;
  #maxLfsAttributeFiles;
  #maxLfsDirectories;

  constructor(orgUrl, pat, {
    fetchImpl,
    sleep = pause,
    timeoutMs = 30_000,
    maxRetries = 3,
    maxPages = 10_000,
    lfsConcurrency = 4,
    maxLfsTreeItems = 100_000,
    maxLfsAttributeFiles = 100,
    maxLfsDirectories = 2_000
  } = {}) {
    if (!orgUrl || !pat) throw new Error('ADO_ORG_URL and ADO_PAT are required');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || !Number.isInteger(maxPages) || maxPages < 1) {
      throw new Error('Invalid Azure DevOps retry or pagination limits.');
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(lfsConcurrency) || lfsConcurrency < 1) {
      throw new Error('Invalid Azure DevOps timeout or LFS concurrency limit.');
    }
    if (!Number.isInteger(maxLfsTreeItems) || maxLfsTreeItems < 1 || !Number.isInteger(maxLfsAttributeFiles) || maxLfsAttributeFiles < 1 || !Number.isInteger(maxLfsDirectories) || maxLfsDirectories < 1) {
      throw new Error('Invalid Azure DevOps LFS resource limit.');
    }
    this.#orgUrl = parseAdoUrl(orgUrl).toString().replace(/\/$/, '');
    this.#pat = pat;
    this.#fetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.#sleep = sleep;
    this.#timeoutMs = timeoutMs;
    this.#maxRetries = maxRetries;
    this.#maxPages = maxPages;
    this.#lfsConcurrency = lfsConcurrency;
    this.#maxLfsTreeItems = maxLfsTreeItems;
    this.#maxLfsAttributeFiles = maxLfsAttributeFiles;
    this.#maxLfsDirectories = maxLfsDirectories;
  }
  validateRepositoryUrl(repositoryUrl) {
    return validateAdoRepositoryUrl(this.#orgUrl, repositoryUrl);
  }
  #serviceBase(service) {
    const url = new URL(this.#orgUrl);
    if (service === 'release') {
      if (url.hostname === 'dev.azure.com') url.hostname = 'vsrm.dev.azure.com';
      else if (visualStudioHostPattern.test(url.hostname)) url.hostname = url.hostname.replace('.visualstudio.com', '.vsrm.visualstudio.com');
    }
    return url.toString().replace(/\/$/, '');
  }
  async #request(path, { service = 'core', allowNotFound = false } = {}) {
    const base = new URL(this.#serviceBase(service));
    const url = new URL(`${base.pathname.replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`, base.origin).toString();

    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      let response;
      try {
        response = await this.#fetch(url, {
          headers: {
            Authorization: `Basic ${Buffer.from(`:${this.#pat}`).toString('base64')}`,
            Accept: 'application/json'
          },
          redirect: 'error',
          signal: AbortSignal.timeout(this.#timeoutMs)
        });
      } catch {
        if (attempt === this.#maxRetries) throw new Error('Azure DevOps API request failed or timed out.');
        await this.#sleep(Math.min(8_000, 250 * (2 ** attempt)));
        continue;
      }

      if (allowNotFound && response.status === 404) return { data: null, continuationToken: null };
      if (!response.ok) {
        if (retryableStatuses.has(response.status) && attempt < this.#maxRetries) {
          await this.#sleep(retryDelay(response, attempt));
          continue;
        }
        const error = new Error(`Azure DevOps API request failed with status ${response.status}.`);
        error.status = response.status;
        throw error;
      }

      try {
        const data = await response.json();
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('Invalid response shape.');
        }
        return {
          data,
          continuationToken: response.headers?.get?.('x-ms-continuationtoken') ?? null
        };
      } catch {
        throw new Error('Azure DevOps API returned an invalid response.');
      }
    }
    throw new Error('Azure DevOps API request failed.');
  }
  async get(path) {
    return (await this.#request(path)).data;
  }
  async #listContinuation(path, { service = 'core', pageSize = 1000 } = {}) {
    const items = [];
    const seenTokens = new Set();
    const seenRecords = new Set();
    let token;
    let pageCount = 0;
    do {
      pageCount += 1;
      if (pageCount > this.#maxPages) throw new Error('Azure DevOps pagination exceeded the configured page limit.');
      const pagePath = appendQuery(path, { '$top': pageSize, continuationToken: token });
      const result = await this.#request(pagePath, { service });
      for (const value of collectionValues(result.data)) {
        const key = recordKey(value);
        if (key && seenRecords.has(key)) continue;
        if (key) seenRecords.add(key);
        items.push(value);
      }
      token = result.continuationToken || result.data?.continuationToken || null;
      if (token && seenTokens.has(token)) throw new Error('Azure DevOps pagination returned a repeated continuation token.');
      if (token) seenTokens.add(token);
    } while (token);
    return items;
  }
  async listProjects() {
    return this.#listContinuation('_apis/projects?stateFilter=all&api-version=7.1');
  }
  async listRepositories(project) {
    const data = await this.get(`${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.1`);
    return collectionValues(data);
  }
  async listRefs(project, repoId) {
    return this.#listContinuation(`${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/refs?filter=refs/heads/&api-version=7.1`);
  }
  async listTags(project, repoId) {
    return this.#listContinuation(`${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/refs?filter=refs/tags/&api-version=7.1`);
  }
  async listCommits(project, repoId, pageSize = 1000) {
    const commits = [];
    const seenCommitIds = new Set();
    let skip = 0;
    let pageCount = 0;
    while (true) {
      pageCount += 1;
      if (pageCount > this.#maxPages) throw new Error('Azure DevOps commit pagination exceeded the configured page limit.');
      const query = new URLSearchParams({
        'searchCriteria.$skip': String(skip),
        'searchCriteria.$top': String(pageSize),
        'api-version': '7.1'
      });
      const data = await this.get(`${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/commits?${query}`);
      const page = collectionValues(data);
      let added = 0;
      for (const commit of page) {
        if (!commit?.commitId) throw new Error('Azure DevOps API returned a malformed commit record.');
        if (seenCommitIds.has(commit.commitId)) continue;
        seenCommitIds.add(commit.commitId);
        commits.push({
          commitId: commit.commitId,
          parents: Array.isArray(commit.parents) ? commit.parents : [],
          author: commit.author ? { name: commit.author.name, date: commit.author.date } : undefined,
          committer: commit.committer ? { name: commit.committer.name, date: commit.committer.date } : undefined
        });
        added += 1;
      }
      if (page.length > 0 && added === 0) throw new Error('Azure DevOps commit pagination did not advance.');
      if (page.length < pageSize) return commits;
      skip += page.length;
    }
  }
  async getProject(project) {
    return this.get(`_apis/projects/${encodeURIComponent(project)}?includeCapabilities=true&api-version=7.1`);
  }
  async listBuildDefinitions(project) {
    const definitions = await this.#listContinuation(`${encodeURIComponent(project)}/_apis/build/definitions?api-version=7.1`);
    return definitions.map(definition => ({
      id: definition.id,
      name: definition.name,
      path: definition.path,
      revision: definition.revision,
      queueStatus: definition.queueStatus,
      type: definition.type,
      createdDate: definition.createdDate,
      project: definition.project?.name
    }));
  }
  async listReleaseDefinitions(project) {
    const definitions = await this.#listContinuation(`${encodeURIComponent(project)}/_apis/release/definitions?api-version=7.1`, { service: 'release' });
    return definitions.map(definition => ({
      id: definition.id,
      name: definition.name,
      path: definition.path,
      revision: definition.revision,
      createdOn: definition.createdOn,
      modifiedOn: definition.modifiedOn,
      environments: (definition.environments ?? []).map(environment => ({
        id: environment.id,
        name: environment.name,
        rank: environment.rank
      }))
    }));
  }
  async listServiceEndpoints(project) {
    const data = await this.get(`${encodeURIComponent(project)}/_apis/serviceendpoint/endpoints?api-version=7.1`);
    return collectionValues(data).map(endpoint => ({
      id: endpoint.id,
      name: endpoint.name,
      type: endpoint.type,
      url: safeServiceUrl(endpoint.url),
      isReady: endpoint.isReady,
      isShared: endpoint.isShared,
      owner: endpoint.owner,
      projectReferences: (endpoint.serviceEndpointProjectReferences ?? []).map(reference => ({
        projectId: reference.projectReference?.id,
        projectName: reference.projectReference?.name,
        name: reference.name
      }))
    }));
  }
  async listBranchPolicies(project) {
    const policies = await this.#listContinuation(`${encodeURIComponent(project)}/_apis/policy/configurations?api-version=7.1`);
    return policies.map(policy => ({
      id: policy.id,
      revision: policy.revision,
      enabled: policy.isEnabled,
      blocking: policy.isBlocking,
      createdDate: policy.createdDate,
      type: { id: policy.type?.id, name: policy.type?.displayName },
      settings: safePolicySettings(policy.settings)
    }));
  }
  async listRepositoryPermissions(projectId, repositoryId) {
    const token = `repoV2/${projectId}/${repositoryId}`;
    const query = new URLSearchParams({ token, includeExtendedInfo: 'true', 'api-version': '7.1' });
    const data = await this.get(`_apis/accesscontrollists/${gitRepositoryNamespaceId}?${query}`);
    return collectionValues(data).flatMap(acl => Object.values(acl.acesDictionary ?? {}).map(entry => ({
      descriptor: entry.descriptor,
      allow: entry.allow,
      deny: entry.deny,
      effectiveAllow: entry.extendedInfo?.effectiveAllow,
      effectiveDeny: entry.extendedInfo?.effectiveDeny,
      inheritPermissions: acl.inheritPermissions
    })));
  }
  async listItems(project, repositoryId, branch, scopePath = '/', recursionLevel = 'OneLevel') {
    const query = new URLSearchParams({
      scopePath,
      recursionLevel,
      includeContentMetadata: 'true',
      'api-version': '7.1'
    });
    if (branch) {
      query.set('versionDescriptor.version', branch.replace(/^refs\/heads\//, ''));
      query.set('versionDescriptor.versionType', 'branch');
    }
    const data = await this.get(`${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items?${query}`);
    return collectionValues(data);
  }
  async getItem(project, repositoryId, path, branch) {
    const query = new URLSearchParams({
      path,
      includeContent: 'true',
      'api-version': '7.1'
    });
    if (branch) {
      query.set('versionDescriptor.version', branch.replace(/^refs\/heads\//, ''));
      query.set('versionDescriptor.versionType', 'branch');
    }
    const result = await this.#request(`${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/items?${query}`, { allowNotFound: true });
    return result.data;
  }
  async detectLfsUsage(project, repositoryId, defaultBranch) {
    if (!defaultBranch) {
      return { lfsConfigured: null, detection: 'default-branch-unavailable', attributeFileCount: 0, status: 'NOT_VERIFIED', objectAvailabilityStatus: 'NOT_VERIFIED' };
    }
    const pendingScopes = ['/'];
    const seenScopes = new Set(pendingScopes);
    const seenPaths = new Set();
    const attributePaths = [];
    let visitedItems = 0;
    let visitedDirectories = 0;
    let treeComplete = true;

    while (pendingScopes.length > 0) {
      const scopes = pendingScopes.splice(0, this.#lfsConcurrency);
      if (visitedDirectories + scopes.length > this.#maxLfsDirectories) {
        treeComplete = false;
        break;
      }
      visitedDirectories += scopes.length;
      const itemPages = await mapWithConcurrency(scopes, this.#lfsConcurrency, scope => this.listItems(project, repositoryId, defaultBranch, scope));
      for (let index = 0; index < itemPages.length && treeComplete; index += 1) {
        const scope = scopes[index];
        for (const item of itemPages[index]) {
          if (!item || typeof item.path !== 'string') throw new Error('Azure DevOps API returned a malformed repository item.');
          if (item.path === scope || seenPaths.has(item.path)) continue;
          seenPaths.add(item.path);
          visitedItems += 1;
          if (visitedItems > this.#maxLfsTreeItems) {
            treeComplete = false;
            break;
          }
          if (item.isFolder) {
            if (!seenScopes.has(item.path)) {
              seenScopes.add(item.path);
              pendingScopes.push(item.path);
            }
          } else if (item.path.split('/').at(-1).toLowerCase() === '.gitattributes') {
            attributePaths.push(item.path);
          }
        }
      }
    }

    if (!treeComplete) {
      return {
        lfsConfigured: null,
        detection: 'repository-tree-traversal-limit-reached',
        attributeFileCount: attributePaths.length,
        scannedAttributeFileCount: 0,
        repositoryTreeItemCount: visitedItems,
        repositoryDirectoryCount: visitedDirectories,
        status: 'NOT_VERIFIED',
        objectAvailabilityStatus: 'NOT_VERIFIED'
      };
    }

    const pathsToScan = attributePaths.slice(0, this.#maxLfsAttributeFiles);
    const contents = await mapWithConcurrency(pathsToScan, this.#lfsConcurrency, path => this.getItem(project, repositoryId, path, defaultBranch));
    const lfsConfigured = contents.some(item => /(?:^|\s)filter\s*=\s*lfs(?:\s|$)/im.test(item?.content ?? ''));
    const completeScan = treeComplete && pendingScopes.length === 0 && pathsToScan.length === attributePaths.length && contents.every(item => typeof item?.content === 'string');
    return {
      lfsConfigured: lfsConfigured ? true : completeScan ? false : null,
      detection: !treeComplete ? 'repository-tree-limit-reached' : completeScan ? 'tracked-gitattributes' : 'tracked-gitattributes-partial',
      attributeFileCount: attributePaths.length,
      scannedAttributeFileCount: pathsToScan.length,
      repositoryTreeItemCount: visitedItems,
      repositoryDirectoryCount: visitedDirectories,
      status: completeScan ? 'SUCCESS' : lfsConfigured ? 'PARTIAL' : 'NOT_VERIFIED',
      objectAvailabilityStatus: 'NOT_VERIFIED'
    };
  }
}
