# CloudTool AI Agent Service

`agent-service` is CloudTool's isolated, read-only AI layer. It validates the
existing CloudTool session, then gives the local Codex CLI a request-scoped
CloudTool MCP server. Codex retrieves only the smallest project data set it
needs through that server.

It never calls Viettel Cloud directly and never persists cloud tokens, cookies,
passwords, console URLs, cloud-init/user-data, or uploaded attachment bytes.

## Agent context for every new Codex session

[AGENT_CONTEXT.md](AGENT_CONTEXT.md) documents the service policy. Each Codex
prompt receives its concise, runtime-enforced equivalent and a small set of
read-only CloudTool MCP tools. This avoids sending a large evidence document on
every turn while preserving the service's read-only boundary.

## Architecture

```text
Browser /ai-assistant
  -> agent-service :8005
  -> request-scoped MCP calls to allow-listed GET endpoints in CloudTool backend /api/v1
  -> local Codex CLI in a read-only sandbox
```

The MCP gateway provides only servers, matching server details, inventory,
subnets, security groups, audit activity and Cloud API history for the selected
project. Its request credentials are passed only to the short-lived MCP child
process and are never written to history or logs.

## Run

```powershell
cd agent-service
..\backend\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8004 --reload
```

Open `/ai-assistant`, choose a project, and use **Settings**. Only an `admin`
can change the global Codex settings.

## Codex CLI configuration

Install and authenticate Codex on the same machine:

```powershell
codex login
codex --version
```

Settings contain real local-Codex options:

| Field | Meaning |
| --- | --- |
| Codex CLI executable path | `codex`, an absolute `codex.exe`, or `codex.cmd` path. |
| Read-only working directory | Existing directory used as Codex working root. |
| Model override | Exact model slug passed to Codex; empty uses the CLI default. |
| Default reasoning effort | `low`, `medium`, `high`, or `xhigh`. |
| Timeout | Maximum time for one Codex turn. |

**Test connection** runs only `codex --version`. It does not contact cloud APIs
or send project data. Conversation-level model and reasoning controls are sent
to Codex for that specific turn. Model availability depends on the Codex
account/provider on the service host, so the UI uses a precise override input
rather than inventing a fixed list of models.

## Conversation lifecycle

1. The first message creates a CloudTool conversation record and runs
   `codex exec --json`.
2. The returned `thread.started.thread_id` is stored as `codex_session_id`.
3. SQLite stores the conversation title, project ID, user, messages, redacted
   evidence references and Codex session ID in `data/agent-service.db`.
4. Reloading the page calls `GET /api/v1/conversations`, scoped by current
   `project_id` and authenticated user.
5. Continuing a saved chat calls `codex exec resume <codex_session_id>`, so
   Codex resumes the real previous thread instead of receiving a fake replay.

Attachments are request-only. PNG/JPEG/WebP become temporary Codex image input;
TXT/YAML/JSON is labelled untrusted evidence. Temporary files are deleted after
the turn and are not stored in SQLite.

## API

Every protected endpoint requires the CloudTool cookie plus `X-Cloud-Token`,
`X-Project-Id`, and `X-CSRF-Token` headers.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/chat` | Perform one Codex turn with on-demand, read-only CloudTool MCP retrieval. |
| `POST /api/v1/chat/stream` | SSE lifecycle stream (`started`, `completed`, `error`) for a protected project chat. |
| `POST /api/v1/requests/{request_id}/cancel` | Stop a running protected Codex chat request. |
| `POST /api/v1/external/chat` | API-key-protected, general read-only Codex chat; it never receives CloudTool data. |
| `POST /api/v1/external/chat/stream` | API-key-protected SSE lifecycle stream for external chat. |
| `POST /api/v1/external/requests/{request_id}/cancel` | API-key-protected cancellation for an external request. |
| `GET /api/v1/conversations` | Restore current user's chats for current project. |
| `GET/PUT /api/v1/settings/codex` | Read/save Codex configuration; admin only. |
| `POST /api/v1/settings/codex/test` | Test Codex CLI availability; admin only. |
| `POST /api/v1/terminal/ticket` | Create a 60-second, one-use admin ticket for the direct Codex CLI terminal. |
| `WS /api/v1/terminal/ws` | Interactive Codex-only pseudo-terminal; it never exposes CMD, PowerShell, or another host shell. |
| `GET /health/live` | Liveness only; does not contact cloud APIs. |

## Security controls

- Backend access is an explicit GET-only allow-list; no caller-controlled URL
  or method is accepted.
- `/auth/me` validates the CloudTool session for each agent request.
- Secrets, user-data, cookies, console URLs, passwords, keys and tokens are
  redacted before evidence reaches Codex or the audit database.
- Codex is invoked without a shell with `--sandbox read-only` and
  `--ask-for-approval never`.
- The optional direct terminal is a separate, admin-only Codex session. It
  uses Codex's normal interactive permissions and approvals, has a one-use
  60-second WebSocket ticket, validates the browser origin, and audits only
  lifecycle events (not terminal text, which may contain sensitive material).
- Only `codex`, `codex.exe`, `codex.cmd`, and `codex.bat` are accepted.
- A semaphore allows one local Codex execution at a time.
- Configuration saves, connection tests, and chats are recorded in the
  independent agent-service audit log.

## Environment

```ini
HOST=127.0.0.1
PORT=8005
CLOUDTOOL_BACKEND_URL=http://127.0.0.1:8003/api/v1
CORS_ORIGINS=["http://localhost:5000"]
TRUSTED_HOSTS=["localhost","127.0.0.1"]
AGENT_LLM_PROVIDER=codex_app_server
CODEX_COMMAND=codex
CODEX_MODEL=
CODEX_REASONING_EFFORT=medium
CODEX_WORKDIR=.
CODEX_TIMEOUT_SECONDS=120
CODEX_TERMINAL_ENABLED=false
AGENT_EXTERNAL_API_KEY=
```

## External chat API

Set a long random `AGENT_EXTERNAL_API_KEY` to enable this endpoint. It is
disabled by default. The external API is intentionally separate from project
analysis: it cannot receive CloudTool cookies or cloud tokens, and therefore
cannot read project data.

```powershell
$headers = @{ "X-Agent-API-Key" = "your-long-random-key" }
$body = @{ message = "Xin chao"; client_id = "integration-name" } | ConvertTo-Json
Invoke-RestMethod http://localhost:8005/api/v1/external/chat -Method Post -Headers $headers -ContentType application/json -Body $body
```

## Troubleshooting

| Issue | Check |
| --- | --- |
| Test connection unavailable | Run `codex --version` as the same OS user as agent-service and verify executable path. |
| Save Settings fails | Ensure frontend origin is in `CORS_ORIGINS`; `PUT` is required. |
| Chat is slow | Evidence may take `REQUEST_TIMEOUT_SECONDS`, then Codex uses its own timeout. Frontend waits 180 seconds. |
| Chat does not resume | Keep the local Codex session store and confirm `codex_session_id` exists in SQLite. |
| No history | History is intentionally scoped by both project and user. |

## Validation

```powershell
..\backend\.venv\Scripts\python -m compileall -q app
```
