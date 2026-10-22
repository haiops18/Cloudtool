from uuid import uuid4

from pydantic import BaseModel, Field, field_validator


class Attachment(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    media_type: str = Field(min_length=1, max_length=100)
    content_base64: str = Field(min_length=1, max_length=7_000_000)

    @field_validator("media_type")
    @classmethod
    def allow_safe_types(cls, value: str) -> str:
        # Attachments are stored as inert bytes in the isolated project
        # workspace; Agent Service never executes or imports them. Browsers
        # commonly report Office, archives and vendor formats as
        # application/octet-stream, so do not reject useful user documents by
        # MIME type alone.
        return value.strip().lower()


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=12000)
    conversation_id: str | None = Field(default=None, max_length=100)
    attachments: list[Attachment] = Field(default_factory=list, max_length=5)
    model: str | None = Field(default=None, max_length=120)
    reasoning_effort: str | None = Field(default=None, pattern="^(low|medium|high|xhigh|max|ultra)$")
    skill_ids: list[str] = Field(default_factory=list, max_length=12)
    agent_event: dict | None = None
    request_id: str = Field(default_factory=lambda: str(uuid4()), max_length=100)


class ExternalChatRequest(BaseModel):
    """A Codex chat request for an API consumer outside the CloudTool UI.

    This endpoint deliberately has no CloudTool credentials or project ID: it
    is a general read-only Codex conversation, not a way to access cloud data.
    """

    message: str = Field(min_length=1, max_length=12000)
    conversation_id: str | None = Field(default=None, max_length=100)
    client_id: str = Field(default="external", min_length=1, max_length=100)
    attachments: list[Attachment] = Field(default_factory=list, max_length=5)
    model: str | None = Field(default=None, max_length=120)
    reasoning_effort: str | None = Field(default=None, pattern="^(low|medium|high|xhigh|max|ultra)$")
    request_id: str = Field(default_factory=lambda: str(uuid4()), max_length=100)


class Evidence(BaseModel):
    source: str
    count: int
    note: str | None = None


class VmAction(BaseModel):
    server: str
    command: str
    summary: str


class ApiAction(BaseModel):
    type: str
    security_group_id: str
    rule: dict
    summary: str


class ApiActionExecute(BaseModel):
    type: str
    security_group_id: str
    rule: dict


class ChatResponse(BaseModel):
    request_id: str
    conversation_id: str
    answer: str
    evidence: list[Evidence]
    attachments: list[dict] = Field(default_factory=list)
    artifacts: list[dict] = Field(default_factory=list)
    model_used: str | None = None
    mode: str
    csrf_token: str | None = None
    vm_action: VmAction | None = None
    api_action: ApiAction | None = None
    api_actions: list[ApiAction] = Field(default_factory=list)


class CodexSettingsUpdate(BaseModel):
    provider: str = Field(default="codex_app_server", pattern="^(codex_app_server|evidence_only)$")
    command: str = Field(default="codex", min_length=1, max_length=500)
    model: str = Field(default="", max_length=120)
    reasoning_effort: str = Field(default="medium", pattern="^(low|medium|high|xhigh|max|ultra)$")
    workdir: str = Field(min_length=1, max_length=1000)
    timeout_seconds: int = Field(default=120, ge=30, le=600)
    approval_timeout_seconds: int = Field(default=180, ge=60, le=900)
    system_prompt: str = Field(
        default="You are CloudTool's read-only diagnostic assistant. Answer in Vietnamese. Use CloudTool MCP only for current project facts.",
        min_length=40,
        max_length=12000,
    )
    workspace_prompt: str = Field(min_length=20, max_length=12_000)
    project_chat_prompt: str = Field(min_length=20, max_length=12_000)


class CodexSettingsResponse(CodexSettingsUpdate):
    available: bool
    version: str | None = None
    error: str | None = None
    csrf_token: str | None = None


class CodexModelCatalogItem(BaseModel):
    id: str
    display_name: str
    description: str
    is_default: bool
    reasoning_efforts: list[str]
    default_reasoning_effort: str


class CodexRuntimeResponse(BaseModel):
    models: list[CodexModelCatalogItem]
    # The actual defaults stored by agent-service.  The UI must use these on
    # every page load rather than silently selecting an arbitrary effort.
    configured_model: str | None = None
    configured_reasoning_effort: str
    policy: str
    policy_detail: str


class ConversationMessage(BaseModel):
    id: str
    role: str
    text: str
    evidence: list[Evidence] = Field(default_factory=list)
    attachments: list[dict] = Field(default_factory=list)
    created_at: str


class Conversation(BaseModel):
    id: str
    title: str
    updated_at: str
    codex_session_id: str | None = None
    skill_ids: list[str] = Field(default_factory=list)
    messages: list[ConversationMessage] = Field(default_factory=list)


class ConversationTitleUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=80)


class PromptSuggestionIn(BaseModel):
    title: str = Field(min_length=1, max_length=80)
    prompt: str = Field(min_length=1, max_length=4_000)


class PromptSuggestionPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=80)
    prompt: str | None = Field(default=None, min_length=1, max_length=4_000)


class AgentSkillIn(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=300)
    instructions: str = Field(min_length=1, max_length=12_000)


class AgentSkillPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=100)
    description: str | None = Field(default=None, max_length=300)
    instructions: str | None = Field(default=None, min_length=1, max_length=12_000)
