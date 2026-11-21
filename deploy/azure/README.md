# Azure (AKS) overlay

Overlay for AKS with the application routing add-on, in-cluster Strimzi Kafka,
Azure Container Registry, Azure Database for PostgreSQL Flexible Server, and
cert-manager with Let's Encrypt. The full walkthrough is in
[`docs/deploy-to-azure.md`](../../docs/deploy-to-azure.md).

To create and delete the whole environment with scripts, see "Scripted showcase" in
the walkthrough. `scripts/azure-up.sh` substitutes the placeholders below from
`scripts/azure.env` when it renders the manifests, so you can leave them as they
are when you deploy with it. The GitHub deploy workflow (`deploy.yml`) does the same
from the `production` environment variables `PG_SERVER`, `HOST`, `API_HOST`,
`ADMIN_EMAILS` and optionally `GOOGLE_CLIENT_ID` (see `docs/ci-cd.md`).

Replace these placeholders, then run `kubectl apply -f deploy/azure/cluster-issuer.yaml` (cluster-scoped, deliberately not part of the kustomization) and `kubectl apply -k deploy/azure`:

| File | Placeholder | Replace with |
| --- | --- | --- |
| `kustomization.yaml` | `<your-acr>` (4 images) and `newTag` | your ACR name and image tag |
| `kustomization.yaml` | `namespace: message-poc` | your namespace, if different |
| `kustomization.yaml` | `<pg-server>` in `JDBC_URL` | your PostgreSQL server name (keep port 5432) |
| `kustomization.yaml` | `GOOGLE_CLIENT_ID`, `ADMIN_EMAILS` | your OAuth client ID and admin emails |
| `kustomization.yaml` | `messages.example.com`, `api.messages.example.com` (4 places) | your hosts |
| `kustomization.yaml` | `LOKI_URL` | keep if you deploy Loki in the namespace (guide step 11) |
| `cluster-issuer.yaml` | `you@example.com` | the ACME contact email |

The Strimzi operator and cert-manager must be installed first, and the Secret
`message-poc-secrets` (`DB_PASSWORD`, `TYPESAFE_API_KEY`) must exist in the namespace.

[`loki/`](loki) holds the optional Loki manifest (`loki.yaml`) and the Alloy
configuration (`kubernetes.alloy`) for the audit panel. They are not part of the
kustomization; guide step 11 and `scripts/azure-up.sh --with-loki` apply them.
