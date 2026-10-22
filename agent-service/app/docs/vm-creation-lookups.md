# VM creation configuration: live read-only APIs

Read this guide before planning VM creation from chat or an uploaded file.
These APIs discover configuration only. They do not create or modify any resource.
The authenticated CloudTool project is fixed by the service; never supply another
project, URL, credentials, HTTP method or arbitrary upstream path.

## Invocation

Use MCP `get_vm_creation_options` with one request object, or
`batch_vm_creation_options` with `{"requests":[request,...]}`.
Both are backed by the same APIs:

- `GET /api/v1/vm-creation/options?resource=zones&page=1&page_size=50`
- `POST /api/v1/vm-creation/options/batch` with the batch JSON body (read-only).

HTTP clients require the existing CloudTool login, project, cloud session and CSRF
headers. The gateway supplies credentials internally for MCP. Codex must use tools,
never curl, shell, direct HTTP or credentials.

## Catalogs and parameters

All requests accept `resource`, `page` (1-1000), `page_size` (1-100, default 50).
`q` searches supported catalogs; it is not supported for subnets/private_ips.
Unknown parameters are rejected. IDs must come from actual results.

| resource | Required filter | Optional filter | Source |
|---|---|---|---|
| regions | none | q | /cloud/server-regions; live region catalog |
| zones | none | q | /cloud/zones |
| images | none | q | /cloud/server-images |
| flavors | zone (ID) | family: basic (default) or gpu, q | /cloud/server-flavors |
| volume_types | zone (ID) | q | /cloud/server-volume-types |
| vpcs | region_id | q | /cloud/server-vpcs |
| subnets | none | pagination | /cloud/subnets |
| security_groups | region_id | q | /cloud/server-security-groups |
| keypairs | none | q | /cloud/server-keypairs |
| elastic_ips | none | q | /cloud/server-elastic-ips; unassigned |
| enis | none | q | /cloud/server-enis; available |
| private_ips | subnet_id | ip_address | /cloud/private-ips; available |
| placement_groups | region_id | q | /cloud/server-placement-groups |
| cloud_init_templates | none | q | /cloud/cloud-init-templates; active shared templates, metadata only |
| cloud_init_template | template_id | none | /cloud/cloud-init-templates/{id}/planning-options; variable names, no script |
| deployment_schema | none | none | /provisioning/deployment-schema; current DeploymentCreate JSON schema |
| deployment_status | deployment_id | none | /provisioning/deployments/{id}; compact status and actual server IDs |

The last three are single-object reads returning `data`, not `items`, and do not
accept search/pagination. Read deployment_schema before assembling a deployment;
follow its required fields, enum values, constraints and nested `$defs`. Region
rows can expose `region`, `region_name` and/or `id`; preserve the actual identifier
and deployment region value rather than inventing one from a display label.
Template details distinguish derived_variables from custom_variables. Derived
network/IP variables still require a valid allocation and custom variables require
user input if absent. Do not ask for credentials in clarification questions.

Preserve returned IDs, names, zone/region and network relationships. Subnets must
be checked against the chosen VPC/zone using returned relationships; an unfiltered
subnet page does not imply every subnet fits. Never treat missing metadata as proof
of compatibility. Keypair results contain selection metadata only, no key material.
Cloud-init template contents are not returned by this discovery API.

## Multiple APIs and multiple rounds in one turn

Do not stop after one tool call or ask the user to authorize each read. Read-only
discovery can continue within the same chat turn and conversation.

1. Extract requirements from the message/file; list unresolved selections.
2. Batch independent catalogs, for example:

```json
{"requests":[{"resource":"zones"},{"resource":"images","q":"Ubuntu"},{"resource":"subnets"},{"resource":"keypairs"}]}
```

3. Inspect actual IDs. Once the zone/region is known, issue another batch:

```json
{"requests":[{"resource":"flavors","zone":"<zone-id>"},{"resource":"volume_types","zone":"<zone-id>"},{"resource":"security_groups","region_id":"<region-id>"},{"resource":"vpcs","region_id":"<region-id>"}]}
```

4. If a fixed IP is needed, call private_ips with the selected subnet_id.
5. Request additional pages or narrowed searches until selections are resolved.
   Ask one consolidated question only for genuine missing requirements or ambiguous
   choices that cannot be resolved from the user's instructions. Use the native
   `request_user_input` tool (or `ask_user_question` compatibility tool). It waits
   for the user's answer in the chat interface, then resumes the same turn. Group
   up to three questions per request. Include real IDs/names and relevant specs in
   labels/descriptions so the chosen value can be mapped unambiguously. Allow
   free text when appropriate. Never preselect on behalf of the user. Do not silently
   choose a zone, image, network or paid configuration without a basis.

For example, after reading zones, ask which zone to use with each actual zone as
an option; then use the selected zone ID to fetch flavors and disk types. Ask for
image/network/SG choices next if still ambiguous. You may ask multiple rounds in
one conversation. A cancelled, expired or unanswered request returns empty answers:
stop that creation path and explain what remains missing, never select defaults.
Answering a question is not approval to create resources. The separate write
approval remains necessary. The question API is scoped to the current project and
authenticated user: GET `/api/v1/conversations/{id}/questions`, POST
`/api/v1/questions/{id}/answer` with `{"answers":{"question-id":["chosen label"]}}`
or `{"cancel":true}`. These endpoints are used by the chat UI, not called by Codex.

Each batch permits 1-16 requests and runs at most four upstream reads concurrently.
Dependent requests belong in the next round; placeholders are never valid IDs.
The batch mechanism works even when the MCP transport processes tool calls serially.

## Results and failures

Single results contain project_id, resource, filters, items, total (possibly null),
page, page_size, has_more and next_page. Never follow an upstream URL; use next_page
with the same filters. A page with zero items is not a global search result for
other filters. For unknown totals, has_more may request one final empty page.
Do not fetch every catalog/page speculatively or put full inventories in the chat.

Batch results contain project_id and ordered results with index, ok and either
result or error. Keep successful results; an error is not an empty catalog.
401/403 requires restoring access, not blind retries. Retry transient failed reads
only when useful, and never retry an entire successful batch unnecessarily.
No cross-request catalog cache is retained by these tools.

This guide authorizes discovery only. VM creation continues through the existing
separate approval action described in vm-deployment-create-action-api.md; discovery
success does not mean a VM was created or its full configuration validated.
