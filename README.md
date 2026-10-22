# CloudTool

CloudTool is a secure web application for project-scoped Viettel Cloud operations. It provides a React frontend, a FastAPI backend gateway, server provisioning, cloud-init templates, audit logging, exports, a read-only AI analysis service, and a local stateful Cloud API simulator.

The user interface and all user-facing messages are English-only.

## Main capabilities

- Session-based authentication with HttpOnly cookies and CSRF protection
- In-memory private Cloud API token handling in the browser
- Personal or organization project selection
- Project-scoped server listing and console access
- Bulk server rename and password changes with confirmation previews
- Private IP range creation with optional failure compensation
- Private IP attachment with project, availability, zone, and region validation
- Monitor VPC sharing through backend-configured region mappings
- CSV and XLSX server exports
- Redacted activity and upstream Cloud API audit logs
- Role-based access control for viewer, operator, and administrator roles
- Local stateful mock Cloud API for safe development
- Terraform-style server creation workspace with Excel import/export, deployment history, per-server results, and sequential API calls
- Cloud-init template management, variables, volume mounting, static networking, and optional Teleport registration
- Isolated read-only AI project analysis: server, network, subnet, security group, audit and Cloud API evidence

## Quick start

After completing the one-time setup below, run this file from the repository root:

```cmd
start-cloudtool.cmd
```

It opens two terminals:

| Service | URL | Entry point |
| --- | --- | --- |
| Backend gateway | `http://127.0.0.1:8003` | `app.terraform_app:app` |
| Frontend | `http://localhost:5173` | Vite production mode |

The frontend uses production mode in the starter script so TanStack developer panels are not displayed. Stop each service with `Ctrl+C` in its own terminal.

## Architecture

```text
Browser (React + Vite)
        |
        | session cookie, CSRF header, project ID, memory-only cloud token
        v
FastAPI backend gateway
        |
        | Authorization: Token <private-token>
        | project-id: <selected-project-id>
        v
Real Cloud API or local mock Cloud API
```

The backend owns upstream endpoint construction, validation, concurrency limits, retries for safe reads, secret redaction, audit logging, and response normalization. The frontend never calls the Cloud API directly.

For server provisioning, the frontend submits a deployment to the backend. The backend writes deployment/audit records, renders cloud-init variables per server, then calls the Cloud API sequentially with the configured delay.

## Repository layout

```text
backend/             FastAPI application, Alembic migrations, and tests
frontend/            React, TypeScript, TanStack Router, and Tailwind UI
terraform/           Legacy standalone Terraform reference project
mock_cloud_api/      Stateful local Cloud API simulator and tests
docs/                Development and testing guides
APIdoc/              Upstream API reference material
agent-service/       Isolated read-only AI analysis gateway and audit database
data/                Local SQLite database, logs, and generated runtime data
```

## Requirements

- Python 3.12 or later
- Node.js 20 or later
- npm

## Backend setup

```powershell
Set-Location .\backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev]"
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.terraform_app:app --host 127.0.0.1 --port 8003 --reload
```

Before the first start, set these secrets in `backend/.env`:

- `PASSWORD_PROFILE_ENCRYPTION_KEY`
- `BOOTSTRAP_ADMIN_EMAIL`
- `BOOTSTRAP_ADMIN_PASSWORD`

The default local SQLite URL writes to `data/`. Keep that directory writable by the account running the backend.

## Frontend setup

```powershell
Set-Location .\frontend
npm install
npm run dev -- --mode production --port 5173
```

Open `http://localhost:5173`.

## Read-only AI agent service

The AI Analysis page is isolated from the CloudTool backend. It only calls a
hard allow-list of existing **GET** endpoints via the CloudTool backend; it
does not store Cloud tokens and filters secret-like fields before a model call.
No console, SSH, Teleport, resource mutation, or command execution is enabled.

```powershell
Copy-Item .\agent-service\.env.example .\agent-service\.env
.\start-agent-service.cmd
```

The default service URL is `http://127.0.0.1:8005`. Set
`VITE_AGENT_API_BASE_URL` only when the agent service uses a different URL.
Set `AGENT_OPENAI_API_KEY` in `agent-service/.env` to enable model-generated
analysis. Without it, the page remains operational in evidence-only mode.

## Safe testing with the mock Cloud API

The current local `backend/.env` is configured to use the simulator at `http://127.0.0.1:9000`. A development-only private token has been generated in the ignored file `mock_cloud_api/.env`.

Follow [Testing CloudTool with the Mock Cloud API](docs/MOCK_CLOUD_API_TESTING.md) for startup commands, the token retrieval command, sample resources, an end-to-end test flow, reset instructions, and the steps for switching back to the real Cloud API.

Quick start from the repository root:

```powershell
.\backend\.venv\Scripts\python.exe -m uvicorn mock_cloud_api.app:app --host 127.0.0.1 --port 9000
```

## Configuration reference

Important backend settings:

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Async SQLAlchemy database URL |
| `CLOUD_API_BASE_URL` | Real or simulated upstream base URL |
| `CLOUD_API_ALLOWED_HOSTS` | Allowlist for returned console links |
| `MONITOR_REGION_MAPPING` | Region-to-monitor VPC and source-project mapping |
| `TOKEN_MAX_IDLE_SECONDS` | Browser memory token idle lifetime |
| `PASSWORD_PROFILE_ENCRYPTION_KEY` | Fernet key used for password profiles |
| `SESSION_TTL_SECONDS` | Authenticated session lifetime |
| `DEBUG_CLOUD_APPROVAL_MODE` | Optional development-only upstream preview gate |

Production configuration requires HTTPS, secure cookies, a valid encryption key, debug features disabled, restricted trusted hosts, and explicit CORS origins.

## Tests and quality checks

Backend and mock API:

```powershell
Set-Location .\backend
.\.venv\Scripts\python.exe -m ruff check app tests ..\mock_cloud_api
.\.venv\Scripts\python.exe -m pytest -q
Set-Location ..
.\backend\.venv\Scripts\python.exe -m pytest mock_cloud_api/tests -q
```

Frontend:

```powershell
Set-Location .\frontend
npm run lint
npm test
npm run build
npm audit --omit=dev
```

## Security notes

- Cloud private tokens are kept only in the current browser tab's Zustand store.
- Tokens and passwords must never be written to logs, exports, URLs, local storage, or error messages.
- Password profile ciphertext is encrypted at rest and decrypted only for an authorized upstream request.
- Mutation endpoints require an authenticated operator or administrator and a valid CSRF token.
- All upstream resource operations are revalidated against the selected project.
- The AI service validates the CloudTool session on every request, only forwards
  project context in memory, only permits an explicit read-only GET allow-list,
  redacts secrets before model calls, and writes an independent audit trail.
- CSV exports guard against spreadsheet formula injection.
- The mock token is development-only and cannot authenticate against the real Cloud API.

## API documentation

With the backend running, open `http://127.0.0.1:8003/docs`. With the mock service running, open `http://127.0.0.1:9000/docs`.
