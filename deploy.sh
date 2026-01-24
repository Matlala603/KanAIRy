#!/bin/bash
# ============================================
# FILENAME: deploy.sh
# ============================================

echo "🚀 Deploying KanAIRY Trading Platform"
echo "====================================="

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please create a .env file with the following variables:"
    echo "APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1"
    echo "APPWRITE_PROJECT_ID=your_project_id"
    echo "APPWRITE_API_KEY=your_api_key"
    echo "METAAPI_TOKEN=your_metaapi_token"
    echo "ENCRYPTION_KEY=your_encryption_key"
    exit 1
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Error: Docker is not running!"
    exit 1
fi

echo "✅ Docker is running"

# Build the Docker image
echo "📦 Building Docker image..."
docker build -t kanairy-trading .

# Run the container
echo "🚀 Starting KanAIRY container..."
docker-compose up -d

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📊 Application Status:"
echo "   Web Interface: http://localhost:8000"
echo "   API Docs: http://localhost:8000/api/docs"
echo "   API Health: http://localhost:8000/api/health"
echo ""
echo "🔧 Management Commands:"
echo "   View logs: docker-compose logs -f"
echo "   Stop: docker-compose down"
echo "   Restart: docker-compose restart"
echo ""
echo "👨‍💻 Created by: Thakgalo Matlala"