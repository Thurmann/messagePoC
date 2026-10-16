# Kubernetes deployment

This portable Kubernetes base deploys the four application containers. It
expects a Kafka-compatible broker, PostgreSQL database, and Loki endpoint to be
provided by the target environment. Kafka, PostgreSQL, Loki, and a log shipper
are deliberately not installed by these manifests; use managed services or
the platform's supported operators.

## Build and publish the application images

The repository's root `Dockerfile` builds one service per image. Replace the
registry and version in `kustomization.yaml`, then build and push each image:

```sh
docker build --build-arg SERVICE=message-api -t ghcr.io/your-org/message-api:0.1.0 .
docker build --build-arg SERVICE=validation-service -t ghcr.io/your-org/validation-service:0.1.0 .
docker build --build-arg SERVICE=message-persistence -t ghcr.io/your-org/message-persistence:0.1.0 .
docker build --build-arg SERVICE=message-audit -t ghcr.io/your-org/message-audit:0.1.0 .
docker push ghcr.io/your-org/message-api:0.1.0
docker push ghcr.io/your-org/validation-service:0.1.0
docker push ghcr.io/your-org/message-persistence:0.1.0
docker push ghcr.io/your-org/message-audit:0.1.0
```

For a private registry, create an `imagePullSecret` in the deployment namespace
and attach it to the pod specs.

## Configure and deploy

Edit `configmap.yaml` with the Kafka bootstrap address, JDBC URL, Loki URL, and
deployment environment. The example assumes SASL/SSL with PLAIN; set the Spring
Kafka security properties to match the broker if it uses another supported
mechanism. Supply credentials through the target platform's secret manager as
a Kubernetes Secret named `message-poc-secrets` with these keys:

- `TYPESAFE_API_KEY`
- `DB_PASSWORD`
- `SPRING_KAFKA_PROPERTIES_SASL_JAAS_CONFIG` when required by the broker

Do not commit secret values. Configure the target cluster's logging collector
to ship structured container stdout to the configured Loki endpoint using the
`service` field as a label; the audit panel queries `message-audit` entries
from Loki.

Change both hosts in `ingress.yaml` to your chosen DNS names and arrange a TLS
Secret named `message-poc-tls` through cert-manager or your platform's
certificate integration. The Ingress uses the cluster's default ingress class;
set `spec.ingressClassName` for clusters that require one. On OpenShift, use an
OpenShift Route for each host if the cluster does not provide an Ingress
controller.

Create the platform Secret, then deploy the resources:

```sh
kubectl apply -k deploy/kubernetes
```

The frontend is served by `message-persistence` at the first host. The API is
served at the second host. Set `MESSAGE_API_URL` in `sendmessage.sh`'s caller
environment to `https://api.messages.example.com/api/messages`.

## Vercel-managed DNS

The app remains in the selected cloud/Kubernetes runtime; Vercel can continue
to manage the domain's DNS. Create CNAME records for the chosen subdomains that
point to the DNS target supplied by the cluster ingress/load balancer. For an
ingress that only supplies an IP address, use the DNS record type supported by
that target and Vercel. Use the exact target and certificate instructions from
the cloud/platform ingress service rather than Vercel's own hosting targets.
