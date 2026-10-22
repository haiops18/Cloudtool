# Approved project writes: private IP, Elastic IP, VM and IP attachment

Use only the native tools below for writes, through the exact same pending action
gateway and conversation permission policy as security-group rules. In Ask first
mode the user reviews each action; Full access lets the browser approve it under
that conversation's existing policy. The service key, Cloud session and CSRF stay
inside CloudTool. Never use MCP, shell, direct HTTP or arbitrary REST paths for writes.
Read vm-creation-lookups.md, inspect uploaded requirements and resolve ambiguous
choices with request_user_input/ask_user_question before requesting a write.

| Native tool | Input | Result |
|---|---|---|
| create_private_ip | subnet_id; optional ip_address (exact IPv4) | result.ip_id, result.ip_address |
| create_elastic_ip | zone_id | result.ip_id, result.ip_address |
| create_vm_deployment | deployment object matching deployment_schema | queued result.id, poll_url |
| attach_private_ip | server_id, ip_id | completed or accepted attachment |
| attach_elastic_ip | server_id, ip_id | completed or accepted attachment |

Each IP tool requests one action/resource. You may call multiple tools sequentially
in one chat turn, including the same tool with different inputs. Wait for the actual
result before making dependent calls. Do not issue concurrent writes. Cancelled,
rejected, expired or failed actions are not success and do not authorize another action.

## Planning and execution

1. Read live catalogs and the deployment_schema. Confirm the project, zone, image,
   flavor/custom CPU/RAM, root disk type/size, subnet, SGs and optional keypair,
   cloud-init and public networking from explicit requirements/user answers.
2. If new IP resources are required, use create_private_ip/create_elastic_ip.
   Private IP without ip_address allocates a new unused IPv4 in the exact subnet;
   an explicit address must belong to that subnet and must not be reserved.
   Elastic IP region is derived from the selected zone, never guessed.
   Public/Elastic IPs are allocated from a region pool, not from a private subnet.
   Private results include subnet_id; Elastic results include zone_id so each
   returned ID/address can be associated with the correct VM draft.
3. Use real IP IDs from successful results. For initial VM creation, set the
   selected private IP as eni_id with private_ip_mode=existing and subnet_id,
   eni_address, and set an existing EIP using elastic_ip_mode=existing,
   elastic_ip_id and elastic_ip_address. Do not allocate a second automatic EIP.
   Alternatively create the VM without the extra IP, then attach it after a real
   server_id exists. Do not attach the same resource twice.
   Before a VM exists, assigning an IP means selecting it in the deployment
   payload, not calling attach_private_ip/attach_elastic_ip. Never invent a draft
   server_id for attachment. The same IP cannot be shared by two VM rows.
4. create_vm_deployment validates input before requesting approval and uses the
   existing provisioning queue. Each VM must select a zone, image, subnet and
   flavor/custom specs; Basic needs disk_type or explicit volumes. Validation
   checks schema/completeness, not a guarantee of capacity or upstream compatibility.
   Preallocated IPs are also checked for current project, availability,
   subnet/CIDR, zone/region, exact address and mode consistency. These checks run
   again after approval before queue acceptance to catch changed allocations.
   Do not set eni_id with automatic private mode, or elastic_ip_id with auto/none
   mode; those combinations are rejected instead of allocating a second IP.
5. queued means accepted, not ready. Read get_vm_creation_options with
   resource=deployment_status and deployment_id=result.id for actual server IDs
   and progress. Avoid rapid polling. If still creating, report the deployment ID
   and current status; do not repeatedly create deployments or invent server IDs.
6. attach_private_ip/attach_elastic_ip applies only to available IPs and an existing
   VM in this project and matching region. An accepted attachment is asynchronous;
   use get_server_details to verify before saying the address is active.

No delete, detach, rename, resize, power change, general-purpose PUT/PATCH or writes
to other resource types are enabled. IP attachment is the only enabled update.

## Failure and duplicate protection

Every action has a unique pending ID; only one decision may execute it, and expired
actions cannot run. IP/VM errors are returned to Codex and recorded in approval
history. Prefer upstream_detail if provided. A timeout can have an unknown outcome:
inspect deployment status/inventory and ask if necessary before a new write. Never
blindly retry a POST. History Re-run creates another action and can create another
resource; use it only when the user explicitly intends another execution.
Private allocation consumes only the selected subnet's paginated IP records and
keeps integer occupied addresses during the request. Same-request replays in the
worker reuse a bounded result cache, including exact addresses and uncertain
failures. This cache is not a durable reservation across worker restarts; inspect
live inventory whenever a mutation outcome is unknown.

Backend service-only API mappings (credentials supplied by the Agent Service):

- POST /cloud/ip-allocations/internal/agent/private-ip/create
- POST /cloud/ip-allocations/internal/agent/elastic-ip/create
- POST /cloud/ip-allocations/internal/agent/private-ip/attach
- POST /cloud/ip-allocations/internal/agent/elastic-ip/attach
- POST /provisioning/internal/agent/deployments/validate (validation only)
- POST /provisioning/internal/agent/deployments (queue)

The browser approves/rejects using POST /api/v1/pending-actions/{id}/decision.
Never call these backend paths directly from Codex. New native tool registrations
are attached when a Codex thread is created; use a new chat after installing these
tools if an older thread does not expose them. Do not discard an old thread's history.
