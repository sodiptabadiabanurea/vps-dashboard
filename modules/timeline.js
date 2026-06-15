// Incident Timeline — unified event feed
const config = require('../config');

let stmts = null;
let io = null;

function initTimeline(dbStmts, socketIo) {
  stmts = dbStmts;
  io = socketIo;
}

const ICONS = {
  alert: '⚠️',
  deploy: '🚀',
  uptime: '🌐',
  system: '⚙️',
  service: '🔧',
  security: '🔒',
};

function record(type, category, title, detail, source, metadata) {
  if (!stmts) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    stmts.insertTimelineEvent.run(now, type, category, title, detail, source, JSON.stringify(metadata || {}));
    if (io) {
      io.emit('timeline-event', { ts: now, type, category, title, detail, source, metadata, icon: ICONS[category] || '📌' });
    }
  } catch (e) {
    // Timeline is best-effort; don't crash on recording failures
  }
}

// --- API routes ---
function setupTimelineRoutes(app, requireAuth) {
  app.get('/api/timeline', requireAuth, (req, res) => {
    const range = req.query.range || '24h';
    const category = req.query.category || 'all';
    const limit = parseInt(req.query.limit, 10) || 100;
    const now = Math.floor(Date.now() / 1000);
    const ranges = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 };
    const since = now - (ranges[range] || 86400);

    let rows;
    if (category === 'all') {
      rows = stmts.getTimelineSince.all(since, limit);
    } else {
      rows = stmts.getTimelineByCategory.all(since, category, limit);
    }

    // Enrich with icon
    const enriched = rows.map(r => {
      let metadata = {};
      try { metadata = JSON.parse(r.metadata || '{}'); } catch (_) {}
      return { ...r, icon: ICONS[r.category] || '📌', metadata };
    });
    res.json(enriched);
  });

  app.get('/api/timeline/categories', requireAuth, (_req, res) => {
    res.json(Object.keys(ICONS).map(k => ({ id: k, icon: ICONS[k] })));
  });
}

module.exports = { initTimeline, record, setupTimelineRoutes, ICONS };
