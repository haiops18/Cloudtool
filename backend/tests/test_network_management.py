import pytest
from fastapi import HTTPException

from app.api.routers.network_management import _validate_create
from app.main import app
from app.schemas.network import NetworkResourceCreate


def test_network_routes_are_registered_without_replacing_existing_routes():
    paths = app.openapi()["paths"]
    expected = {
        "/api/v1/cloud/network/vpcs",
        "/api/v1/cloud/network/subnets",
        "/api/v1/cloud/network/security-groups",
        "/api/v1/cloud/network/import",
    }
    assert expected.issubset(paths)
    assert "/api/v1/cloud/subnets" in paths
    assert "/api/v1/cloud/security-groups" in paths


def test_network_create_payloads_follow_cloud_contract():
    vpc = _validate_create(
        "vpc",
        NetworkResourceCreate(
            name="app-vpc", cidr="10.20.0.0/16", region="region-id"
        ),
    )
    subnet = _validate_create(
        "subnet",
        NetworkResourceCreate(
            name="app-subnet", cidr="10.20.1.0/24", vpc="vpc-id"
        ),
    )
    group = _validate_create(
        "security_group",
        NetworkResourceCreate(name="app-sg", region="region-id"),
    )
    assert vpc == {
        "name": "app-vpc",
        "description": "",
        "cidr": "10.20.0.0/16",
        "region": "region-id",
    }
    assert subnet["vpc"] == "vpc-id"
    assert group == {
        "name": "app-sg",
        "description": "",
        "region": "region-id",
    }


def test_network_create_rejects_non_network_cidr():
    with pytest.raises(HTTPException) as error:
        _validate_create(
            "vpc",
            NetworkResourceCreate(
                name="bad-vpc", cidr="10.20.0.1/16", region="region-id"
            ),
        )
    assert error.value.status_code == 422
