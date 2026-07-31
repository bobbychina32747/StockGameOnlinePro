#!/bin/bash
# StockSim Pro - one-click launcher (Git Bash / Linux / macOS)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================================"
echo "  StockSim Pro - Stock Trading Simulator"
echo "================================================"
echo ""

# ---- 1. Environment check ----
echo "[1/5] Environment check"
if ! command -v node &> /dev/null; then
    echo "  [FAIL] Node.js not found. Install from https://nodejs.org/ (v18+)"
    exit 1
fi
echo "  [OK] Node.js: $(node --version)"
if ! command -v npm &> /dev/null; then
    echo "  [FAIL] npm not found"
    exit 1
fi
echo "  [OK] npm: $(npm --version)"
echo ""

# ---- 2. Dependency check (auto install) ----
echo "[2/5] Dependency check"
mkdir -p backend/data
if [ ! -d backend/node_modules ]; then
    echo "  [WARN] Backend deps missing, installing..."
    (cd backend && npm install --no-fund --no-audit)
    echo "  [OK] Backend deps installed"
else
    echo "  [OK] Backend deps ready"
fi
if [ ! -d frontend/node_modules ]; then
    echo "  [WARN] Frontend deps missing, installing..."
    (cd frontend && npm install --no-fund --no-audit)
    echo "  [OK] Frontend deps installed"
else
    echo "  [OK] Frontend deps ready"
fi
echo ""

# ---- 3. Build check (rebuild if source changed) ----
echo "[3/5] Build check"
NEED_BUILD="$(node scripts/check-build.js)"
if echo "$NEED_BUILD" | grep -q "backend"; then
    echo "  [WARN] Backend source changed, rebuilding..."
    (cd backend && npm run build)
    echo "  [OK] Backend build done"
else
    echo "  [OK] Backend build up-to-date"
fi
if echo "$NEED_BUILD" | grep -q "frontend"; then
    echo "  [WARN] Frontend source changed, rebuilding..."
    (cd frontend && npm run build)
    echo "  [OK] Frontend build done"
else
    echo "  [OK] Frontend build up-to-date"
fi
echo ""

# ---- 4. Start backend + health check ----
echo "[4/5] Start backend  http://localhost:8000/api"
(cd backend && exec node dist/src/main.js) &
BACKEND_PID=$!
BACKEND_OK=""
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://localhost:8000/api/market/prices 2>/dev/null; then
        BACKEND_OK=1
        break
    fi
    sleep 1
done
if [ -n "$BACKEND_OK" ]; then
    echo "  [OK] Backend ready (PID $BACKEND_PID)"
else
    echo "  [FAIL] Backend startup timeout"
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi
echo ""

# ---- 5. Start frontend + health check ----
echo "[5/5] Start frontend  http://localhost:3000"
(cd frontend && exec npx vite --host) &
FRONTEND_PID=$!
FRONTEND_OK=""
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://localhost:3000 2>/dev/null; then
        FRONTEND_OK=1
        break
    fi
    sleep 1
done
if [ -n "$FRONTEND_OK" ]; then
    echo "  [OK] Frontend ready (PID $FRONTEND_PID)"
else
    echo "  [FAIL] Frontend startup timeout"
    kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
    exit 1
fi
echo ""

# ---- Done ----
echo "================================================"
echo "  All services ready!"
echo ""
echo "  Frontend:  http://localhost:3000"
echo "  API:       http://localhost:8000/api"
echo "  WebSocket: ws://localhost:8000/market"
echo "================================================"
echo ""
echo "Press Ctrl+C to stop all services"

trap "echo 'Stopping services...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM
wait
