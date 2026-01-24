#!/bin/bash
# ============================================
# FILENAME: start.sh
# ============================================

echo "🚀 Starting KanAIRY Trading Platform"
echo "===================================="

# Check Python version
python_version=$(python3 --version 2>&1 | cut -d' ' -f2)
echo "🐍 Python version: $python_version"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "📦 Installing dependencies..."
pip install -r backend/requirements.txt

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️ Warning: .env file not found!"
    echo "Creating default .env file..."
    
    cat > .env << EOL
# Appwrite Configuration
APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
APPWRITE_PROJECT_ID=your_project_id_here
APPWRITE_API_KEY=your_api_key_here

# Appwrite Database IDs
APPWRITE_DATABASE_ID=kanairy_db
APPWRITE_USERS_COLLECTION_ID=users
APPWRITE_POSITIONS_COLLECTION_ID=positions
APPWRITE_ORDERS_COLLECTION_ID=orders
APPWRITE_NEWS_COLLECTION_ID=news

# MetaAPI Trading
METAAPI_TOKEN=your_metaapi_token_here

# Security
ENCRYPTION_KEY=kanairy-secret-key-32-characters-long-change-this!

# Server
PORT=8000
DEBUG=True
EOL
    
    echo "✅ Created .env file. Please update with your actual credentials!"
fi

# Start the server
echo "🚀 Starting FastAPI server..."
echo ""
echo "📊 Endpoints:"
echo "   Web Interface: http://localhost:8000"
echo "   API Docs: http://localhost:8000/api/docs"
echo "   API Health: http://localhost:8000/api/health"
echo ""
echo "👨‍💻 Created by: Thakgalo Matlala"
echo ""

uvicorn backend.main:app --host 0.0.0.0 --port 8000 --reload