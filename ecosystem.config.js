module.exports = {
  apps: [{
    name        : 'agi-glass',
    script      : 'server.js',
    cwd         : 'C:\\agi-server',
    instances   : 1,
    autorestart : true,
    watch       : false,
    max_restarts: 10,
    min_uptime  : '10s',
    restart_delay: 2000,
    env: {
      NODE_ENV  : 'production',
      PORT      : '3000',
      HTTPS_PORT: '3444'
    },
    error_file  : 'C:\\agi-server\\logs\\pm2-error.log',
    out_file    : 'C:\\agi-server\\logs\\pm2-out.log',
    merge_logs  : true,
    time        : true
  }]
};
