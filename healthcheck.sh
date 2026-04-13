#!/bin/bash
# /home/dell/agi-server/healthcheck.sh
# Runs every minute via cron — restarts server if it stops responding

LOG="/home/dell/agi-server/logs/healthcheck.log"
MAX_LOG_LINES=500

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

# Check if server responds
if curl -sf --max-time 5 http://localhost:3000/api/health > /dev/null 2>&1; then
  exit 0  # Server is up — silent exit
fi

log "Server not responding — attempting recovery..."

# Kill any stale node processes holding ports
pkill -f "node server.js" 2>/dev/null
sleep 2

# Try resurrect first (uses saved process list)
if pm2 resurrect > /dev/null 2>&1; then
  log "PM2 resurrected from dump"
else
  log "Starting fresh via ecosystem.config.js..."
  cd /home/dell/agi-server && pm2 start ecosystem.config.js >> "$LOG" 2>&1
  pm2 save >> "$LOG" 2>&1
fi

# Wait for startup
sleep 8

# Verify recovery
if curl -sf --max-time 5 http://localhost:3000/api/health > /dev/null 2>&1; then
  log "✓ Server recovered successfully"
else
  # Last resort — kill everything and start fresh
  log "Still down — last resort restart..."
  pkill -f node 2>/dev/null
  sleep 2
  cd /home/dell/agi-server && pm2 start ecosystem.config.js >> "$LOG" 2>&1
  pm2 save >> "$LOG" 2>&1
  sleep 8
  if curl -sf --max-time 5 http://localhost:3000/api/health > /dev/null 2>&1; then
    log "✓ Server recovered after last resort restart"
  else
    log "✗ Server still not responding — manual intervention needed"
  fi
fi

# Trim log file
if [ -f "$LOG" ]; then
  tail -n $MAX_LOG_LINES "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi
