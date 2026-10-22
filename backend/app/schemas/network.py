from typing import Literal

from pydantic import BaseModel, Field, field_validator


class NetworkResourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)
    cidr: str | None = Field(default=None, max_length=64)
    region: str | None = Field(default=None, max_length=160)
    vpc: str | None = Field(default=None, max_length=160)

    @field_validator("name", "description", "cidr", "region", "vpc")
    @classmethod
    def strip_text(cls, value: str | None) -> str | None:
        return value.strip() if isinstance(value, str) else value


class NetworkResourceUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=500)

    @field_validator("name", "description")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()


class NetworkDeleteBatch(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=1000)


class VpcInternetAccessIn(BaseModel):
    enabled: bool
    route_table_id: str | None = None


class NetworkImportItem(NetworkResourceCreate):
    client_id: str = Field(min_length=1, max_length=120)
    resource_type: Literal["vpc", "subnet", "security_group"]


class NetworkImportIn(BaseModel):
    items: list[NetworkImportItem] = Field(min_length=1, max_length=1000)
