# CloudTool production Kubernetes configuration

This directory contains non-secret workload manifests. Secrets are intentionally
not committed to Git.

## Required secrets

Create both registry pull secrets in `cloudtool-prod`. Workloads may use either
GHCR or Harbor; keeping both secrets on every application pod allows a GitOps
release to switch registries without changing the pod security model.

```bash
kubectl -n cloudtool-prod create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io \
  --docker-username=<github-user> \
  --docker-password='<read-only-ghcr-token>'
```

```bash
kubectl -n cloudtool-prod create secret docker-registry harbor-pull \
  --docker-server=10.60.160.6 \
  --docker-username='<harbor-pull-robot>' \
  --docker-password='<harbor-pull-token>'
```

Create the backend secret. `DATABASE_URL` must point to the PostgreSQL HA VIP:

```text
postgresql+asyncpg://<db-user>:<db-password>@10.60.160.73:5432/cloudtool_prod
```

Example secret creation; do not commit the resulting manifest:

```bash
kubectl -n cloudtool-prod create secret generic cloudtool-backend-env \
  --from-literal=APP_ENV=production \
  --from-literal=DATABASE_URL='postgresql+asyncpg://<db-user>:<db-password>@10.60.160.73:5432/cloudtool_prod'
```

The backend and agent-service deployments also require their respective
`cloudtool-backend-env` and `cloudtool-agent-env` secrets. Add all required
application settings to those secrets according to the production environment;
never place passwords, API tokens or private keys in this directory.

## Required pre-deploy checks

```bash
kubectl get namespace cloudtool-prod
kubectl -n cloudtool-prod get secret ghcr-pull harbor-pull cloudtool-backend-env cloudtool-agent-env
kubectl -n cloudtool-prod get secret cloudtool-backend-env \
  -o jsonpath='{.data.DATABASE_URL}' | base64 -d | \
  sed -E 's#://[^@]+@#://REDACTED@#'
```

The last command should show host `10.60.160.73`, port `5432` and database
`cloudtool_prod`; do not print the unredacted secret into logs or tickets.

## Deployment policy

Argo CD application `cloudtool-prod` is intentionally configured without
`automated` sync. The release flow is:

```text
GitHub main
  -> Jenkins CI: test/build/push immutable SHA tag
  -> Jenkins production-release: explicit approval + GitOps PR
  -> merge approved PR into gitops-prod
  -> Argo CD manual Sync
  -> rollout and smoke checks
```

Rollback is a GitOps commit/PR that changes the selected component's
`newTag` back to a known-good 12-character commit tag.
