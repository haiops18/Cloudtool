from ipaddress import ip_address, ip_network
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator


class DataDisk(BaseModel):
    size_gb: int = Field(ge=1, le=65536)
    disk_type: str = Field(min_length=1, max_length=100)
    mount_point: str = Field(default="/data", pattern=r"^/")
    filesystem: str = Field(default="ext4", pattern=r"^(ext4|xfs)$")


class VolumeSpec(BaseModel):
    volume_type: str = Field(min_length=1, max_length=100)
    volume_type_name: str = Field(default="", max_length=160)
    size: int = Field(ge=1, le=65536)
    mount_as: Literal["root", "data"]
    mount_point: str = Field(default="", max_length=160)


class ServerSpec(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    zone: str = Field(default="", max_length=160)
    flavor_name: str = Field(default="", max_length=160)
    image_name: str = Field(default="", max_length=240)
    boot_disk_gb: int = Field(default=40, ge=1, le=65536)
    disk_type: str = Field(default="", max_length=100)
    data_disks: list[DataDisk] = Field(default_factory=list, max_length=16)
    vpc_name: str = Field(default="", max_length=160)
    vpc_cidr: str | None = None
    subnet_name: str = Field(default="", max_length=160)
    subnet_cidr: str | None = None
    keypair: str = Field(default="", max_length=160)
    security_groups: list[str] = Field(default_factory=list)
    assign_public_ip: bool = False
    private_ip: str | None = None
    local_ip: str | None = None
    teleport_system: str | None = None
    monitor_ip: str | None = None
    cloud_init_enabled: bool = False
    cloud_init_content: str | None = Field(default=None, max_length=262_144)
    cloud_init_template_id: str | None = None
    cloud_init_template_name: str | None = Field(default=None, max_length=160)
    cloud_init_variables: dict[str, str] = Field(default_factory=dict)
    teleport_enabled: bool = False
    teleport_region: Literal["public", "vpublic"] = "public"
    teleport_hostname: str | None = Field(default=None, max_length=160)
    teleport_monitor_subnet_id: str | None = None
    teleport_monitor_ip: str | None = None
    zone_id: str | None = None
    zone_name: str | None = None
    region_id: str | None = None
    instance_family: Literal["basic", "gpu"] = "basic"
    specs_kind: Literal["predefined", "custom"] = "predefined"
    ram: int | None = Field(default=None, ge=1, le=1048576)
    vcpus: int | None = Field(default=None, ge=1, le=1024)
    boot_source: Literal["public_image"] = "public_image"
    image_id: str | None = None
    image_display_name: str | None = None
    key_pair_id: str | None = None
    key_pair_name: str | None = None
    bandwidth: int = Field(default=300, ge=1, le=10000)
    enable_ipv4: bool = True
    elastic_ip_mode: Literal["none", "auto", "existing"] = "none"
    elastic_ip_id: str | None = None
    elastic_ip_address: str | None = None
    private_network_mode: Literal["subnet", "eni"] = "subnet"
    private_ip_mode: Literal["auto", "existing"] = "auto"
    subnet_id: str | None = None
    subnet_display_name: str | None = None
    eni_id: str | None = None
    eni_address: str | None = None
    security_group_ids: list[str] = Field(default_factory=list)
    security_group_names: list[str] = Field(default_factory=list)
    placement_group_id: str | None = None
    placement_group_name: str | None = Field(default=None, max_length=160)
    volumes: list[VolumeSpec] = Field(default_factory=list, max_length=16)

    @field_validator("vpc_cidr", "subnet_cidr")
    @classmethod
    def cidr(cls, value):
        if value:
            ip_network(value, strict=False)
        return value

    @field_validator("private_ip", "local_ip", "monitor_ip", "teleport_monitor_ip")
    @classmethod
    def ip(cls, value):
        if value:
            ip_address(value)
        return value

    @model_validator(mode="after")
    def creation_contract(self):
        if self.specs_kind == "custom" and (not self.ram or not self.vcpus):
            raise ValueError("Custom specs require RAM and vCPUs")
        if self.elastic_ip_mode == "existing" and not self.elastic_ip_id:
            raise ValueError("Existing Elastic IP is required")
        if self.elastic_ip_mode != "none" and not self.enable_ipv4:
            raise ValueError("IPv4 must be enabled when Elastic IP is enabled")
        if (self.private_network_mode == "eni" or self.private_ip_mode == "existing") and not self.eni_id:
            raise ValueError("ENI is required")
        if not (self.subnet_id or self.subnet_name):
            raise ValueError("Subnet is required")
        if self.volumes:
            roots = sum(volume.mount_as == "root" for volume in self.volumes)
            if roots != 1:
                raise ValueError("Exactly one root volume is required")
        if self.teleport_enabled and not self.cloud_init_enabled:
            raise ValueError("Teleport requires cloud-init")
        return self


class DeploymentCreate(BaseModel):
    name: str = Field(default="Server deployment", min_length=1, max_length=160)
    region: str = Field(min_length=1, max_length=100)
    teleport_enabled: bool = False
    monitor_project_id: str | None = None
    delay_between_create_ms: int = Field(default=200, ge=0, le=60000)
    execution_mode: Literal["standard", "guarded_sequential"] = "standard"
    wait_for_running_seconds: int = Field(default=60, ge=10, le=3600)
    compensation_limit: int = Field(default=3, ge=0, le=100)
    failure_limit: int = Field(default=3, ge=0, le=100)
    servers: list[ServerSpec] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def unique_names(self):
        names = [item.name.casefold() for item in self.servers]
        if len(names) != len(set(names)):
            raise ValueError("Server names must be unique")
        return self


class ServerDraftSave(BaseModel):
    """A UI draft is intentionally permissive: incomplete rows must be restorable."""

    servers: list[dict] = Field(default_factory=list, max_length=200)
