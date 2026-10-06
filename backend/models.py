"""Request/response models for the KanAIRY API."""
from typing import Literal, Optional

from pydantic import BaseModel, Field


class ConnectRequest(BaseModel):
    login: str = Field(..., min_length=3, max_length=12, description="MT account number")
    password: str = Field(..., min_length=1, max_length=128)
    server: str = Field(..., min_length=2, max_length=120, description="Broker server exactly as shown in MetaTrader")
    platform: Literal["mt4", "mt5"] = "mt5"
    broker_name: str = Field("", max_length=120)


class OrderRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=40)
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop", "stop_limit"] = "market"
    volume: float = Field(..., gt=0, le=1000)
    price: Optional[float] = Field(None, gt=0)
    stopLimitPrice: Optional[float] = Field(None, gt=0)
    stopLoss: Optional[float] = Field(None, gt=0)
    takeProfit: Optional[float] = Field(None, gt=0)
    comment: Optional[str] = Field(None, max_length=26)
    clientOrderId: Optional[str] = Field(None, min_length=8, max_length=20, pattern=r"^[A-Za-z0-9_-]+$")


class ClosePositionRequest(BaseModel):
    volume: Optional[float] = Field(None, gt=0)


class ModifyRequest(BaseModel):
    stopLoss: Optional[float] = Field(None, ge=0)
    takeProfit: Optional[float] = Field(None, ge=0)
    price: Optional[float] = Field(None, gt=0)
