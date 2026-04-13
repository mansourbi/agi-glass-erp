#!/bin/bash
# setup-monitoring.sh — Run ONCE in WSL to set up health monitoring
# Usage: bash ~/agi-server/setup-monitoring.sh

set -e
echo ""
echo "=== AGI Glass — Monitoring Setup ==="
echo ""

# 1. Make healthcheck script executable
chmod +x ~/agi-server/healthcheck.sh
echo "[1] healthcheck.sh made executable"

# 2. Create logs directory
mkdir -p ~/agi-server/logs
echo "[2] Logs directory ready"

# 3. Install cron job — runs every 2 minutes
# Remove any existing AGI healthcheck cron entries first
(crontab -l 2>/dev/null | grep -v "agi-server/healthcheck") | crontab -
# Add new entry
(crontab -l 2>/dev/null; echo "*/2 * * * * /home/$(whoami)/agi-server/healthcheck.sh") | crontab -
echo "[3] Cron job installed — runs every 2 minutes"

# 4. Verify cron is running
if ! service cron status > /dev/null 2>&1; then
  sudo service cron start
  echo "[4] Cron service started"
else
  echo "[4] Cron service already running"
fi

# 5. Make cron auto-start (add to /etc/wsl.conf if not already there)
if ! grep -q "cron" /etc/wsl.conf 2>/dev/null; then
  echo "" | sudo tee -a /etc/wsl.conf > /dev/null
  echo "[boot]" | sudo tee -a /etc/wsl.conf > /dev/null
  echo "command = service cron start" | sudo tee -a /etc/wsl.conf > /dev/null
  echo "[5] Cron auto-start added to /etc/wsl.conf"
else
  echo "[5] Cron already in /etc/wsl.conf"
fi

echo ""
echo "=== Done! ==="
echo ""
echo "Crontab:"
crontab -l
echo ""
echo "Now copy morning-check.ps1 to C:\\ProgramData\\AGIGlass\\ on Windows"
echo "Then run this in PowerShell as Administrator to register the 8am task:"
echo ""
echo '  schtasks /create /tn "AGI Glass Morning Check" /tr "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \"C:\ProgramData\AGIGlass\morning-check.ps1\"" /sc daily /st 08:00 /ru SYSTEM /rl HIGHEST /f'
echo ""
