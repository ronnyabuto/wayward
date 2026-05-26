module.exports = {
  apps: [{
    name: 'wayward',
    script: 'src/bot.js',
    interpreter: 'node',
    // IPv4-only flag required — machine has no working IPv6 route.
    interpreter_args: '--dns-result-order=ipv4first',
    restart_delay: 3000,
    max_restarts: 10,
    exp_backoff_restart_delay: 100,
    env: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
    },
    log_file:   '/var/log/wayward/combined.log',
    error_file: '/var/log/wayward/error.log',
    merge_logs: true,
  }],
};
