const { exec } = require('child_process');

function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

module.exports = async function diskCollector() {
  const result = { filesystems: [], topDirs: [] };

  try {
    const df = await runCmd('df -B1 --output=source,size,used,avail,pcent,target -x tmpfs -x devtmpfs -x efivarfs 2>/dev/null');
    const lines = df.trim().split('\n').slice(1);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        result.filesystems.push({
          device: parts[0],
          size: parseInt(parts[1], 10),
          used: parseInt(parts[2], 10),
          avail: parseInt(parts[3], 10),
          percent: parseInt(parts[4], 10),
          mount: parts.slice(5).join(' '),
        });
      }
    }
  } catch (err) {
    // ignore
  }

  try {
    const du = await runCmd('du -sh /home/* /opt /var/cache /var/log /tmp 2>/dev/null | sort -rh | head -10');
    for (const line of du.trim().split('\n')) {
      const match = line.match(/^([0-9.]+[KMGTP]?)\s+(.+)$/);
      if (match) result.topDirs.push({ size: match[1], path: match[2] });
    }
  } catch (err) {
    // ignore
  }

  return result;
};
