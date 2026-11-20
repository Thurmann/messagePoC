# CI, releases and deployment

Three GitHub Actions workflows live in `.github/workflows`:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | Pull requests, pushes to `main`, manual | `./gradlew build` (unit and Testcontainers integration tests), a Docker build of each of the four service images (not pushed), and a `kubectl kustomize` render of `deploy/kubernetes`, `deploy/kubernetes/kafka` and `deploy/azure` |
| `release.yml` | Tags `v*.*.*` | Builds and tests, pushes the images to GHCR, creates the GitHub release, and deploys stable releases to AKS when deployment is enabled |
| `deploy.yml` | Called by `release.yml`, or run manually with a version | Imports a released version's images into ACR and applies `deploy/azure` from that release tag to AKS |

## Cut a release

Releases are made from a tag on `main`. Use a semantic version with a `v` prefix:

```bash
git switch main
git pull
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

The release workflow then:

1. Builds and tests with `-PreleaseVersion=0.2.0`, so the service jars are named
   `<service>-0.2.0.jar` (without the property, the version stays `0.1.0-SNAPSHOT`).
2. Builds the four images for `linux/amd64` and pushes them to
   `ghcr.io/<owner>/message-poc/<service>` with the tags `0.2.0`, `0.2` and `latest`.
3. Creates the GitHub release `v0.2.0` with generated notes, the image list and the
   four service jars attached.
4. Deploys `0.2.0` to AKS, if `DEPLOY_TO_AKS` is `true` (see below).

A tag with a suffix, such as `v0.2.0-rc.1`, becomes a prerelease. Its images are
tagged only `0.2.0-rc.1` (no `latest`, no `0.2`), and it is not deployed
automatically. To deploy one anyway, run the Deploy workflow manually.

If a release run fails before the GitHub release is created, fix the problem on
`main`, then tag a new version. Do not move an existing tag.

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
stops the deployment, so commit the real values in `deploy/azure/kustomization.yaml`
before you tag the release.

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
   required reviewers there if each deployment should wait for approval. Add
   these environment variables:

   | Variable | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | Client ID of the identity |
   | `AZURE_TENANT_ID` | Tenant ID |
   | `AZURE_SUBSCRIPTION_ID` | Subscription ID |
   | `AZURE_RESOURCE_GROUP` | Resource group of the AKS cluster |
   | `AKS_NAME` | AKS cluster name |
   | `ACR_NAME` | Registry name, without `.azurecr.io` |

4. Add the repository variable `DEPLOY_TO_AKS` with the value `true`
   (Settings → Secrets and variables → Actions → Variables). Without it, releases
   are published but not deployed.

To deploy, or roll back to, an existing release, run **Deploy** from the Actions
tab and enter its version without the `v` (for example `0.1.0`).

## Dependency updates

Dependabot (`.github/dependabot.yml`) also updates the actions used by these
workflows. CI runs on its pull requests like on any other.
