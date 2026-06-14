const { exec } = require('child_process');

function checkService(name) {
  return new Promise((resolve) => {
    exec(`systemctl is-active ${name} 2>/dev/null`, (err, stdout) => {
      resolve({
        name,
        active: stdout.trim() === 'active',
        status: stdout.trim() || 'unknown',
      });
    });
  });
}

module.exports = async function servicesCollector(serviceNames) {
  const results = await Promise.all(serviceNames.map(checkService));

  // Get additional info
  const extra = {};

  // SSH connections
  try {
    const { execSync } = require('child_process');
    const sshConns = execSync('who 2>/dev/null | wc -l', { encoding: 'utf8' });
    extra.ssh_connections = parseInt(sshConns.trim(), 10) || 0;

    // Last login
    const lastLogins = execSync('last -n 1 -a 2>/dev/null | head -1', { encoding: 'utf8' });
    extra.last_login = lastLogins.trim() || 'N/A';

    // Failed login attempts today
    const failed = execSync('journalctl -u sshd --since today 2>/dev/null | grep -c "Failed password" || echo 0', { encoding: 'utf8' });
    extra.failed_logins = parseInt(failed.trim(), 10) || 0;

    // Kernel
    extra.kernel = execSync('uname -r', { encoding: 'utf8' }).trim();

    // Security updates
    const updates = execSync('apt list --upgradable 2>/dev/null | grep -c security || echo 0', { encoding: 'utf8' });
    extra.security_updates = parseInt(updates.trim(), 10) || 0;

    // Last apt update
    try {
      const aptUpdate = execSync('stat -c %y /var/lib/apt/periodic/update-success-stamp 2>/dev/null', { encoding: 'utf8' });
      extra.last_apt_update = aptUpdate.trim().split('.')[0];
    } catch (err) {
      extra.last_apt_update = 'N/A';
    }

    // System uptime
    const uptime = execSync('cat /proc/uptime', { encoding: 'utf8' });
    const uptimeSec = parseFloat(uptime.split(' ')[0]);
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    extra.uptime = `${hours} hours, ${minutes} minutes (${days} days)`;

    // Load average
    const loadavg = execSync('cat /proc/loadavg', { encoding: 'utf8' });
    extra.load = parseFloat(loadavg.split(' ')[0]);

  } catch (err) {
    // ignore
  }

  const services = {};
  for (const svc of results) {
    services[svc.name] = svc;
  }

  return { ...services, _extra: extra };
};
