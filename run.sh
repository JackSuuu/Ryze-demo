#!/bin/bash

# BioVLM Chatbot - Quick Start Script

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${PURPLE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                                                              ║"
echo "║   🚀 BioVLM Chatbot                                         ║"
echo "║   Powered by ServerlessLLM + BioVLM-8B-GRPO                ║"
echo "║                                                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check command
command=$1

show_help() {
    echo -e "${CYAN}Usage:${NC}"
    echo "  ./run.sh [command]"
    echo ""
    echo -e "${CYAN}Commands:${NC}"
    echo "  backend     Start backend server"
    echo "  frontend    Start frontend server"
    echo "  all         Start both servers"
    echo "  docker      Start with Docker Compose"
    echo "  install     Install dependencies"
    echo "  help        Show this help message"
    echo ""
}

install_deps() {
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    cd backend
    pip3 install -r requirements.txt
    cd ..
    echo -e "${GREEN}✅ Dependencies installed!${NC}"
}

start_backend() {
    echo -e "${BLUE}🔧 Starting backend server...${NC}"
    cd backend
    python3 app.py &
    BACKEND_PID=$!
    cd ..
    echo -e "${GREEN}✅ Backend running at http://localhost:8000${NC}"
}

start_frontend() {
    echo -e "${BLUE}🎨 Starting frontend server...${NC}"
    cd frontend
    python3 -m http.server 3000 &
    FRONTEND_PID=$!
    cd ..
    echo -e "${GREEN}✅ Frontend running at http://localhost:3000${NC}"
}

start_docker() {
    echo -e "${BLUE}🐳 Starting with Docker Compose...${NC}"
    docker-compose up -d
    echo -e "${GREEN}✅ Services started!${NC}"
    echo -e "   Frontend: http://localhost:3000"
    echo -e "   Backend:  http://localhost:8000"
}

case $command in
    "backend")
        start_backend
        wait
        ;;
    "frontend")
        start_frontend
        wait
        ;;
    "all")
        start_backend
        start_frontend
        echo ""
        echo -e "${GREEN}🎉 All services started!${NC}"
        echo -e "   Frontend: ${CYAN}http://localhost:3000${NC}"
        echo -e "   Backend:  ${CYAN}http://localhost:8000${NC}"
        echo ""
        echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
        wait
        ;;
    "docker")
        start_docker
        ;;
    "install")
        install_deps
        ;;
    "help"|"--help"|"-h")
        show_help
        ;;
    *)
        show_help
        ;;
esac
