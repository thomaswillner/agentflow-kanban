#!/bin/bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# AgentFlow — Safe Local Setup Script
# This script NEVER uses sudo, NEVER modifies system files,
# and NEVER installs anything globally.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'
BOLD='\033[1m'

echo ""
echo -e "${BLUE}${BOLD}  ╔══════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}${BOLD}  ║  🚀 AgentFlow — Safe Local Setup            ║${NC}"
echo -e "${BLUE}${BOLD}  ╚══════════════════════════════════════════════╝${NC}"
echo ""

# ── Safety Pre-flight Checks ──────────────────────────

echo -e "${BOLD}Pre-flight Safety Checks:${NC}"
echo ""

# Check we're not running as root
if [ "$(id -u)" -eq 0 ]; then
  echo -e "  ${RED}✗ Running as root — this script should NOT be run with sudo${NC}"
  echo "    Please run as your normal user: ./setup.sh"
  exit 1
fi
echo -e "  ${GREEN}✓ Not running as root (safe)${NC}"

# Check we're in the right directory
if [ ! -f "server.js" ] || [ ! -f "kanban.html" ] || [ ! -f "package.json" ]; then
  echo -e "  ${RED}✗ Missing files — run this script from the AgentFlow directory${NC}"
  echo "    Expected: server.js, kanban.html, package.json"
  exit 1
fi
echo -e "  ${GREEN}✓ AgentFlow files found${NC}"

# Check port 3000 is available
if lsof -i :3000 -sTCP:LISTEN > /dev/null 2>&1; then
  echo -e "  ${YELLOW}⚠ Port 3000 is already in use${NC}"
  echo "    You can use a different port: PORT=3001 npm start"
  SUGGESTED_PORT=3001
  while lsof -i :$SUGGESTED_PORT -sTCP:LISTEN > /dev/null 2>&1; do
    SUGGESTED_PORT=$((SUGGESTED_PORT + 1))
  done
  echo -e "    Suggested free port: ${BOLD}$SUGGESTED_PORT${NC}"
else
  echo -e "  ${GREEN}✓ Port 3000 is available${NC}"
  SUGGESTED_PORT=3000
fi

# Check disk space (need at least 100MB)
AVAILABLE_MB=$(df -m . | awk 'NR==2 {print $4}')
if [ "$AVAILABLE_MB" -lt 100 ] 2>/dev/null; then
  echo -e "  ${RED}✗ Less than 100MB disk space available${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓ Disk space OK (${AVAILABLE_MB}MB available)${NC}"

echo ""

# ── Detect Available Runtimes ─────────────────────────

HAS_NODE=false
HAS_DOCKER=false
NODE_VERSION=""

if command -v node &> /dev/null; then
  NODE_VERSION=$(node -v 2>/dev/null)
  NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    HAS_NODE=true
    echo -e "  ${GREEN}✓ Node.js $NODE_VERSION found (>= 18 required)${NC}"
  else
    echo -e "  ${YELLOW}⚠ Node.js $NODE_VERSION found but >= 18 required${NC}"
  fi
else
  echo -e "  ${YELLOW}○ Node.js not found${NC}"
fi

if command -v docker &> /dev/null; then
  if docker info > /dev/null 2>&1; then
    HAS_DOCKER=true
    echo -e "  ${GREEN}✓ Docker found and running${NC}"
  else
    echo -e "  ${YELLOW}○ Docker found but not running${NC}"
  fi
else
  echo -e "  ${YELLOW}○ Docker not found${NC}"
fi

echo ""

# ── Choose Deployment Method ──────────────────────────

if [ "$HAS_NODE" = true ] && [ "$HAS_DOCKER" = true ]; then
  echo -e "${BOLD}Both Node.js and Docker available. Choose:${NC}"
  echo "  1) Node.js (fastest, uses your local Node)"
  echo "  2) Docker  (most isolated, runs in a container)"
  echo ""
  read -p "  Choice [1/2, default=1]: " CHOICE
  CHOICE=${CHOICE:-1}
elif [ "$HAS_NODE" = true ]; then
  CHOICE=1
elif [ "$HAS_DOCKER" = true ]; then
  CHOICE=2
