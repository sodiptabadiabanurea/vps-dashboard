const { exec } = require('child_process');

function runCmd(cmd, timeout = 10000) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

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

  try {
    const sshConns = await runCmd('who 2>/dev/null | wc -l');
    extra.ssh_connections = parseInt(sshConns.trim(), 10) || 0;

    const lastLogins = await runCmd('last -n 1 -a 2>/dev/null | head -1');
    extra.last_login = lastLogins.trim() || 'N/A';

    const failed = await runCmd('journalctl -u sshd --since today 2>/dev/null | grep -c "Failed password" || echo 0');
    extra.failed_logins = parseInt(failed.trim(), 10) || 0;

    extra.kernel = (await runCmd('uname -r')).trim();

    const updates = await runCmd('apt list --upgradable 2>/dev/null | grep -c security || echo 0');
    extra.security_updates = parseInt(updates.trim(), 10) || 0;

    try {
      const aptUpdate = await runCmd('stat -c %y /var/lib/apt/periodic/update-success-stamp 2>/dev/null');
      extra.last_apt_update = aptUpdate.trim().split('.')[0] || 'N/A';
    } catch (err) {
      extra.last_apt_update = 'N/A';
    }

    const uptime = await runCmd('cat /proc/uptime');
    const uptimeSec = parseFloat(uptime.split(' ')[0]);
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const minutes = Math.floor((uptimeSec % 3600) / 60);
    extra.uptime = `${hours} hours, ${minutes} minutes (${days} days)`;

    const loadavg = await runCmd('cat /proc/loadavg');
    extra.load = parseFloat(loadavg.split(' ')[0]) || 0;

  } catch (err) {
    // ignore
  }

  const services = {};
  for (const svc of results) {
    services[svc.name] = svc;
  }

  return { ...services, _extra: extra };
};
