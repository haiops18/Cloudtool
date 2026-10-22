from app.api.routers.cloud import build_ip_range
from app.schemas.common import IpRangeIn


def test_build_range_by_count():
    values = build_ip_range(IpRangeIn(subnet_id="s", start_ip="10.0.0.10", count=3))
    assert [str(item) for item in values] == ["10.0.0.10", "10.0.0.11", "10.0.0.12"]
