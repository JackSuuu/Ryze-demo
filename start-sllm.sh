#!/bin/bash

# Ryze AI + ServerlessLLM Startup Script

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║   Ryze AI + ServerlessLLM                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check for required environment variables
if [ -z "$HF_TOKEN" ]; then
    echo -e "${YELLOW}Warning: HF_TOKEN not set. Some models may require authentication.${NC}"
    echo "Set it with: export HF_TOKEN='your_huggingface_token'"
fi

# Create models directory
export MODEL_FOLDER="${MODEL_FOLDER:-$HOME/.cache/serverlessllm/models}"
mkdir -p "$MODEL_FOLDER"
echo -e "${GREEN}Model folder: $MODEL_FOLDER${NC}"

# Start services
echo -e "${BLUE}Starting ServerlessLLM + Ryze services...${NC}"
docker compose -f docker-compose.sllm.yml up -d

echo ""
echo -e "${GREEN}Services starting...${NC}"
echo ""
echo "Wait for services to be ready, then:"
echo ""
echo "1. Deploy the model:"
echo "   pip install serverless-llm"
echo "   export LLM_SERVER_URL=http://localhost:8343"
echo "   sllm deploy --model chivier/qwen3-vl-8b-grpo"
echo ""
echo "2. Access the chatbot:"
echo "   Frontend: http://localhost:3000"
echo "   Backend:  http://localhost:8000"
echo "   ServerlessLLM: http://localhost:8343"
echo ""
echo "To view logs:"
echo "   docker logs -f sllm_head"
echo "   docker logs -f ryze_backend"
echo ""
echo "To stop:"
echo "   docker compose -f docker-compose.sllm.yml down"
