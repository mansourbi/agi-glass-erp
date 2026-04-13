#!/bin/bash
# setup-pm2.sh — Run ONCE in WSL Ubuntu to migrate from bare node to PM2
# Usage: bash setup-pm2.sh
# Run from: ~/agi-server/

set -e
cd ~/agi-server

echo ""
echo "=== AGI Glass — PM2 Setup ==="
echo ""

# 1. Stop bare node if running
echo "[1] Stopping any running node server..."
pkill -f 'node server.js' 2>/dev/null && echo "    Stopped." || echo "    Nothing was running."
sleep 2

# 2. Install PM2 globally
echo "[2] Installing PM2..."
npm install -g pm2
echo "    PM2 version: $(pm2 --version)"

# 3. Create logs folder
echo "[3] Creating logs folder..."
mkdir -p ~/agi-server/logs

# 4. Copy ecosystem config (you should have placed it in ~/agi-server/ already)
if [ ! -f ~/agi-server/ecosystem.config.js ]; then
  echo "    ERROR: ecosystem.config.js not found in ~/agi-server/"
  echo "    Copy it there first, then re-run this script."
  exit 1
fi

# 5. Check username in ecosystem config matches actual user
ACTUAL_USER=$(whoami)
echo "[4] Checking username in ecosystem.config.js..."
if grep -q "/home/dell/" ~/agi-server/ecosystem.config.js; then
  if [ "$ACTUAL_USER" != "dell" ]; then
    echo "    Fixing username: dell → $ACTUAL_USER"
    sed -i "s|/home/dell/|/home/$ACTUAL_USER/|g" ~/agi-server/ecosystem.config.js
  else
    echo "    Username 'dell' matches — OK"
  fi
fi

# 6. Start server via PM2
echo "[5] Starting AGI Glass via PM2..."
pm2 start ecosystem.config.js

# 7. Save process list (enables pm2 resurrect on boot)
echo "[6] Saving PM2 process list..."
pm2 save

# 8. Set up PM2 startup hook for WSL
echo "[7] Setting up PM2 startup (for WSL sessions)..."
pm2 startup || true   # may not work fully in WSL — Windows Task Scheduler handles boot

echo ""
echo "=== Done! ==="
echo ""
pm2 list
echo ""
echo "Useful commands:"
echo "  pm2 list              — show all processes"
echo "  pm2 logs agi-glass    — live logs"
echo "  pm2 restart agi-glass — restart server"
echo "  pm2 stop agi-glass    — stop server"
echo "  pm2 monit             — real-time dashboard"
echo ""
echo "Now replace start-wsl.ps1 on Windows with the new PM2 version."
echo ""
