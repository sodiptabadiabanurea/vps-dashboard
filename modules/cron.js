// Cron Job Manager - view, add, edit, delete cron jobs
const { exec } = require('child_process');
const fs = require('fs');

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
      resolve(err ? stderr || err.message : stdout);
    });
  });
}

function setupCronRoutes(app, requireAuth, auditLog) {
  // List cron jobs
  app.get('/api/cron', requireAuth, async (req, res) => {
    try {
      // System crontab
      const systemCron = await runCmd('cat /etc/crontab 2>/dev/null || echo ""');
      // User crontab
      const userCron = await runCmd('crontab -l 2>/dev/null || echo "no crontab"');
      // Cron.d
      const cronD = await runCmd('ls /etc/cron.d/ 2>/dev/null || echo ""');
      const cronDFiles = cronD.trim() ? cronD.trim().split('\n') : [];
      const cronDContent = [];
      for (const f of cronDFiles) {
        const content = await runCmd(`cat /etc/cron.d/${f} 2>/dev/null`);
        cronDContent.push({ file: f, content: content.trim() });
      }

      res.json({
        system: systemCron.trim(),
        user: userCron.trim(),
        cronD: cronDContent,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Set user crontab
  app.post('/api/cron/user', requireAuth, async (req, res) => {
    try {
      const { content } = req.body;
      if (!content) return res.status(400).json({ error: 'Content required' });

      // Write to temp file and install
      const tmpFile = '/tmp/vps-dashboard-crontab';
      fs.writeFileSync(tmpFile, content + '\n');
      const result = await runCmd(`crontab ${tmpFile}`);
      fs.unlinkSync(tmpFile);

      if (auditLog) auditLog('cron_update', 'Updated user crontab');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add cron job
  app.post('/api/cron/add', requireAuth, async (req, res) => {
    try {
      const { schedule, command } = req.body;
      if (!schedule || !command) return res.status(400).json({ error: 'Schedule and command required' });

      const current = await runCmd('crontab -l 2>/dev/null || echo ""');
      const newCron = current.trim() + '\n' + schedule + ' ' + command + '\n';

      const tmpFile = '/tmp/vps-dashboard-crontab';
      fs.writeFileSync(tmpFile, newCron);
      await runCmd(`crontab ${tmpFile}`);
      fs.unlinkSync(tmpFile);

      if (auditLog) auditLog('cron_add', `Added: ${schedule} ${command}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete cron job (by line number)
  app.post('/api/cron/delete', requireAuth, async (req, res) => {
    try {
      const { lineNumber } = req.body;
      if (lineNumber === undefined) return res.status(400).json({ error: 'Line number required' });

      const current = await runCmd('crontab -l 2>/dev/null || echo ""');
      const lines = current.split('\n');
      if (lineNumber < 0 || lineNumber >= lines.length) return res.status(400).json({ error: 'Invalid line number' });

      lines.splice(lineNumber, 1);
      const tmpFile = '/tmp/vps-dashboard-crontab';
      fs.writeFileSync(tmpFile, lines.join('\n'));
      await runCmd(`crontab ${tmpFile}`);
      fs.unlinkSync(tmpFile);

      if (auditLog) auditLog('cron_delete', `Deleted line ${lineNumber}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { setupCronRoutes };
