# ============================================
# FILENAME: backend/models.py
# ============================================

from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime

# ==================== Pydantic Models (API Request/Response) ====================

class BrokerConnect(BaseModel):
    login: str = Field(..., description="MT5 account number")
    password: str = Field(..., description="MT5 password")
    server: str = Field(..., description="Broker server name")
    broker: str = Field("mt5", description="Broker platform")
    account_type: str = Field("demo", description="Account type: demo or real")
    platform: str = Field("mt5", description="Trading platform")

class TradeRequest(BaseModel):
    user_id: str = Field(..., description="User ID")
    symbol: str = Field(..., description="Trading symbol (e.g., EURUSD)")
    volume: float = Field(..., description="Trade volume in lots")
    type: str = Field(..., description="Trade type: buy or sell")
    stop_loss: Optional[float] = Field(None, description="Stop loss price")
    take_profit: Optional[float] = Field(None, description="Take profit price")

class ClosePositionRequest(BaseModel):
    user_id: str = Field(..., description="User ID")
    position_id: str = Field(..., description="Position ID")

class UserResponse(BaseModel):
    id: str
    broker_account: str
    server: str
    broker: str
    account_type: str
    balance: float
    equity: float
    currency: str
    last_login: Optional[datetime]

class PositionResponse(BaseModel):
    id: str
    user_id: str
    symbol: str
    type: str
    volume: float
    open_price: float
    current_price: float
    profit: float
    stop_loss: Optional[float]
    take_profit: Optional[float]
    status: str
    opened_at: datetime
    closed_at: Optional[datetime]

class OrderResponse(BaseModel):
    id: str
    user_id: str
    symbol: str
    type: str
    volume: float
    price: float
    status: str
    created_at: datetime
    executed_at: Optional[datetime]

class NewsResponse(BaseModel):
    id: str
    title: str
    content: str
    source: str
    category: str
    published_at: datetime
    image_url: Optional[str]

class AccountInfoResponse(BaseModel):
    user_id: str
    broker_account: str
    server: str
    balance: float
    equity: float
    margin: float
    free_margin: float
    currency: str

class ErrorResponse(BaseModel):
    error: str
    details: Optional[str] = None