# ADO Full Discovery

This tool runs in GitHub Actions and creates JSON and CSV reports about Azure DevOps projects and repositories. It can discover all projects your account can access, or only the projects you select.

## What you need

- An Azure DevOps organization URL, for example `https://dev.azure.com/contoso`.
- An Azure DevOps personal access token (PAT). The PAT owner must have access to the projects and repositories you want to discover.
- A GitHub repository with Actions enabled.

Give the PAT read access to projects and code. To include build pipelines, release pipelines, and service connections, also grant their corresponding read scopes (`vso.build`, `vso.release`, and `vso.serviceendpoint`). Ask your Azure DevOps administrator about repository permissions; the required PAT scope is unclear. Reports for areas the PAT cannot access may be marked `PARTIAL` or `NOT_VERIFIED`.

## Run from this repository

1. In GitHub, open **Settings > Secrets and variables > Actions** and add a repository secret named `ADO_PAT`.
2. Open **Actions** and select **01 - ADO Full Discovery (Organization + Selected Projects)**.
3. Select **Run workflow** and enter the organization URL.
4. To discover everything you can access, leave both project fields blank. To limit discovery, enter one project name in `ado_project` or comma-separated names in `ado_projects`—not both.
5. Run the workflow. When it finishes, download the `ado-discovery` artifact from the run page. It contains the JSON and CSV reports and is kept for 30 days.

## Use it from another repository

Add a workflow file such as `.github/workflows/full-discovery.yml` to your repository:

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
        description: One project name; leave blank for all projects
        required: false
        type: string
      ado_projects:
        description: Comma-separated project names
        required: false
        type: string

jobs:
  discover:
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
      # Needed only if the Full Discovery repository is private:
      # TOOLKIT_READ_TOKEN: ${{ secrets.TOOLKIT_READ_TOKEN }}
```

Add `ADO_PAT` as a secret in the client repository. If this repository is private, allow the client repository under **Settings > Actions > General > Access** and add `TOOLKIT_READ_TOKEN` to the client repository. That token needs read access to this repository's contents. Keep the `uses` reference and `toolkit_ref` on the same branch, tag, or commit.

Start the caller workflow from its **Actions** tab. The reports appear as an artifact on that run.
