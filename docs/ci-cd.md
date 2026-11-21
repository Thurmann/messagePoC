# CI, releases and deployment

Three GitHub Actions workflows live in `.github/workflows`:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Pull requests, pushes to `main`, manual | `./gradlew build` (unit and Testcontainers integration tests), a Docker build of each of the four service images (not pushed), and a `kubectl kustomize` render of `deploy/kubernetes`, `deploy/kubernetes/kafka` and `deploy/azure`, and the `Azure scripts` job (ShellCheck and the stub-based tests of the Azure up/down scripts, no Azure access). On `main`, it then tags the next version and calls `release.yml` |
| `release.yml` | Called by `ci.yml`, or tags `v*.*.*` pushed by hand | Builds and tests, pushes the images to GHCR, creates the GitHub release, and deploys stable releases to AKS when deployment is enabled |
| `deploy.yml` | Called by `release.yml`, or run manually with a version | Imports a released version's images into ACR and applies `deploy/azure` from that release tag to AKS |

## Cut a release

Every push to `main` that passes CI is released. The `Tag release` job in `ci.yml`
bumps the patch version of the latest stable tag (`v0.1.0` → `v0.1.1`), pushes the
tag, and calls the release workflow. For a minor or major release, run **CI** from
the Actions tab on `main` and choose `minor` or `major`.

The tag is pushed with `GITHUB_TOKEN`, so no personal access token is needed.
Tags pushed with that token do not start other workflows, which is why CI calls
`release.yml` directly instead of relying on its tag trigger. If a tag ruleset
protects `v*` tags, allow GitHub Actions to bypass it.

A tag on `main` pushed by hand is still released, which is how to cut a
prerelease. CI does not tag a commit that already has a release tag:

```bash
git switch main
git pull
git tag -a v0.2.0-rc.1 -m "v0.2.0-rc.1"
git push origin v0.2.0-rc.1
```

For `v0.2.0`, the release workflow then:

1. Builds and tests with `-PreleaseVersion=0.2.0`, so the service jars are named
   `<service>-0.2.0.jar` (without the property, the version stays `0.1.0-SNAPSHOT`).
   The image builds pass the same version through the Dockerfile's
   `RELEASE_VERSION` build argument.
2. Builds the four images for `linux/amd64` and pushes them to
   `ghcr.io/<owner>/message-poc/<service>` with the tags `0.2.0`, `0.2` and `latest`.
3. Creates the GitHub release `v0.2.0` with generated notes, the image list and the
   four service jars attached.
4. Deploys `0.2.0` to AKS, if `DEPLOY_TO_AKS` is `true` (see below).

A tag with a suffix, such as `v0.2.0-rc.1`, becomes a prerelease. Its images are
tagged only `0.2.0-rc.1` (no `latest`, no `0.2`), and it is not deployed
automatically. To deploy one anyway, run the Deploy workflow manually.

The workflow refuses a tag that is not on `main`, or whose version is not higher
than the latest stable release (`v0.1.5` after `v0.3.0`, or `v0.3.0-rc.1` after
`v0.3.0`), so an old version cannot take over `latest` or be deployed over a newer
one. To roll back, run the Deploy workflow manually with the older version.

If a release run fails before the GitHub release is created, re-run the failed jobs
if the failure was transient. Otherwise fix the problem on `main`; the push is
released as the next version. Do not move an existing tag.

The first time an image is published, check its visibility under the
repository's Packages. AKS pulls from ACR, not from GHCR, so the packages can be
private.

## Enable deployment to AKS

The Deploy workflow assumes the first deployment has been done by hand, following
[deploy-to-azure.md](deploy-to-azure.md): the cluster exists with ACR attached,
Strimzi and cert-manager are installed, the namespace `message-poc` and the
`message-poc-secrets` Secret exist, and the ClusterIssuer has been applied. The
workflow does not create these.

It deploys `deploy/azure` as it is at the release tag. The workflow sets the
image names and tags itself, so the `<your-acr>` placeholders and `newTag` values
in the overlay are ignored. Any other `<...>` placeholder (such as `<pg-server>`)
or `example.com` value (the Ingress hosts and `ADMIN_EMAILS`) stops the
deployment. Commit the real values in `deploy/azure/kustomization.yaml` before
you tag the release; otherwise a deployment would reset the live Ingress and
ConfigMap to the committed values.

