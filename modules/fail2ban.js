// Fail2ban Dashboard - view banned IPs, unban
const { exec } = require('child_process');

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve(err ? stderr || err.message : stdout);
    });
  });
}

function setupFail2banRoutes(app, requireAuth, auditLog) {
  // Check if fail2ban is available
  app.get('/api/fail2ban/available', requireAuth, async (req, res) => {
    const output = await runCmd('which fail2ban-client 2>/dev/null');
    res.json({ available: output.trim().length > 0 });
  });

  // List jails
  app.get('/api/fail2ban/jails', requireAuth, async (req, res) => {
    const output = await runCmd('fail2ban-client status 2>/dev/null');
    const jailMatch = output.match(/Jail list:\s*(.*)/);
    const jails = jailMatch ? jailMatch[1].trim().split(',').map(j => j.trim()).filter(Boolean) : [];
    res.json({ jails });
  });

  // Get jail status (banned IPs)
  app.get('/api/fail2ban/jail/:jail', requireAuth, async (req, res) => {
    const { jail } = req.params;
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeJail) return res.status(400).json({ error: 'Invalid jail name' });
    const output = await runCmd(`fail2ban-client status ${safeJail} 2>/dev/null`);

    const bannedMatch = output.match(/Banned IP list:\s*(.*)/);
    const bannedIps = bannedMatch ? bannedMatch[1].trim().split(/\s+/).filter(Boolean) : [];

    const totalMatch = output.match(/Currently banned:\s*(\d+)/);
    const totalBanned = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    const failedMatch = output.match(/Currently failed:\s*(\d+)/);
    const totalFailed = failedMatch ? parseInt(failedMatch[1], 10) : 0;

    res.json({ jail: safeJail, bannedIps, totalBanned, totalFailed });
  });

  // Unban IP
  app.post('/api/fail2ban/unban', requireAuth, async (req, res) => {
    const { ip, jail } = req.body;
    if (!ip || !jail) return res.status(400).json({ error: 'IP and jail required' });
    const safeIp = ip.replace(/[^0-9.]/g, '');
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeIp || !safeJail) return res.status(400).json({ error: 'Invalid IP or jail' });
    await runCmd(`fail2ban-client set ${safeJail} unbanip ${safeIp}`);
    if (auditLog) auditLog('fail2ban_unban', `Unbanned ${safeIp} from ${safeJail}`);
    res.json({ ok: true });
  });

  // Ban IP
  app.post('/api/fail2ban/ban', requireAuth, async (req, res) => {
    const { ip, jail } = req.body;
    if (!ip || !jail) return res.status(400).json({ error: 'IP and jail required' });
    const safeIp = ip.replace(/[^0-9.]/g, '');
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeIp || !safeJail) return res.status(400).json({ error: 'Invalid IP or jail' });
    await runCmd(`fail2ban-client set ${safeJail} banip ${safeIp}`);
    if (auditLog) auditLog('fail2ban_ban', `Banned ${safeIp} in ${safeJail}`);
    res.json({ ok: true });
  });
}

module.exports = { setupFail2banRoutes };
