# ============================================
# FILENAME: backend/appwrite_client.py
# ============================================

import os
import json
from datetime import datetime
from typing import Dict, List, Optional, Any
import requests
from dotenv import load_dotenv

load_dotenv()

class AppwriteClient:
    def __init__(self):
        self.project_id = os.getenv("APPWRITE_PROJECT_ID", "")
        self.api_key = os.getenv("APPWRITE_API_KEY", "")
        self.endpoint = os.getenv("APPWRITE_ENDPOINT", "https://cloud.appwrite.io/v1")
        
        self.database_id = os.getenv("APPWRITE_DATABASE_ID", "kanairy_db")
        self.users_collection_id = os.getenv("APPWRITE_USERS_COLLECTION_ID", "users")
        self.positions_collection_id = os.getenv("APPWRITE_POSITIONS_COLLECTION_ID", "positions")
        self.orders_collection_id = os.getenv("APPWRITE_ORDERS_COLLECTION_ID", "orders")
        self.news_collection_id = os.getenv("APPWRITE_NEWS_COLLECTION_ID", "news")
        
        self.headers = {
            "Content-Type": "application/json",
            "X-Appwrite-Project": self.project_id,
            "X-Appwrite-Key": self.api_key
        }
        
        print(f"🔗 Appwrite Client Initialized")
        print(f"   Endpoint: {self.endpoint}")
        print(f"   Project ID: {self.project_id[:20]}...")
        
        # Initialize database and collections
        self.initialize_database()
    
    def _make_request(self, method: str, path: str, data: dict = None, params: dict = None) -> dict:
        """Make HTTP request to Appwrite API"""
        url = f"{self.endpoint}{path}"
        
        try:
            if method == "GET":
                response = requests.get(url, headers=self.headers, params=params)
            elif method == "POST":
                response = requests.post(url, headers=self.headers, json=data)
            elif method == "PUT":
                response = requests.put(url, headers=self.headers, json=data)
            elif method == "DELETE":
                response = requests.delete(url, headers=self.headers, params=params)
            elif method == "PATCH":
                response = requests.patch(url, headers=self.headers, json=data)
            else:
                raise ValueError(f"Unsupported method: {method}")
            
            response.raise_for_status()
            return response.json() if response.content else {}
        except requests.exceptions.RequestException as e:
            print(f"❌ Appwrite API Error: {e}")
            if hasattr(e, 'response') and e.response:
                print(f"   Response: {e.response.text}")
            return {"error": str(e)}
    
    def initialize_database(self):
        """Initialize database and collections if they don't exist"""
        try:
            # Create database if it doesn't exist
            databases = self._make_request("GET", "/databases")
            
            # Check if our database exists
            db_exists = False
            if "databases" in databases:
                for db in databases["databases"]:
                    if db.get("$id") == self.database_id:
                        db_exists = True
                        break
            
            if not db_exists:
                print(f"📦 Creating database: {self.database_id}")
                self._make_request("POST", "/databases", {
                    "databaseId": self.database_id,
                    "name": "KanAIRY Trading Database"
                })
            
            # Create collections
            collections_config = [
                {
                    "id": self.users_collection_id,
                    "name": "Users",
                    "permissions": ["read('any')", "write('any')"],
                    "attributes": [
                        {"key": "broker_account", "type": "string", "size": 100, "required": True},
                        {"key": "encrypted_password", "type": "string", "size": 500, "required": True},
                        {"key": "iv", "type": "string", "size": 100, "required": True},
                        {"key": "auth_tag", "type": "string", "size": 100, "required": True},
                        {"key": "server", "type": "string", "size": 100, "required": True},
                        {"key": "broker", "type": "string", "size": 50, "required": True},
                        {"key": "account_type", "type": "string", "size": 20, "required": True},
                        {"key": "balance", "type": "double", "required": True},
                        {"key": "equity", "type": "double", "required": True},
                        {"key": "currency", "type": "string", "size": 10, "required": True},
                        {"key": "last_login", "type": "datetime", "required": False}
                    ]
                },
                {
                    "id": self.positions_collection_id,
                    "name": "Positions",
                    "permissions": ["read('any')", "write('any')"],
                    "attributes": [
                        {"key": "user_id", "type": "string", "size": 50, "required": True},
                        {"key": "symbol", "type": "string", "size": 20, "required": True},
                        {"key": "type", "type": "string", "size": 10, "required": True},
                        {"key": "volume", "type": "double", "required": True},
                        {"key": "open_price", "type": "double", "required": True},
                        {"key": "current_price", "type": "double", "required": True},
                        {"key": "stop_loss", "type": "double", "required": False},
                        {"key": "take_profit", "type": "double", "required": False},
                        {"key": "profit", "type": "double", "required": True},
                        {"key": "status", "type": "string", "size": 20, "required": True},
                        {"key": "broker_position_id", "type": "string", "size": 100, "required": False},
                        {"key": "opened_at", "type": "datetime", "required": True},
                        {"key": "closed_at", "type": "datetime", "required": False}
                    ]
                },
                {
                    "id": self.orders_collection_id,
                    "name": "Orders",
                    "permissions": ["read('any')", "write('any')"],
                    "attributes": [
                        {"key": "user_id", "type": "string", "size": 50, "required": True},
                        {"key": "symbol", "type": "string", "size": 20, "required": True},
                        {"key": "type", "type": "string", "size": 20, "required": True},
                        {"key": "volume", "type": "double", "required": True},
                        {"key": "price", "type": "double", "required": True},
                        {"key": "stop_loss", "type": "double", "required": False},
                        {"key": "take_profit", "type": "double", "required": False},
                        {"key": "status", "type": "string", "size": 20, "required": True},
                        {"key": "broker_order_id", "type": "string", "size": 100, "required": False},
                        {"key": "created_at", "type": "datetime", "required": True},
                        {"key": "executed_at", "type": "datetime", "required": False}
                    ]
                },
                {
                    "id": self.news_collection_id,
                    "name": "News",
                    "permissions": ["read('any')", "write('any')"],
                    "attributes": [
                        {"key": "title", "type": "string", "size": 200, "required": True},
                        {"key": "content", "type": "string", "size": 5000, "required": True},
                        {"key": "source", "type": "string", "size": 50, "required": True},
                        {"key": "category", "type": "string", "size": 50, "required": True},
                        {"key": "published_at", "type": "datetime", "required": True},
                        {"key": "image_url", "type": "string", "size": 500, "required": False}
                    ]
                }
            ]
            
            for config in collections_config:
                collection_id = config["id"]
                
                # Check if collection exists
                collections = self._make_request("GET", f"/databases/{self.database_id}/collections")
                collection_exists = False
                
                if "collections" in collections:
                    for col in collections["collections"]:
                        if col.get("$id") == collection_id:
                            collection_exists = True
                            break
                
                if not collection_exists:
                    print(f"📄 Creating collection: {config['name']}")
                    collection_data = {
                        "collectionId": collection_id,
                        "name": config["name"],
                        "permissions": config["permissions"]
                    }
                    
                    # Create collection
                    self._make_request("POST", f"/databases/{self.database_id}/collections", collection_data)
                    
                    # Add attributes
                    for attr in config["attributes"]:
                        attr_type = attr["type"]
                        attr_key = attr["key"]
                        
                        if attr_type == "string":
                            self._make_request("POST", f"/databases/{self.database_id}/collections/{collection_id}/attributes/string", {
                                "key": attr_key,
                                "size": attr["size"],
                                "required": attr["required"]
                            })
                        elif attr_type == "double":
                            self._make_request("POST", f"/databases/{self.database_id}/collections/{collection_id}/attributes/double", {
                                "key": attr_key,
                                "required": attr["required"]
                            })
                        elif attr_type == "integer":
                            self._make_request("POST", f"/databases/{self.database_id}/collections/{collection_id}/attributes/integer", {
                                "key": attr_key,
                                "required": attr["required"]
                            })
                        elif attr_type == "datetime":
                            self._make_request("POST", f"/databases/{self.database_id}/collections/{collection_id}/attributes/datetime", {
                                "key": attr_key,
                                "required": attr["required"]
                            })
                        elif attr_type == "boolean":
                            self._make_request("POST", f"/databases/{self.database_id}/collections/{collection_id}/attributes/boolean", {
                                "key": attr_key,
                                "required": attr["required"]
                            })
            
            print("✅ Database initialization complete")
            
        except Exception as e:
            print(f"⚠️ Database initialization error: {e}")
    
    # ========== USER OPERATIONS ==========
    
    def create_user(self, user_data: Dict) -> Dict:
        """Create a new user"""
        return self._make_request("POST", f"/databases/{self.database_id}/collections/{self.users_collection_id}/documents", user_data)
    
    def get_user_by_broker_account(self, broker_account: str, server: str) -> Optional[Dict]:
        """Get user by broker account and server"""
        result = self._make_request("GET", f"/databases/{self.database_id}/collections/{self.users_collection_id}/documents", params={
            "queries": [
                f"equal(\"broker_account\", \"{broker_account}\")",
                f"equal(\"server\", \"{server}\")"
            ],
            "limit": 1
        })
        
        if "documents" in result and len(result["documents"]) > 0:
            return result["documents"][0]
        return None
    
    def get_user_by_id(self, user_id: str) -> Optional[Dict]:
        """Get user by ID"""
        try:
            return self._make_request("GET", f"/databases/{self.database_id}/collections/{self.users_collection_id}/documents/{user_id}")
        except:
            return None
    
    def update_user(self, user_id: str, update_data: Dict) -> Dict:
        """Update user data"""
        return self._make_request("PATCH", f"/databases/{self.database_id}/collections/{self.users_collection_id}/documents/{user_id}", update_data)
    
    def delete_user(self, user_id: str) -> Dict:
        """Delete a user"""
        return self._make_request("DELETE", f"/databases/{self.database_id}/collections/{self.users_collection_id}/documents/{user_id}")
    
    # ========== POSITION OPERATIONS ==========
    
    def create_position(self, position_data: Dict) -> Dict:
        """Create a new trading position"""
        return self._make_request("POST", f"/databases/{self.database_id}/collections/{self.positions_collection_id}/documents", position_data)
    
    def get_positions(self, user_id: str, status: str = None) -> List[Dict]:
        """Get positions for a user"""
        queries = [f"equal(\"user_id\", \"{user_id}\")"]
        
        if status:
            queries.append(f"equal(\"status\", \"{status}\")")
        
        result = self._make_request("GET", f"/databases/{self.database_id}/collections/{self.positions_collection_id}/documents", params={
            "queries": queries,
            "orderField": "opened_at",
            "orderType": "DESC"
        })
        
        return result.get("documents", [])
    
    def get_position_by_id(self, position_id: str) -> Optional[Dict]:
        """Get position by ID"""
        try:
            return self._make_request("GET", f"/databases/{self.database_id}/collections/{self.positions_collection_id}/documents/{position_id}")
        except:
            return None
    
    def update_position(self, position_id: str, update_data: Dict) -> Dict:
        """Update position data"""
        return self._make_request("PATCH", f"/databases/{self.database_id}/collections/{self.positions_collection_id}/documents/{position_id}", update_data)
    
    def delete_position(self, position_id: str) -> Dict:
        """Delete a position"""
        return self._make_request("DELETE", f"/databases/{self.database_id}/collections/{self.positions_collection_id}/documents/{position_id}")
    
    # ========== ORDER OPERATIONS ==========
    
    def create_order(self, order_data: Dict) -> Dict:
        """Create a new order"""
        return self._make_request("POST", f"/databases/{self.database_id}/collections/{self.orders_collection_id}/documents", order_data)
    
    def get_orders(self, user_id: str, status: str = None) -> List[Dict]:
        """Get orders for a user"""
        queries = [f"equal(\"user_id\", \"{user_id}\")"]
        
        if status:
            queries.append(f"equal(\"status\", \"{status}\")")
        
        result = self._make_request("GET", f"/databases/{self.database_id}/collections/{self.orders_collection_id}/documents", params={
            "queries": queries,
            "orderField": "created_at",
            "orderType": "DESC"
        })
        
        return result.get("documents", [])
    
    def update_order(self, order_id: str, update_data: Dict) -> Dict:
        """Update order data"""
        return self._make_request("PATCH", f"/databases/{self.database_id}/collections/{self.orders_collection_id}/documents/{order_id}", update_data)
    
    def delete_order(self, order_id: str) -> Dict:
        """Delete an order"""
        return self._make_request("DELETE", f"/databases/{self.database_id}/collections/{self.orders_collection_id}/documents/{order_id}")
    
    # ========== NEWS OPERATIONS ==========
    
    def create_news(self, news_data: Dict) -> Dict:
        """Create news article"""
        return self._make_request("POST", f"/databases/{self.database_id}/collections/{self.news_collection_id}/documents", news_data)
    
    def get_news(self, category: str = None, limit: int = 10) -> List[Dict]:
        """Get news articles"""
        queries = []
        
        if category:
            queries.append(f"equal(\"category\", \"{category}\")")
        
        result = self._make_request("GET", f"/databases/{self.database_id}/collections/{self.news_collection_id}/documents", params={
            "queries": queries,
            "orderField": "published_at",
            "orderType": "DESC",
            "limit": limit
        })
        
        return result.get("documents", [])
    
    def get_news_by_id(self, news_id: str) -> Optional[Dict]:
        """Get news by ID"""
        try:
            return self._make_request("GET", f"/databases/{self.database_id}/collections/{self.news_collection_id}/documents/{news_id}")
        except:
            return None
    
    # ========== UTILITY METHODS ==========
    
    def list_databases(self) -> List[Dict]:
        """List all databases"""
        result = self._make_request("GET", "/databases")
        return result.get("databases", [])
    
    def list_collections(self) -> List[Dict]:
        """List all collections in current database"""
        result = self._make_request("GET", f"/databases/{self.database_id}/collections")
        return result.get("collections", [])
    
    def health_check(self) -> bool:
        """Check if Appwrite is reachable"""
        try:
            result = self._make_request("GET", "/health")
            return "status" in result and result["status"] == "ok"
        except:
            return False

# Global Appwrite client instance
appwrite_client = AppwriteClient()

print("✅ Appwrite client ready")