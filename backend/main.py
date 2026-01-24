# ============================================
# FILENAME: backend/main.py
# ============================================

from fastapi import FastAPI, HTTPException, Depends, Body, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer
from typing import List, Optional
import os
from datetime import datetime
import asyncio
import json

from appwrite_client import appwrite_client
from encryption import encrypt_password, decrypt_password
from models import (
    BrokerConnect, TradeRequest, ClosePositionRequest,
    UserResponse, PositionResponse, OrderResponse, NewsResponse,
    AccountInfoResponse, ErrorResponse
)

# Initialize FastAPI app
app = FastAPI(
    title="KanAIRY Trading API",
    version="2.0.0",
    description="Advanced MT5 Trading Platform with Appwrite Backend",
    docs_url="/api/docs",
    redoc_url="/api/redoc"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Security
security = HTTPBearer()

# Initialize MetaAPI
metaapi_token = os.getenv("METAAPI_TOKEN")
if not metaapi_token:
    print("⚠️  WARNING: METAAPI_TOKEN not set!")
    metaapi_client = None
else:
    print(f"🔑 MetaAPI token loaded")
    from metaapi_client import MetaAPIClient
    metaapi_client = MetaAPIClient(metaapi_token)

print("\n" + "="*60)
print("🚀 KANAIRY TRADING API v2.0 - Appwrite Backend")
print("="*60)
print(f"📦 Appwrite Project: {os.getenv('APPWRITE_PROJECT_ID', '')[:20]}...")
print(f"🔗 Database: {appwrite_client.database_id}")
print(f"🌐 Endpoint: {os.getenv('APPWRITE_ENDPOINT')}")
print("✅ API initialized successfully")
print("="*60 + "\n")

# ========== HEALTH & STATUS ENDPOINTS ==========

@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    """Serve the frontend application"""
    try:
        with open("static/index.html", "r") as f:
            return HTMLResponse(content=f.read(), status_code=200)
    except FileNotFoundError:
        return HTMLResponse(content="""
        <html>
            <head><title>KanAIRY Trading Platform</title></head>
            <body style="background: #000; color: #fff; font-family: Arial; text-align: center; padding: 50px;">
                <h1>🚀 KanAIRY Trading Platform</h1>
                <p>Backend API is running successfully!</p>
                <p>📚 <a href="/api/docs" style="color: #2979ff;">API Documentation</a></p>
                <p>👨‍💻 Created by Thakgalo Matlala</p>
            </body>
        </html>
        """)

@app.get("/api/health")
async def health_check():
    """Health check endpoint"""
    appwrite_health = appwrite_client.health_check()
    
    return {
        "status": "healthy",
        "timestamp": datetime.utcnow().isoformat(),
        "service": "KanAIRY Trading API",
        "version": "2.0.0",
        "appwrite": "connected" if appwrite_health else "disconnected",
        "metaapi": "configured" if metaapi_token else "not_configured",
        "database": appwrite_client.database_id
    }

@app.get("/api/status")
async def system_status():
    """Detailed system status"""
    databases = appwrite_client.list_databases()
    collections = appwrite_client.list_collections()
    
    return {
        "appwrite": {
            "connected": appwrite_client.health_check(),
            "project_id": os.getenv("APPWRITE_PROJECT_ID", "")[:20] + "...",
            "database_count": len(databases),
            "collection_count": len(collections)
        },
        "metaapi": {
            "configured": metaapi_token is not None,
            "token_length": len(metaapi_token) if metaapi_token else 0
        },
        "encryption": {
            "enabled": True,
            "key_length": len(os.getenv("ENCRYPTION_KEY", ""))
        }
    }

# ========== USER MANAGEMENT ENDPOINTS ==========

@app.post("/api/users/connect", response_model=AccountInfoResponse)
async def connect_broker(data: BrokerConnect):
    """Connect to a broker account via MetaAPI"""
    try:
        if not metaapi_client:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="MetaAPI not configured. Set METAAPI_TOKEN environment variable."
            )
        
        print(f"\n{'='*60}")
        print(f"🔌 BROKER CONNECTION REQUEST")
        print(f"{'='*60}")
        print(f"Login: {data.login}")
        print(f"Server: {data.server}")
        print(f"Platform: {data.platform}")
        
        # Check if user already exists
        existing_user = appwrite_client.get_user_by_broker_account(data.login, data.server)
        
        if existing_user:
            user_id = existing_user["$id"]
            print(f"👤 Existing user found (ID: {user_id})")
            
            # Decrypt password for MetaAPI
            try:
                decrypted_password = decrypt_password(
                    existing_user["encrypted_password"],
                    existing_user["iv"],
                    existing_user["auth_tag"]
                )
                print(f"🔓 Password decrypted for existing user")
            except Exception as e:
                print(f"⚠️ Could not decrypt stored password: {e}")
                decrypted_password = data.password
        else:
            # Encrypt password
            encrypted = encrypt_password(data.password)
            
            # Create user in Appwrite
            user_data = {
                "broker_account": data.login,
                "encrypted_password": encrypted['encrypted'],
                "iv": encrypted['iv'],
                "auth_tag": encrypted['auth_tag'],
                "server": data.server,
                "broker": data.broker,
                "account_type": data.account_type,
                "balance": 0.0,
                "equity": 0.0,
                "currency": "USD",
                "last_login": datetime.utcnow().isoformat()
            }
            
            result = appwrite_client.create_user(user_data)
            user_id = result["$id"]
            print(f"✨ New user created (ID: {user_id})")
            decrypted_password = data.password
        
        # Connect to MetaAPI
        print(f"🔗 Connecting to MetaAPI...")
        account_info = await metaapi_client.connect_account(
            login=data.login,
            password=decrypted_password,
            server=data.server,
            platform=data.platform
        )
        
        # Update user balance
        appwrite_client.update_user(user_id, {
            "balance": account_info['balance'],
            "equity": account_info['equity'],
            "last_login": datetime.utcnow().isoformat()
        })
        
        print(f"\n✅ CONNECTION SUCCESSFUL!")
        print(f"Balance: ${account_info['balance']:.2f}")
        print(f"Equity: ${account_info['equity']:.2f}")
        print(f"Currency: {account_info['currency']}")
        print(f"{'='*60}\n")
        
        return AccountInfoResponse(
            user_id=user_id,
            broker_account=data.login,
            server=data.server,
            balance=account_info['balance'],
            equity=account_info['equity'],
            margin=account_info.get('margin', 0),
            free_margin=account_info.get('freeMargin', 0),
            currency=account_info['currency']
        )
        
    except Exception as e:
        print(f"\n❌ CONNECTION FAILED: {str(e)}\n")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Connection failed: {str(e)}"
        )

