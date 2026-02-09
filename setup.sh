#!/bin/bash
# CCChat Agent 快速安装脚本
# 使用方式: curl -sL <your-url>/setup.sh | bash

set -e

HUB_URL="wss://<HUB_URL>"
TOKEN="<TOKEN_PLACEHOLDER>"

echo "=== CCChat Agent 安装 ==="
echo ""

# 检查 Node.js
if ! command -v node &> /dev/null; then
  echo "错误: 未安装 Node.js (需要 >= 20)"
  echo "安装: https://nodejs.org/ 或 brew install node"
  exit 1
fi

# 检查 claude
if ! command -v claude &> /dev/null; then
  echo "错误: 未安装 Claude Code CLI"
  echo "安装: npm install -g @anthropic-ai/claude-code"
  exit 1
fi

# 检查 pnpm
if ! command -v pnpm &> /dev/null; then
  echo "安装 pnpm..."
  npm install -g pnpm
fi

# 克隆项目
INSTALL_DIR="$HOME/.ccchat-agent"
if [ -d "$INSTALL_DIR" ]; then
  echo "更新已有安装..."
  cd "$INSTALL_DIR" && git pull
else
  echo "克隆 CCChat..."
  git clone <YOUR_REPO_URL> "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
pnpm install
pnpm -r build

# 交互式配置
echo ""
read -p "你的 Agent 名称 (英文，如 xiaoming): " AGENT_NAME
read -p "你的职责描述 (如 负责后端开发): " ROLE_DESC
read -p "工作目录 (默认 $(pwd)): " WORK_DIR
WORK_DIR="${WORK_DIR:-$(pwd)}"

SYSTEM_PROMPT="你是 ${AGENT_NAME} 的 Claude Agent，${ROLE_DESC}。当别人问你是谁时，介绍你的角色和职责。总是用中文回复。"

# 写入配置
mkdir -p "$HOME/.ccchat"
cat > "$HOME/.ccchat/config.json" << EOF
{
  "hubUrl": "${HUB_URL}",
  "agentName": "${AGENT_NAME}",
  "token": "${TOKEN}",
  "workDir": "${WORK_DIR}",
  "systemPrompt": "${SYSTEM_PROMPT}",
  "maxConcurrentTasks": 1,
  "taskTimeout": 300000
}
EOF

echo ""
echo "=== 安装完成 ==="
echo ""
echo "配置文件: ~/.ccchat/config.json"
echo "Agent 名称: ${AGENT_NAME}"
echo ""
echo "启动命令:"
echo "  cd $INSTALL_DIR && npx tsx packages/daemon/src/index.ts start"
echo ""
echo "Telegram 群里操作:"
echo "  1. 私聊 @vergexchatbot 发送 /start"
echo "  2. 群里发送: /bind ${AGENT_NAME}"
echo "  3. 别人就可以 @${AGENT_NAME} 给你派任务了"
echo ""
