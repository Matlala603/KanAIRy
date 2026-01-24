# ============================================
# FILENAME: backend/metaapi_client.py
# ============================================

import os
import asyncio
from typing import Optional, Dict, List
from metaapi_cloud_sdk import MetaApi

class MetaAPIClient:
    def __init__(self, token: str):
        self.token = token
        self.api = MetaApi(token)
        self.accounts = {}  # Cache accounts by login
        print("🔌 MetaAPI client initialized")
        
    async def connect_account(
        self, 
        login: str, 
        password: str, 
        server: str,
        platform: str = "mt5"
    ) -> Dict:
        """Connect to a trading account via MetaAPI"""
        try:
            print(f"\n{'='*60}")
            print(f"🔍 MetaAPI: Connecting account {login}")
            print(f"{'='*60}")
            
            # Check if account already exists in MetaAPI
            existing_accounts = await self.api.metatrader_account_api.get_accounts()
            existing_account = None
            
            for acc in existing_accounts:
                if acc.login == login and acc.server == server:
                    existing_account = acc
                    print(f"✅ Found existing MetaAPI account: {acc.id}")
                    break
            
            if existing_account:
                account = existing_account
            else:
                # Create new account in MetaAPI
                print(f"🆕 Creating new MetaAPI account...")
                account = await self.api.metatrader_account_api.create_account({
                    'name': f'KanAIRY_{login}',
                    'type': 'cloud',
                    'login': login,
                    'password': password,
                    'server': server,
                    'platform': platform,
                    'application': 'KanAIRY',
                    'magic': 123456,
                    'region': 'new-york'
                })
                print(f"✅ MetaAPI account created: {account.id}")
            
            # Deploy account
            print(f"🚀 Deploying account...")
            await account.deploy()
            
            # Wait for deployment
            print(f"⏳ Waiting for deployment...")
            await account.wait_deployed()
            print(f"✅ Account deployed")
            
            # Connect
            print(f"🔌 Connecting to broker...")
            await account.wait_connected()
            print(f"✅ Connected to broker")
            
            # Get RPC connection
            connection = account.get_rpc_connection()
            await connection.connect()
            
            print(f"⏳ Synchronizing account data...")
            await connection.wait_synchronized()
            print(f"✅ Account synchronized")
            
            # Get account information
            account_info = await connection.get_account_information()
            
            # Cache account
            self.accounts[login] = {
                'account': account,
                'connection': connection
            }
            
            print(f"\n💰 Account Details:")
            print(f"   Balance: ${account_info['balance']:.2f}")
            print(f"   Equity: ${account_info['equity']:.2f}")
            print(f"   Currency: {account_info.get('currency', 'USD')}")
            print(f"{'='*60}\n")
            
            return {
                'balance': account_info['balance'],
                'equity': account_info['equity'],
                'margin': account_info.get('margin', 0),
                'freeMargin': account_info.get('freeMargin', 0),
                'currency': account_info.get('currency', 'USD'),
                'leverage': account_info.get('leverage', 100),
                'name': account_info.get('name', login)
            }
            
        except Exception as e:
            print(f"\n❌ MetaAPI Error: {str(e)}\n")
            raise Exception(f"MetaAPI connection failed: {str(e)}")
    
    async def get_account_info(self, login: str) -> Dict:
        """Get current account information"""
        try:
            if login not in self.accounts:
                raise Exception("Account not connected. Please connect first.")
            
            connection = self.accounts[login]['connection']
            account_info = await connection.get_account_information()
            
            return {
                'balance': account_info['balance'],
                'equity': account_info['equity'],
                'margin': account_info.get('margin', 0),
                'freeMargin': account_info.get('freeMargin', 0),
                'currency': account_info.get('currency', 'USD')
            }
        except Exception as e:
            print(f"❌ Error getting account info: {str(e)}")
            raise
    
    async def place_trade(
        self,
        account_login: str,
        symbol: str,
        volume: float,
        action_type: str,
        stop_loss: Optional[float] = None,
        take_profit: Optional[float] = None
    ) -> Dict:
        """Place a market order"""
        try:
            if account_login not in self.accounts:
                raise Exception("Account not connected")
            
            connection = self.accounts[account_login]['connection']
            
            print(f"\n📊 Executing {action_type.upper()} order:")
            print(f"   Symbol: {symbol}")
            print(f"   Volume: {volume} lots")
            print(f"   SL: {stop_loss if stop_loss else 'None'}")
            print(f"   TP: {take_profit if take_profit else 'None'}")
            
            # Place order
            if action_type.lower() == "buy":
                result = await connection.create_market_buy_order(
                    symbol, 
                    volume,
                    stop_loss,
                    take_profit
                )
            else:  # sell
                result = await connection.create_market_sell_order(
                    symbol,
                    volume,
                    stop_loss,
                    take_profit
                )
            
            print(f"✅ Order executed: ID {result.get('orderId')}")
            
            return result
            
        except Exception as e:
            print(f"❌ Error placing trade: {str(e)}")
            raise
    
    async def get_positions(self, account_login: str) -> List:
        """Get all open positions"""
        try:
            if account_login not in self.accounts:
                raise Exception("Account not connected")
            
            connection = self.accounts[account_login]['connection']
            positions = await connection.get_positions()
            
            return positions
            
        except Exception as e:
            print(f"❌ Error getting positions: {str(e)}")
            raise
    
    async def close_position(self, account_login: str, position_id: str) -> Dict:
        """Close a specific position"""
        try:
            if account_login not in self.accounts:
                raise Exception("Account not connected")
            
            connection = self.accounts[account_login]['connection']
            
            print(f"🔒 Closing position: {position_id}")
            result = await connection.close_position(position_id)
            print(f"✅ Position closed")
            
            return result
            
        except Exception as e:
            print(f"❌ Error closing position: {str(e)}")
            raise

print("🔌 MetaAPI client module loaded")