@app.get("/api/users/{user_id}", response_model=UserResponse)
async def get_user(user_id: str):
    """Get user information"""
    user = appwrite_client.get_user_by_id(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )
    
    return UserResponse(
        id=user["$id"],
        broker_account=user["broker_account"],
        server=user["server"],
        broker=user["broker"],
        account_type=user["account_type"],
        balance=user["balance"],
        equity=user["equity"],
        currency=user["currency"],
        last_login=datetime.fromisoformat(user["last_login"]) if user.get("last_login") else None
    )

@app.get("/api/users/{user_id}/account", response_model=AccountInfoResponse)
async def get_account_info(user_id: str):
    """Get account information from MetaAPI"""
    try:
        user = appwrite_client.get_user_by_id(user_id)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        if not metaapi_client:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="MetaAPI not configured"
            )
        
        # Get fresh data from MetaAPI
        try:
            account_info = await metaapi_client.get_account_info(user["broker_account"])
            
            # Update database
            appwrite_client.update_user(user_id, {
                "balance": account_info['balance'],
                "equity": account_info['equity']
            })
            
            return AccountInfoResponse(
                user_id=user_id,
                broker_account=user["broker_account"],
                server=user["server"],
                balance=account_info['balance'],
                equity=account_info['equity'],
                margin=account_info.get('margin', 0),
                free_margin=account_info.get('freeMargin', 0),
                currency=account_info['currency']
            )
        except Exception as metaapi_error:
            # If MetaAPI fails, return cached data
            print(f"⚠️ MetaAPI error, using cached data: {metaapi_error}")
            return AccountInfoResponse(
                user_id=user_id,
                broker_account=user["broker_account"],
                server=user["server"],
                balance=user["balance"],
                equity=user["equity"],
                margin=0,
                free_margin=0,
                currency=user.get("currency", "USD")
            )
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

# ========== TRADING ENDPOINTS ==========