else
  echo -e "${RED}Neither Node.js >= 18 nor Docker found.${NC}"
  echo ""
  echo "To install Node.js (recommended):"
  echo "  Option A: brew install node     (if you have Homebrew)"
  echo "  Option B: Download from https://nodejs.org"
  echo "  Option C: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
  echo "            then: nvm install 22"
  echo ""
  echo "To install Docker:"
  echo "  Download Docker Desktop from https://docker.com/products/docker-desktop"
  echo ""
  exit 1
fi

# ── Deploy with Node.js ──────────────────────────────

if [ "$CHOICE" = "1" ]; then
  echo -e "${BOLD}Setting up with Node.js...${NC}"
  echo ""

  # Install dependencies (local only, no global)
  echo -e "  Installing dependencies (local node_modules only)..."
  npm install --no-fund --no-audit 2>&1 | tail -3
  echo ""

  # Create data directory
  mkdir -p data
  echo -e "  ${GREEN}✓ Data directory created (./data/)${NC}"
  echo -e "  ${GREEN}✓ Database will be at ./data/agentflow.db${NC}"
  echo ""

  # Create a simple start script
  cat > start.sh << 'STARTEOF'
#!/bin/bash
cd "$(dirname "$0")"
PORT=${PORT:-3000}
echo ""
echo "  Starting AgentFlow on port $PORT..."
echo "  Press Ctrl+C to stop"
echo ""
node server.js
STARTEOF
  chmod +x start.sh

  # Create a stop script
  cat > stop.sh << 'STOPEOF'
#!/bin/bash
echo "Stopping AgentFlow..."
pkill -f "node server.js" 2>/dev/null && echo "  Stopped." || echo "  Not running."
STOPEOF
  chmod +x stop.sh

  echo -e "${GREEN}${BOLD}  Setup complete!${NC}"
  echo ""
  echo -e "  ${BOLD}To start:${NC}  ./start.sh"
  echo -e "  ${BOLD}To stop:${NC}   ./stop.sh  (or Ctrl+C)"
  echo -e "  ${BOLD}Open:${NC}      http://localhost:${SUGGESTED_PORT}"
  echo ""
  echo -e "  ${BOLD}Your data:${NC} ./data/agentflow.db (SQLite)"
  echo -e "  ${BOLD}To backup:${NC} cp data/agentflow.db data/agentflow-backup.db"
  echo ""

  # Ask if they want to start now
  read -p "  Start AgentFlow now? [Y/n]: " START_NOW
  START_NOW=${START_NOW:-Y}
  if [[ "$START_NOW" =~ ^[Yy] ]]; then
    PORT=$SUGGESTED_PORT node server.js
  fi
fi

# ── Deploy with Docker ───────────────────────────────

if [ "$CHOICE" = "2" ]; then
  echo -e "${BOLD}Setting up with Docker...${NC}"
  echo ""

  # Build the image
  echo "  Building Docker image..."
  docker build -t agentflow . 2>&1 | tail -5
  echo ""

  # Create data directory on host for persistence
  mkdir -p data
  echo -e "  ${GREEN}✓ Data directory created (./data/)${NC}"
  echo ""

  echo -e "${GREEN}${BOLD}  Setup complete!${NC}"
  echo ""
  echo -e "  ${BOLD}To start:${NC}  docker run -d --name agentflow -p ${SUGGESTED_PORT}:3000 -v \$(pwd)/data:/app/data agentflow"
  echo -e "  ${BOLD}To stop:${NC}   docker stop agentflow && docker rm agentflow"
  echo -e "  ${BOLD}Open:${NC}      http://localhost:${SUGGESTED_PORT}"
  echo ""
  echo -e "  ${BOLD}Your data:${NC} ./data/agentflow.db (persisted on host)"
  echo ""

  # Ask if they want to start now
  read -p "  Start AgentFlow now? [Y/n]: " START_NOW
  START_NOW=${START_NOW:-Y}
  if [[ "$START_NOW" =~ ^[Yy] ]]; then
    docker run -d --name agentflow -p $SUGGESTED_PORT:3000 -v "$(pwd)/data:/app/data" agentflow
    echo ""
    echo -e "  ${GREEN}✓ AgentFlow running at http://localhost:${SUGGESTED_PORT}${NC}"
    echo "  View logs: docker logs -f agentflow"
  fi
fi