The workflow signs in to Azure with OpenID Connect, so no Azure secret is stored
in GitHub.

1. Create an app registration (or a user-assigned managed identity) for GitHub
   Actions, and add a federated credential with:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Subject: `repo:<owner>/<repo>:environment:production`
   - Audience: `api://AzureADTokenExchange`
2. Grant the identity:
   - **Contributor** on the container registry (`az acr import` needs the import action, which `AcrPush` does not include)
   - **Azure Kubernetes Service Cluster User Role** on the AKS cluster. If the
     cluster uses Microsoft Entra ID authentication instead of local accounts,
     also grant a Kubernetes role that can apply the overlay in `message-poc`
     (for example **Azure Kubernetes Service RBAC Writer**), and add
     `kubelogin convert-kubeconfig -l azurecli` after `az aks get-credentials` in `deploy.yml`.
3. In GitHub, create the environment `production` (Settings → Environments). Add
   required reviewers there if each deployment should wait for approval.
   Automatic deployments run from `main` (through CI) or from a release tag
   pushed by hand, so leave the deployment branch/tag policy unset, or allow
   `main` and the tag pattern `v*`. Add these environment variables:

   | Variable | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | Client ID of the identity |
   | `AZURE_TENANT_ID` | Tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | Subscription ID |
   | `AZURE_RESOURCE_GROUP` | Resource group of the AKS cluster |
   | `AKS_NAME` | AKS cluster name |
   | `ACR_NAME` | Registry name, without `.azurecr.io` |
   | `PG_SERVER` | PostgreSQL server name (fills `<pg-server>` in the overlay) |
   | `HOST` | Frontend host (fills `messages.example.com`) |
   | `API_HOST` | API host (fills `api.messages.example.com`) |
   | `ADMIN_EMAILS` | Comma-separated admin emails (fills `you@example.com`) |
   | `GOOGLE_CLIENT_ID` | Optional; overrides the overlay's committed client ID |

   The last five fill the overlay's placeholders when the workflow renders it, the
   same way `scripts/azure-up.sh` does, so the hosts and emails do not have to be
   committed. Values committed in the overlay still work; the workflow fails if a
   placeholder is left after the substitution.

4. Add the repository variable `DEPLOY_TO_AKS` with the value `true`
   (Settings → Secrets and variables → Actions → Variables). Without it, releases
   are published but not deployed.

**Showcase environments.** If you create and delete the environment with
[`scripts/azure-up.sh` and `scripts/azure-down.sh`](deploy-to-azure.md), note
the following:

- The role assignments of the GitHub identity are scoped to the registry and the
  cluster, which live in the ephemeral resource group, so they vanish with it.
  `azure-up.sh` grants them again (Contributor on the registry and Cluster User
  Role on the cluster) when `GITHUB_DEPLOY_PRINCIPAL_ID` is set in
  `scripts/azure.env` to the object id of the identity. The federated credential
  and the identity itself are not affected.
- Keep the environment variables `AZURE_RESOURCE_GROUP`, `AKS_NAME` and
  `ACR_NAME` equal to `EPHEMERAL_RG`, `AKS_NAME` and `ACR_NAME` in
  `scripts/azure.env`. The scripts re-create the resources under the same names.
- Set `DEPLOY_TO_AKS` to `false` between showcases. While the cluster does not
  exist, a deployment from `main` or from a tag fails. Set it back to `true`
  after `azure-up.sh` has finished. The scripts only read this variable and
  warn; they never change GitHub settings.
- Both `azure-up.sh` and `deploy.yml` fill in the overlay placeholders (ACR,
  PostgreSQL server, hosts, emails) when they render the manifests, so the
  committed overlay keeps them. Keep the environment variables above equal to
  the values in `scripts/azure.env`.
- If the cluster or registry does not exist, `deploy.yml` stops early with an
  error that points to `azure-up.sh` and `DEPLOY_TO_AKS`.

To deploy, or roll back to, an existing release, run **Deploy** from the Actions
tab and enter its version without the `v` (for example `0.1.0`).

## Dependency updates

Dependabot (`.github/dependabot.yml`) also updates the actions used by these
workflows. CI runs on its pull requests like on any other.
