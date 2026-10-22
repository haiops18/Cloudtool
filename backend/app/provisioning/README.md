# Backend provisioning

This package replaces the Terraform runtime for server creation. It resolves or
creates network/security resources, creates servers, renders the existing
cloud-init/Teleport/netplan scripts, shares the configured monitor VPC and
attaches monitor private IPs through the existing audited Cloud API gateway.

Production secrets remain backend-only. Configure Teleport with JSON environment
values, for example:

```env
PROVISIONING_TELEPORT_VERSIONS={"central":"13.4.14","north":"16.4.11"}
PROVISIONING_TELEPORT_TOKENS={"central":"replace-me","north":"replace-me"}
PROVISIONING_MONITOR_NIC_PREFIX=24
```

No Cloud token, Teleport token, or rendered `user_data` is stored in the
deployment history tables. Start the composed backend with
`uvicorn app.terraform_app:app --reload`; database tables are created by the
normal startup lifecycle, while migration `0004_provisioning_logs` supports
managed deployments.