@app.post("/api/trade")
async def place_trade(trade: TradeRequest):
    """Place a new trade"""
    try:
        if not metaapi_client:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="MetaAPI not configured"
            )
        
        print(f"\n{'='*60}")
        print(f"📊 TRADE REQUEST")
        print(f"{'='*60}")
        print(f"User ID: {trade.user_id}")
        print(f"Symbol: {trade.symbol}")
        print(f"Type: {trade.type}")
        print(f"Volume: {trade.volume}")
        
        # Get user
        user = appwrite_client.get_user_by_id(trade.user_id)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        # Execute trade via MetaAPI
        result = await metaapi_client.place_trade(
            account_login=user["broker_account"],
            symbol=trade.symbol,
            volume=trade.volume,
            action_type=trade.type,
            stop_loss=trade.stop_loss,
            take_profit=trade.take_profit
        )
        
        print(f"✅ Trade executed successfully")
        print(f"Order ID: {result.get('orderId')}")
        print(f"{'='*60}\n")
        
        # Save position to Appwrite
        position_data = {
            "user_id": trade.user_id,
            "symbol": trade.symbol,
            "type": trade.type.capitalize(),
            "volume": trade.volume,
            "open_price": result.get('openPrice', result.get('price', 0)),
            "current_price": result.get('openPrice', result.get('price', 0)),
            "stop_loss": trade.stop_loss,
            "take_profit": trade.take_profit,
            "profit": 0.0,
            "status": "open",
            "broker_position_id": str(result.get('positionId', result.get('orderId', ''))),
            "opened_at": datetime.utcnow().isoformat()
        }
        
        position_result = appwrite_client.create_position(position_data)
        
        return {
            "success": True,
            "position_id": position_result["$id"],
            "broker_order_id": result.get('orderId'),
            "broker_position_id": result.get('positionId'),
            "symbol": trade.symbol,
            "volume": trade.volume,
            "price": result.get('openPrice', result.get('price')),
            "message": f"{trade.type.upper()} order executed successfully"
        }
        
    except Exception as e:
        print(f"❌ Trade failed: {str(e)}")
        print(f"{'='*60}\n")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

@app.get("/api/users/{user_id}/positions", response_model=List[PositionResponse])
async def get_positions(user_id: str, status: str = "open"):
    """Get positions for a user"""
    try:
        positions = appwrite_client.get_positions(user_id, status)
        
        # If MetaAPI is available, try to sync positions
        if metaapi_client and status == "open":
            try:
                user = appwrite_client.get_user_by_id(user_id)
                if user:
                    # Get fresh positions from MetaAPI
                    metaapi_positions = await metaapi_client.get_positions(user["broker_account"])
                    
                    # Update positions in database (simplified sync)
                    for meta_pos in metaapi_positions:
                        # Find matching position and update
                        pass
            except Exception as sync_error:
                print(f"⚠️ Could not sync with MetaAPI: {sync_error}")
        
        return [
            PositionResponse(
                id=pos["$id"],
                user_id=pos["user_id"],
                symbol=pos["symbol"],
                type=pos["type"],
                volume=pos["volume"],
                open_price=pos["open_price"],
                current_price=pos["current_price"],
                profit=pos["profit"],
                stop_loss=pos.get("stop_loss"),
                take_profit=pos.get("take_profit"),
                status=pos["status"],
                opened_at=datetime.fromisoformat(pos["opened_at"]),
                closed_at=datetime.fromisoformat(pos["closed_at"]) if pos.get("closed_at") else None
            )
            for pos in positions
        ]
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

@app.post("/api/positions/close")
async def close_position(request: ClosePositionRequest):
    """Close a position"""
    try:
        if not metaapi_client:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="MetaAPI not configured"
            )
        
        position = appwrite_client.get_position_by_id(request.position_id)
        if not position:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Position not found"
            )
        
        user = appwrite_client.get_user_by_id(request.user_id)
        if not user:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="User not found"
            )
        
        print(f"\n🔒 Closing position {position['$id']} ({position['symbol']})")
        
        # Close via MetaAPI
        result = await metaapi_client.close_position(
            account_login=user["broker_account"],
            position_id=position["broker_position_id"]
        )
        
        # Update position in Appwrite
        update_data = {
            "current_price": result.get('closePrice', position["current_price"]),
            "profit": result.get('profit', 0) or result.get('pl', 0),
            "status": "closed",
            "closed_at": datetime.utcnow().isoformat()
        }
        
        appwrite_client.update_position(request.position_id, update_data)
        
        print(f"✅ Position closed successfully")
        print(f"Profit: ${update_data['profit']:.2f}\n")
        
        return {
            "success": True,
            "message": "Position closed successfully",
            "position_id": request.position_id,
            "profit": update_data['profit']
        }
        
    except Exception as e:
        print(f"❌ Failed to close position: {str(e)}\n")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

# ========== ORDER MANAGEMENT ==========

