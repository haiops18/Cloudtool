from fastapi import APIRouter

from app.api.routers import auth, cloud, logs, profiles, settings, users, prometheus, teleport
from app.api.routers import agent_project_actions

api_router = APIRouter(prefix="/api/v1")
for item in (
    auth.router,
    users.router,
    profiles.router,
    cloud.router,
    agent_project_actions.router,
    logs.router,
    settings.router,
    prometheus.router,
    teleport.router,
):
    api_router.include_router(item)
