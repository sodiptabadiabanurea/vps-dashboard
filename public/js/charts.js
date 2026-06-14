// Historical charts
(function() {
  let chart = null;
  let currentMetric = 'cpu';
  let currentRange = '6h';

  // Helper: get computed CSS variable value
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  const metricConfig = {
    cpu: {
      label: 'CPU Usage',
      color: '#00ff88',
      bgColor: 'rgba(0, 255, 136, 0.15)',
      yLabel: '%',
      getData: (rows) => rows.map(r => ({ x: r.ts * 1000, y: r.cpu })),
    },
    ram: {
      label: 'RAM Usage',
      color: '#3b82f6',
      bgColor: 'rgba(59, 130, 246, 0.15)',
      yLabel: '%',
      getData: (rows) => rows.map(r => ({ x: r.ts * 1000, y: r.ram_total > 0 ? (r.ram_used / r.ram_total * 100).toFixed(1) : 0 })),
    },
    network: {
      label: 'Network RX',
      color: '#f59e0b',
      bgColor: 'rgba(245, 158, 11, 0.15)',
      yLabel: ' MB/s',
      getData: (rows) => {
        const result = [];
        for (let i = 1; i < rows.length; i++) {
          const dt = rows[i].ts - rows[i - 1].ts;
          if (dt > 0) {
            const rxSpeed = (rows[i].net_rx - rows[i - 1].net_rx) / dt / 1024 / 1024;
            result.push({ x: rows[i].ts * 1000, y: Math.max(0, parseFloat(rxSpeed.toFixed(2))) });
          }
        }
        return result;
      },
    },
  };

  function getChartOptions(yLabel) {
    const gridColor = cssVar('--chart-grid') || '#1a1a2e';
    const textColor = cssVar('--chart-text') || '#666';
    const bgCard = cssVar('--bg-card') || '#1a1a2e';
    const textPrimary = cssVar('--text-primary') || '#e0e0e0';
    const textSecondary = cssVar('--text-secondary') || '#888';
    const borderColor = cssVar('--border') || '#333';

    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: bgCard,
          titleColor: textPrimary,
          bodyColor: textSecondary,
          borderColor: borderColor,
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          titleFont: { size: 12, weight: '600' },
          bodyFont: { size: 12 },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'MMM d, HH:mm' },
          grid: { color: gridColor, drawBorder: false },
          ticks: { color: textColor, maxTicksLimit: 8, font: { size: 11 } },
          border: { display: false },
        },
        y: {
          min: 0,
          grid: { color: gridColor, drawBorder: false },
          ticks: {
            color: textColor,
            font: { size: 11 },
            callback: (v) => v + yLabel,
            maxTicksLimit: 6,
          },
          border: { display: false },
        },
      },
    };
  }

  async function loadChart() {
    const cfg = metricConfig[currentMetric];
    try {
      const res = await fetch(`/api/history?range=${currentRange}`);
      const rows = await res.json();
      const data = cfg.getData(rows);

      if (chart) chart.destroy();

      const canvas = document.getElementById('historyChart');
      if (!canvas) return;

      chart = new Chart(canvas, {
        type: 'line',
        data: {
          datasets: [{
            label: cfg.label,
            data: data,
            borderColor: cfg.color,
            backgroundColor: cfg.bgColor,
            fill: true,
            tension: 0.4,
            pointRadius: data.length > 100 ? 0 : 3,
            pointBackgroundColor: cfg.color,
            pointBorderColor: cfg.color,
            pointHoverRadius: 5,
            borderWidth: 2.5,
          }],
        },
        options: getChartOptions(cfg.yLabel),
      });
    } catch (err) {
      console.error('Chart load error:', err);
    }
  }

  // Tab handlers
  document.querySelectorAll('.chart-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chart-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentMetric = btn.dataset.metric;
      loadChart();
    });
  });

  document.querySelectorAll('.range-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRange = btn.dataset.range;
      loadChart();
    });
  });

  // Reload chart when theme changes
  const observer = new MutationObserver(() => {
    if (chart) loadChart();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  window.loadCharts = loadChart;
})();