@app.get("/api/users/{user_id}/orders", response_model=List[OrderResponse])
async def get_orders(user_id: str, status: str = "pending"):
    """Get orders for a user"""
    try:
        orders = appwrite_client.get_orders(user_id, status)
        
        return [
            OrderResponse(
                id=order["$id"],
                user_id=order["user_id"],
                symbol=order["symbol"],
                type=order["type"],
                volume=order["volume"],
                price=order["price"],
                status=order["status"],
                created_at=datetime.fromisoformat(order["created_at"]),
                executed_at=datetime.fromisoformat(order["executed_at"]) if order.get("executed_at") else None
            )
            for order in orders
        ]
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

# ========== NEWS ENDPOINTS ==========

@app.get("/api/news", response_model=List[NewsResponse])
async def get_news(category: Optional[str] = None, limit: int = 10):
    """Get news articles"""
    try:
        news_articles = appwrite_client.get_news(category, limit)
        
        # If no news in database, create sample news
        if not news_articles:
            sample_news = [
                {
                    "title": "KanAIRY Platform Now Live",
                    "content": "The KanAIRY trading platform is now officially live! Start your automated trading journey today.",
                    "source": "KanAIRY",
                    "category": "platform",
                    "published_at": datetime.utcnow().isoformat(),
                    "image_url": "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w=800"
                },
                {
                    "title": "Forex Market Analysis Q1 2024",
                    "content": "EUR/USD shows strong bullish momentum, breaking key resistance levels. Technical indicators suggest continued upward movement.",
                    "source": "Market Watch",
                    "category": "forex",
                    "published_at": datetime.utcnow().isoformat(),
                    "image_url": "https://images.unsplash.com/photo-1611974789855-9c2a0a7236a3?w-800"
                }
            ]
            
            for news in sample_news:
                appwrite_client.create_news(news)
            
            news_articles = appwrite_client.get_news(category, limit)
        
        return [
            NewsResponse(
                id=news["$id"],
                title=news["title"],
                content=news["content"],
                source=news["source"],
                category=news["category"],
                published_at=datetime.fromisoformat(news["published_at"]),
                image_url=news.get("image_url")
            )
            for news in news_articles
        ]
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

@app.post("/api/news")
async def create_news_article(news: NewsResponse):
    """Create a news article (admin only)"""
    try:
        news_data = {
            "title": news.title,
            "content": news.content,
            "source": news.source,
            "category": news.category,
            "published_at": news.published_at.isoformat(),
            "image_url": news.image_url
        }
        
        result = appwrite_client.create_news(news_data)
        
        return {
            "success": True,
            "news_id": result["$id"],
            "message": "News article created successfully"
        }
        
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )

# ========== ERROR HANDLING ==========

@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content=ErrorResponse(
            error=exc.detail,
            details=str(exc) if str(exc) != exc.detail else None
        ).dict()
    )

@app.exception_handler(Exception)
async def general_exception_handler(request, exc):
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=ErrorResponse(
            error="Internal server error",
            details=str(exc)
        ).dict()
    )

# ========== STARTUP EVENT ==========

@app.on_event("startup")
async def startup_event():
    print("\n✅ KanAIRY Trading API Started Successfully!")
    print(f"📍 Access the app at: http://localhost:{os.getenv('PORT', 8000)}")
    print(f"📚 API Documentation: http://localhost:{os.getenv('PORT', 8000)}/api/docs")
    print(f"👨‍💻 Created by: Thakgalo Matlala")
    print("="*60 + "\n")
    
    # Create some sample data if needed
    await create_sample_data()

async def create_sample_data():
    """Create sample data for testing"""
    try:
        # Check if we have any news
        news = appwrite_client.get_news(limit=1)
        if not news:
            print("📰 Creating sample news articles...")
            
            sample_news = [
                {
                    "title": "Welcome to KanAIRY Trading Platform",
                    "content": "This is an advanced trading platform built by Thakgalo Matlala. Connect your MT5 account and start automated trading.",
                    "source": "KanAIRY",
                    "category": "announcement",
                    "published_at": datetime.utcnow().isoformat()
                },
                {
                    "title": "EUR/USD Technical Analysis",
                    "content": "The EUR/USD pair is showing strong bullish signals. Key resistance at 1.0900, support at 1.0800.",
                    "source": "Technical Analysis",
                    "category": "forex",
                    "published_at": datetime.utcnow().isoformat()
                }
            ]
            
            for news_item in sample_news:
                appwrite_client.create_news(news_item)
            
            print("✅ Sample data created")
    except Exception as e:
        print(f"⚠️ Could not create sample data: {e}")

if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)