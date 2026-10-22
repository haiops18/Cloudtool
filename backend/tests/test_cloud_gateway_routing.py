from unittest.mock import patch

import pytest
from app.core.config import Settings
from app.gateway.client import CloudApiGateway


@pytest.mark.parametrize('method,path,expected', [
    ('GET', '/legacy/api/infra/servers/', '/infra/servers/'),
    ('GET', '/legacy/api/tenant/projects/', '/tenant/projects/'),
    ('POST', '/legacy/api/infra/servers/', '/infra/servers/'),
    ('POST', '/legacy/api/infra/elastic-ips/', '/infra/elastic-ips/'),
    ('PUT', '/legacy/api/infra/servers/vm/', '/infra/servers/vm/'),
    ('DELETE', '/legacy/api/infra/security-groups/sg/', '/infra/security-groups/sg/'),
])
def test_internal_migration_routes_all_methods_without_legacy_prefix(method, path, expected):
    settings = Settings(_env_file=None, CLOUD_API_BASE_URL='http://10.60.159.7:8041',
        CLOUD_API_SERVER_BASE_URL='http://10.60.159.7:8041', CLOUD_API_USE_SERVER_BASE_URL=True)
    with patch('app.gateway.client.settings', settings):
        assert CloudApiGateway._target(method, path) == ('http://10.60.159.7:8041', expected)


def test_default_routing_keeps_existing_server_creation_override():
    settings = Settings(_env_file=None, CLOUD_API_SERVER_BASE_URL='http://internal:8041')
    with patch('app.gateway.client.settings', settings):
        assert CloudApiGateway._target('GET', '/legacy/api/infra/servers/') == ('https://console.viettelcloud.vn', '/legacy/api/infra/servers/')
        assert CloudApiGateway._target('POST', '/legacy/api/infra/servers/') == ('http://internal:8041', '/infra/servers/')

