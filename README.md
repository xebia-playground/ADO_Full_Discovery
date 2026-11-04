# GitBridge Full Discovery

GitBridge Full Discovery is a GitHub Actions tool that inventories Azure DevOps organizations, projects, and repositories. It writes JSON and CSV reports and uploads them as a workflow artifact. It can run from this repository or be called as a reusable workflow by another repository.

## What Full Discovery collects

- Organization and project inventory.
- Repository metadata, branches, tags, and commits.
- Branch policies and repository permissions.
- Build and release pipeline definitions.
- Service connection metadata.
- A bounded scan of default-branch `.gitattributes` for Git LFS configuration.

Discovery only includes resources visible to the Azure DevOps identity represented by the supplied PAT. Some report areas need additional PAT scopes; see [ADO PAT permissions](#ado-pat-permissions).

## Prerequisites

- A GitHub repository where Actions are enabled.
- An Azure DevOps organization URL, such as `https://dev.azure.com/contoso`.
- An Azure DevOps PAT stored as a GitHub Actions secret named `ADO_PAT`.
- The PAT owner must have access to the projects and repositories to be inventoried.
- For reusable-workflow callers, the toolkit repository must be accessible to GitHub Actions. If it is private, configure the optional `TOOLKIT_READ_TOKEN` described below.
- For a private toolkit repository, allow the client repository to use its reusable workflows under **Settings > Actions > General > Access**.

The workflow uses a GitHub-hosted Ubuntu runner. No application installation, npm dependency installation, or local configuration file is required.

## ADO PAT permissions

Grant the narrowest read scopes needed for the report areas you want:

| API area | Microsoft scope | Requirement |
|---|---|---|
| Projects | Project and team (read), `vso.project` | Needed to list accessible projects |
| Repositories, branches, tags, commits, Git items, policies | Code (read), `vso.code` | Needed for repository and Git data |
| Build definitions | Build (read), `vso.build` | Needed for build pipeline metadata |
| Release definitions | Release (read), `vso.release` | Needed for release pipeline metadata |
| Service connections | Service endpoints (read), `vso.serviceendpoint` | Needed for service connection metadata |
| Repository ACLs | Not conclusively specified by the ACL API | Ask your ADO administrator; do not assume Security (manage) is least privilege |

The workflow attempts the available discovery adapters. Missing optional permissions may result in `NOT_VERIFIED` or `PARTIAL` statuses. See Microsoft's [PAT guidance](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops), [OAuth scope catalog](https://learn.microsoft.com/en-us/azure/devops/integrate/get-started/authentication/oauth?view=azure-devops), and [ACL query API](https://learn.microsoft.com/en-us/rest/api/azure/devops/security/access-control-lists/query?view=azure-devops-rest-7.1).

## Configure and run from this repository

1. Add a repository secret named `ADO_PAT` under **Settings > Secrets and variables > Actions**.
2. Open **Actions** and select **01 - ADO Full Discovery (Organization + Selected Projects)**.
3. Select **Run workflow** and enter:
   - `ado_org_url` (required): the complete HTTPS organization URL.
   - `ado_project` (optional): one exact project name.
   - `ado_projects` (optional): comma-separated project names.
4. Leave both project selectors blank to discover all accessible projects. Set only one selector when choosing projects.
5. Start the run. Download the `ado-discovery-<RUN_NUMBER>` artifact from the completed workflow.

Project selection is case-insensitive. Requested names must match projects accessible to the PAT owner.

## Call Full Discovery from another repository

The reusable workflow is at `.github/workflows/ado-discovery.yml`. Add a caller workflow to the client repository at `.github/workflows/full-discovery.yml`. This example creates a manual run form and passes its values into GitBridge:

```yaml
name: Full Discovery

on:
  workflow_dispatch:
    inputs:
      ado_org_url:
        description: Azure DevOps organization URL
        required: true
        type: string
      ado_project:
        description: One project name; leave blank to discover all
        required: false
        type: string
      ado_projects:
        description: Comma-separated project names
        required: false
        type: string

jobs:
  full-discovery:
    permissions:
      contents: read
    uses: xebia-playground/ADO_Full_Discovery/.github/workflows/ado-discovery.yml@main
    with:
      ado_org_url: ${{ inputs.ado_org_url }}
      ado_project: ${{ inputs.ado_project }}
      ado_projects: ${{ inputs.ado_projects }}
      toolkit_ref: main
    secrets:
      ADO_PAT: ${{ secrets.ADO_PAT }}
      # Required only when the toolkit repository is private:
      # TOOLKIT_READ_TOKEN: ${{ secrets.TOOLKIT_READ_TOKEN }}
```

Set `ADO_PAT` as a secret in the client repository. If the toolkit repository is private, allow the client repository under the toolkit repository's **Settings > Actions > General > Access** and add `TOOLKIT_READ_TOKEN` to the client repository; it needs read access to the toolkit repository's contents. The called workflow uses the caller's `GITHUB_TOKEN` by default when checking out a public toolkit repository.

The `@main` reference selects the reusable workflow definition. Set `toolkit_ref` to the same tag, branch, or commit so the workflow checks out matching toolkit source. For example, if the `uses` reference is changed to `@<commit-sha>`, set `toolkit_ref` to that same commit SHA. Pinning both to a reviewed commit is recommended.

The reusable workflow accepts:

| Input | Type | Required | Description |
|---|---|---:|---|
| `ado_org_url` | string | Yes | Full HTTPS Azure DevOps organization URL |
| `ado_project` | string | No | One exact project name; leave blank to discover all |
| `ado_projects` | string | No | Comma-separated project names; leave blank to discover all |
| `toolkit_ref` | string | No | Toolkit source branch, tag, or commit; defaults to `main` |

It accepts these secrets:

| Secret | Required | Description |
|---|---:|---|
| `ADO_PAT` | Yes | Azure DevOps PAT with the read permissions required for the selected discovery areas |
| `TOOLKIT_READ_TOKEN` | No | GitHub token with contents read access, needed only if the toolkit repository is private |

The artifact is attached to the caller's workflow run. Reports retain the same names and JSON/CSV formats as a run from this repository.

## Reports

The workflow uploads the flat `reports/` directory as an Actions artifact named `ado-discovery-<RUN_NUMBER>`, retained for 30 days. It can contain organization, project, and repository JSON/CSV inventories, `ado-full-inventory.json`, and detail CSVs for projects, repositories, branches, tags, commits, branch policies, build pipelines, release pipelines, service connections, and repository permissions. Reports reflect the data the PAT can access; statuses indicate areas that could not be verified.

## Troubleshooting

| Result | Check |
|---|---|
| 401 or `NOT_VERIFIED` | Confirm `ADO_PAT` is present, active, organization-scoped, and has the needed read scopes. |
| 403 or `NOT_VERIFIED` | Check the PAT owner's ADO permissions and the scope for the affected API area. |
| Empty project or repository list | The API returns resources visible to the PAT owner; compare with an authorized ADO UI view. |
| Requested project unavailable | Check the exact spelling and access. Use only one of `ado_project` or `ado_projects`. |
| Missing or partial detail reports | Review the required scopes for the corresponding API area above. |
| Toolkit checkout fails | Confirm the `toolkit_ref` matches the reusable workflow's `uses` ref. For a private toolkit, verify `TOOLKIT_READ_TOKEN` has contents read access. |

## Local checks

From the project directory, run:

```sh
npm test
npm run check
```
