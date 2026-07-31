#!/bin/bash
# StockSim Pro — 一键启动脚本 (Git Bash / Linux / macOS)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "═══════════════════════════════════════"
echo "  StockSim Pro — 一键启动脚本"
echo "  专业炒股模拟交易平台"
echo "═══════════════════════════════════════"
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "[错误] 未找到 Node.js，请先安装: https://nodejs.org/"
    exit 1
fi
echo "[OK] Node.js: $(node --version)"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo "[错误] 未找到 npm"
    exit 1
fi
echo "[OK] npm: $(npm --version)"
echo ""

# 创建数据目录
mkdir -p backend/data

# 安装后端依赖
echo "[1/4] 安装后端依赖..."
(cd backend && npm install --loglevel=error)
echo "[OK] 后端依赖已安装"

# 安装前端依赖
echo "[2/4] 安装前端依赖..."
(cd frontend && npm install --loglevel=error)
echo "[OK] 前端依赖已安装"

# 启动后端
echo "[3/4] 启动后端服务 (端口 8000)..."
(cd backend && npx nest start --watch &)
BACKEND_PID=$!
echo "[OK] 后端已启动 (PID: $BACKEND_PID)"

# 等待后端初始化
sleep 3

# 启动前端
echo "[4/4] 启动前端开发服务器 (端口 3000)..."
(cd frontend && npx vite --host &)
FRONTEND_PID=$!
echo "[OK] 前端已启动 (PID: $FRONTEND_PID)"

echo ""
echo "═══════════════════════════════════════"
echo "  启动完成！"
echo ""
echo "  后端: http://localhost:8000/api"
echo "  前端: http://localhost:3000"
echo "  行情WS: ws://localhost:8000/market"
echo "═══════════════════════════════════════"
echo ""
echo "按 Ctrl+C 停止所有服务"

# 捕捉退出信号
trap "echo '正在停止服务...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" SIGINT SIGTERM

# 等待子进程
wait
