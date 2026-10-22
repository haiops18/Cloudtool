"""CloudTool application entry point with Terraform integration enabled.

Use ``uvicorn app.terraform_app:app`` during the integration phase. Keeping the
composition here avoids changing the established application entry point until
the new service contract has been accepted.
"""

from app.api.routers import auth, auth_identity, cloud_authorizations, server_creation_options
from app.main import app
from app.provisioning.router import router as provisioning_router

# The main application keeps its API router by reference. Replacing the route
# on its source router therefore preserves `/api/v1/auth/login` while allowing
# local usernames as well as email addresses.
auth.router.routes[:] = [
    route
    for route in auth.router.routes
    if not (getattr(route, "path", None) == "/auth/login" and "POST" in getattr(route, "methods", set()))
]
auth.router.add_api_route(
    "/login",
    auth_identity.login_identity,
    methods=["POST"],
    response_model=auth_identity.UserOut,
)

app.include_router(server_creation_options.router, prefix="/api/v1")
app.include_router(cloud_authorizations.router, prefix="/api/v1")
app.include_router(provisioning_router, prefix="/api/v1")

__all__ = ["app"]
