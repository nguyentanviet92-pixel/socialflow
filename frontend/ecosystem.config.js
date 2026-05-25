// PM2 ecosystem config for SocialFlow Frontend
// Start/Restart: pm2 start ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'socialflow-frontend',
      script: 'npm',
      args: 'run preview',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
