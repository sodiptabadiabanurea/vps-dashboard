// Historical charts - lifecycle, accessible summaries, and bounded rendering.
(function() {
  'use strict';

  const AUTO_REFRESH_MS = 60 * 1000;
  const STALE_AFTER_MS = 180 * 1000;
  const MAX_POINTS = 1200;
  const TABLE_ROWS = 10;
  const METRICS = ['cpu', 'ram', 'disk', 'swap', 'network'];
  const RANGES = ['1h', '6h', '24h', '7d', '30d'];
  const RANGE_LABELS = {
    '1h': '1 hour',
    '6h': '6 hours',
    '24h': '24 hours',
    '7d': '7 days',
    '30d': '30 days',
  };
  const PERCENT_METRICS = {
    cpu: { label: 'CPU', avg: 'cpu_avg', peak: 'cpu_max' },
    ram: { label: 'RAM', avg: 'ram_avg', peak: 'ram_max' },
    disk: { label: 'Disk', avg: 'disk_avg', peak: 'disk_max' },
    swap: { label: 'Swap', avg: 'swap_avg', peak: 'swap_max' },
  };

  const state = {
    metric: 'cpu',
    range: '6h',
    chart: null,
    committedView: null,
    controller: null,
    revision: 0,
    refreshTimer: null,
    lastCommittedAt: 0,
  };

  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
  const byId = id => document.getElementById(id);
  const finite = value => {
    if (value == null || value === '') return null;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  const toMillis = value => {
    const number = finite(value);
    if (number == null) return null;
    return number < 1e12 ? number * 1000 : number;
  };
  const cssVar = (name, fallback) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  function isChartsActive() {
    return byId('page-charts')?.classList.contains('active') === true;
  }

  function isChartsVisible() {
    return isChartsActive() && document.visibilityState !== 'hidden';
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value == null ? '' : String(value);
  }

  function setShellState(nextState, message, busy = false) {
    const shell = byId('chartShell');
    const refresh = byId('chartRefresh');
    const status = byId('chartStatus');
    if (shell) {
      shell.dataset.state = nextState;
      shell.setAttribute('aria-busy', String(busy));
    }
    if (refresh) {
      refresh.disabled = busy;
      refresh.setAttribute('aria-busy', String(busy));
    }
    if (status) {
      status.dataset.state = nextState;
      status.hidden = !['loading', 'refreshing', 'error', 'empty'].includes(nextState);
      const messageNode = status.querySelector('span:last-child');
      if (messageNode) messageNode.textContent = message;
      else status.textContent = message;
    }
  }

  function setPressedState(selector, dataKey, selectedValue) {
    const buttons = [...document.querySelectorAll(selector)];
    buttons.forEach(button => {
      const selected = button.dataset[dataKey] === selectedValue;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
  }

  function updateControls() {
    setPressedState('.chart-tab', 'metric', state.metric);
    setPressedState('.range-tab', 'range', state.range);
    const trends = document.querySelector('.resource-trends');
    if (trends) trends.dataset.metric = state.metric;
    const metricLabel = state.metric === 'network' ? 'Network' : PERCENT_METRICS[state.metric]?.label || state.metric;
    setText('chartPanelTitle', `${metricLabel} over the last ${RANGE_LABELS[state.range] || state.range}`);
  }

  function prepareSelection(selection = {}) {
    if (METRICS.includes(selection.metric)) state.metric = selection.metric;
    if (RANGES.includes(selection.range)) state.range = selection.range;
    updateControls();
    return { metric: state.metric, range: state.range };
  }

  function cancelActiveRequest() {
    const wasActive = state.controller != null;
    state.revision += 1;
    state.controller?.abort();
    state.controller = null;
    if (!wasActive) return;
    if (state.committedView) {
      setCommittedShellState(state.committedView);
    } else {
      setShellState('idle', 'Historical refresh paused. Return to Charts to retry.');
    }
  }

  function clearRefreshTimer() {
    if (state.refreshTimer == null) return;
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }

  function scheduleRefresh() {
    clearRefreshTimer();
    if (!isChartsVisible()) return;
    state.refreshTimer = window.setTimeout(() => {
      state.refreshTimer = null;
      refreshCharts({ reason: 'auto' });
    }, AUTO_REFRESH_MS);
  }

  function downsample(samples, limit = MAX_POINTS) {
    if (samples.length <= limit) return samples;
    const result = [];
    const step = (samples.length - 1) / (limit - 1);
    let previous = -1;
    for (let index = 0; index < limit; index += 1) {
      const sourceIndex = Math.round(index * step);
      if (sourceIndex === previous) continue;
      result.push(samples[sourceIndex]);
      previous = sourceIndex;
    }
    return result;
  }

  function normalizedSamples(payload) {
    const rows = Array.isArray(payload?.samples) ? payload.samples : [];
    return downsample(rows.filter(row => toMillis(row?.ts) != null), MAX_POINTS);
  }

  function summaryValue(summary, key, fallback) {
    const value = finite(summary?.[key]);
    return value == null ? fallback : value;
  }

  function fallbackPercentSummary(samples, config) {
    const averages = samples.map(row => finite(row[config.avg])).filter(value => value != null);
    const peaks = samples.map(row => finite(row[config.peak])).filter(value => value != null);
    return {
      current: averages.at(-1) ?? null,
      avg: averages.length ? averages.reduce((sum, value) => sum + value, 0) / averages.length : null,
      peak: peaks.length ? Math.max(...peaks) : averages.length ? Math.max(...averages) : null,
      threshold: null,
      unit: 'percent',
    };
  }

  function fallbackNetworkSummary(samples) {
    const pairs = key => samples.map(row => finite(row[key])).filter(value => value != null);
    const rxAvg = pairs('net_rx_avg');
    const txAvg = pairs('net_tx_avg');
    const rxPeak = pairs('net_rx_max');
    const txPeak = pairs('net_tx_max');
    const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    return {
      current: { rx: rxAvg.at(-1) ?? null, tx: txAvg.at(-1) ?? null },
      avg: { rx: average(rxAvg), tx: average(txAvg) },
      peak: {
        rx: rxPeak.length ? Math.max(...rxPeak) : rxAvg.length ? Math.max(...rxAvg) : null,
        tx: txPeak.length ? Math.max(...txPeak) : txAvg.length ? Math.max(...txAvg) : null,
      },
      threshold: null,
      unit: 'bytes_per_second',
    };
  }

  function normalizePercentSummary(payload, metric, samples) {
    const config = PERCENT_METRICS[metric];
    const fallback = fallbackPercentSummary(samples, config);
    const summary = payload?.summaries?.[metric] || {};
    return {
      current: summaryValue(summary, 'current', fallback.current),
      avg: summaryValue(summary, 'avg', fallback.avg),
      peak: summaryValue(summary, 'peak', fallback.peak),
      threshold: summaryValue(summary, 'threshold', fallback.threshold),
      unit: summary.unit || fallback.unit,
    };
  }

  function normalizeNetworkSummary(payload, samples) {
    const fallback = fallbackNetworkSummary(samples);
    const summary = payload?.summaries?.network || {};
    const pair = (key, fallbackPair) => ({
      rx: summaryValue(summary[key], 'rx', fallbackPair.rx),
      tx: summaryValue(summary[key], 'tx', fallbackPair.tx),
    });
    return {
      current: pair('current', fallback.current),
      avg: pair('avg', fallback.avg),
      peak: pair('peak', fallback.peak),
      threshold: null,
      unit: summary.unit || fallback.unit,
    };
  }

  function networkScale(samples, summary) {
    const values = [];
    for (const row of samples) {
      values.push(finite(row.net_rx_avg), finite(row.net_rx_max), finite(row.net_tx_avg), finite(row.net_tx_max));
    }
    for (const group of ['current', 'avg', 'peak']) {
      values.push(finite(summary[group]?.rx), finite(summary[group]?.tx));
    }
    const maximum = Math.max(0, ...values.filter(value => value != null));
    if (maximum >= 1024 ** 3) return { divisor: 1024 ** 3, label: 'GB/s' };
    if (maximum >= 1024 ** 2) return { divisor: 1024 ** 2, label: 'MB/s' };
    if (maximum >= 1024) return { divisor: 1024, label: 'KB/s' };
    return { divisor: 1, label: 'B/s' };
  }

  function incidentMatchesMetric(incident, metric) {
    const explicit = String(incident?.metric || '').toLowerCase();
    if (explicit) return explicit === metric;
    const type = String(incident?.type || '').toLowerCase();
    if (!type) return false;
    if (metric === 'network') return type === 'network' || type.startsWith('net_') || type.includes('network');
    return type === metric || type.startsWith(`${metric}_`) || type.includes(metric);
  }

  function buildView(payload, metric, range) {
    const samples = normalizedSamples(payload);
    const summary = metric === 'network'
      ? normalizeNetworkSummary(payload, samples)
      : normalizePercentSummary(payload, metric, samples);
    const incidents = (Array.isArray(payload?.incidents) ? payload.incidents : [])
      .filter(incident => incidentMatchesMetric(incident, metric) && toMillis(incident.ts) != null);
    const incidentTotal = finite(payload?.incident_counts?.[metric]);
    return {
      payload,
      metric,
      range,
      samples,
      summary,
      incidents,
      incidentTotal: incidentTotal == null ? incidents.length : Math.max(incidents.length, incidentTotal),
      scale: metric === 'network' ? networkScale(samples, summary) : { divisor: 1, label: '%' },
      generatedAt: toMillis(payload?.generated_at),
      latestSampleAt: toMillis(payload?.latest_sample_at) || toMillis(samples.at(-1)?.ts),
      resolutionSeconds: finite(payload?.resolution_seconds),
      sourceCount: finite(payload?.source_count),
    };
  }

  function hasRenderableData(view) {
    if (view.metric === 'network') {
      return view.samples.some(sample => [
        sample.net_rx_avg,
        sample.net_rx_max,
        sample.net_tx_avg,
        sample.net_tx_max,
      ].some(value => finite(value) != null));
    }
    const config = PERCENT_METRICS[view.metric];
    return view.samples.some(sample => finite(sample[config.avg]) != null || finite(sample[config.peak]) != null);
  }

  function unavailableMessage(view) {
    if (view.metric === 'swap') {
      return 'Swap is not configured or no swap samples are available for this range.';
    }
    const label = view.metric === 'network' ? 'network' : PERCENT_METRICS[view.metric].label;
    return `No usable ${label} samples are available for this range.`;
  }

  function themeColors(metric) {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    const primaryVar = metric === 'network' ? '--chart-rx' : `--chart-${metric}`;
    const primaryFallback = {
      cpu: light ? '#15803d' : '#4ade80',
      ram: light ? '#1d4ed8' : '#60a5fa',
      disk: light ? '#a16207' : '#fbbf24',
      swap: light ? '#c2410c' : '#fb923c',
      network: light ? '#0e7490' : '#22d3ee',
    }[metric];
    return {
      primary: cssVar(primaryVar, primaryFallback),
      secondary: metric === 'network'
        ? cssVar('--chart-tx', light ? '#be185d' : '#f472b6')
        : cssVar('--chart-text', light ? '#5b6475' : '#a7adbf'),
      threshold: cssVar('--chart-threshold', light ? '#b45309' : '#f59e0b'),
      incident: cssVar('--chart-incident', light ? '#be123c' : '#fb7185'),
      grid: cssVar('--chart-grid', light ? '#d1d5db' : '#252540'),
      text: cssVar('--chart-text', light ? '#5b6475' : '#a7adbf'),
      card: cssVar('--bg-card', light ? '#ffffff' : '#1a1a2e'),
      primaryText: cssVar('--text-primary', light ? '#1a1a1a' : '#e0e0e0'),
      secondaryText: cssVar('--text-secondary', light ? '#4b5563' : '#a1a1aa'),
      border: cssVar('--border', light ? '#d1d5db' : '#333333'),
    };
  }

  function rgba(hex, alpha) {
    const value = String(hex).replace('#', '');
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function pointData(samples, key, divisor = 1) {
    return samples.map(row => ({ x: toMillis(row.ts), y: finite(row[key]) == null ? null : finite(row[key]) / divisor }));
  }

  function baseLineDataset(label, data, color, options = {}) {
    return {
      type: 'line',
      label,
      data,
      borderColor: color,
      backgroundColor: options.fill ? rgba(color, 0.08) : 'transparent',
      borderWidth: options.width || 2,
      borderDash: options.dash || [],
      fill: Boolean(options.fill),
      tension: reducedMotion() ? 0 : 0.12,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: false,
      normalized: true,
      parsing: false,
      _kind: options.kind || 'series',
    };
  }

  function buildDatasets(view) {
    const colors = themeColors(view.metric);
    const datasets = [];
    if (view.metric === 'network') {
      datasets.push(baseLineDataset('RX average', pointData(view.samples, 'net_rx_avg', view.scale.divisor), colors.primary, { fill: true }));
      datasets.push(baseLineDataset('TX average', pointData(view.samples, 'net_tx_avg', view.scale.divisor), colors.secondary));
    } else {
      const config = PERCENT_METRICS[view.metric];
      datasets.push(baseLineDataset(`${config.label} average`, pointData(view.samples, config.avg), colors.primary, { fill: true, width: 2.4 }));
      datasets.push(baseLineDataset(`${config.label} peak`, pointData(view.samples, config.peak), colors.secondary, { dash: [5, 4], width: 1.6 }));
      if (view.summary.threshold != null) {
        datasets.push(baseLineDataset(
          `${config.label} threshold`,
          view.samples.map(row => ({ x: toMillis(row.ts), y: view.summary.threshold })),
          colors.threshold,
          { dash: [8, 5], width: 1.5, kind: 'threshold' }
        ));
      }
    }

    if (view.incidents.length) {
      datasets.push({
        type: 'scatter',
        label: 'Incidents',
        data: view.incidents.map(incident => ({
          x: toMillis(incident.ts),
          y: (finite(incident.value) ?? finite(incident.threshold) ?? finite(view.summary.threshold) ?? 0) / (view.metric === 'network' ? view.scale.divisor : 1),
          message: String(incident.message || 'Incident'),
        })),
        borderColor: colors.incident,
        backgroundColor: colors.incident,
        pointRadius: 5,
        pointHoverRadius: 7,
        pointStyle: 'triangle',
        showLine: false,
        parsing: false,
        _kind: 'incident',
      });
    }
    return datasets;
  }

  function formatNumber(value, digits = 1) {
    return value == null ? '-' : Number(value).toLocaleString('id-ID', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  }

  function formatMetricValue(value, view) {
    if (value == null) return '-';
    if (view.metric === 'network') return `${formatNumber(Number(value) / view.scale.divisor, 2)} ${view.scale.label}`;
    return `${formatNumber(value, 1)}%`;
  }

  function formatNetworkPair(pair, view, compact = true) {
    if (compact) return `R ${formatMetricValue(pair?.rx, view)} | T ${formatMetricValue(pair?.tx, view)}`;
    return `receive ${formatMetricValue(pair?.rx, view)}; transmit ${formatMetricValue(pair?.tx, view)}`;
  }

  function buildChartOptions(view) {
    const colors = themeColors(view.metric);
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 180 },
      interaction: { intersect: false, mode: 'index' },
      normalized: true,
      plugins: {
        legend: { display: false },
        decimation: { enabled: true, algorithm: 'lttb', samples: 600, threshold: 800 },
        tooltip: {
          backgroundColor: colors.card,
          titleColor: colors.primaryText,
          bodyColor: colors.secondaryText,
          borderColor: colors.border,
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          callbacks: {
            label(context) {
              if (context.dataset?._kind === 'incident') return context.raw?.message || 'Incident';
              const value = finite(context.parsed?.y);
              const formatted = view.metric === 'network'
                ? `${formatNumber(value, 2)} ${view.scale.label}`
                : `${formatNumber(value, 1)}%`;
              return `${context.dataset.label}: ${formatted}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'MMM d, HH:mm' },
          grid: { color: colors.grid, drawBorder: false },
          ticks: { color: colors.text, maxTicksLimit: 8, font: { size: 11 } },
          border: { display: false },
        },
        y: {
          min: 0,
          suggestedMax: view.metric === 'network' ? undefined : 100,
          grid: { color: colors.grid, drawBorder: false },
          ticks: {
            color: colors.text,
            maxTicksLimit: 6,
            font: { size: 11 },
            callback(value) {
              return view.metric === 'network' ? `${value} ${view.scale.label}` : `${value}%`;
            },
          },
          border: { display: false },
        },
      },
    };
  }

  function renderChart(view) {
    const canvas = byId('historyChart');
    if (!canvas || !window.Chart) throw new Error('Chart rendering library is unavailable.');
    const data = { datasets: buildDatasets(view) };
    const options = buildChartOptions(view);
    if (!state.chart) {
      state.chart = new window.Chart(canvas, { type: 'line', data, options });
    } else {
      state.chart.data.datasets = data.datasets;
      state.chart.options = options;
      state.chart.update(reducedMotion() ? 'none' : undefined);
    }
  }

  function updateChartTheme() {
    if (!state.chart || !state.committedView) return;
    state.chart.data.datasets = buildDatasets(state.committedView);
    state.chart.options = buildChartOptions(state.committedView);
    state.chart.update('none');
  }

  function formatAge(milliseconds) {
    if (milliseconds == null) return 'unknown age';
    const seconds = Math.max(0, Math.floor((Date.now() - milliseconds) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
  }

  function formatResolution(seconds) {
    if (seconds == null) return 'unknown resolution';
    if (seconds < 60) return `${seconds}s resolution`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h resolution`;
    return `${Math.round(seconds / 60)}m resolution`;
  }

  function isViewStale(view) {
    return view.latestSampleAt == null || Date.now() - view.latestSampleAt > STALE_AFTER_MS;
  }

  function updateFreshness(view) {
    const freshness = byId('chartFreshness');
    const parts = [formatAge(view.latestSampleAt), formatResolution(view.resolutionSeconds)];
    if (view.sourceCount != null) parts.push(`${view.sourceCount} source samples`);
    if (freshness) {
      freshness.textContent = parts.join(' | ');
      freshness.dataset.timestamp = view.latestSampleAt ? new Date(view.latestSampleAt).toISOString() : '';
      freshness.title = view.latestSampleAt ? new Date(view.latestSampleAt).toLocaleString('id-ID') : '';
      const container = freshness.closest('.chart-freshness');
      if (container) container.dataset.state = isViewStale(view) ? 'stale' : 'fresh';
    }
  }

  function updateKpis(view) {
    if (view.metric === 'network') {
      setText('chartCurrent', formatNetworkPair(view.summary.current, view));
      setText('chartAverage', formatNetworkPair(view.summary.avg, view));
      setText('chartPeak', formatNetworkPair(view.summary.peak, view));
    } else {
      setText('chartCurrent', formatMetricValue(view.summary.current, view));
      setText('chartAverage', formatMetricValue(view.summary.avg, view));
      setText('chartPeak', formatMetricValue(view.summary.peak, view));
    }
    setText('chartSamples', String(view.samples.length));

    const threshold = byId('chartThresholdLegend');
    if (threshold) {
      threshold.hidden = view.summary.threshold == null;
      threshold.textContent = view.summary.threshold == null ? '' : `Threshold ${formatMetricValue(view.summary.threshold, view)}`;
      threshold.closest('.chart-context-legend')?.toggleAttribute('hidden', view.summary.threshold == null);
    }
    const incident = byId('chartIncidentLegend');
    if (incident) {
      incident.hidden = false;
      if (view.incidents.length && view.incidentTotal > view.incidents.length) {
        incident.textContent = `Showing ${view.incidents.length} of ${view.incidentTotal} incident markers`;
      } else if (view.incidents.length) {
        incident.textContent = `${view.incidents.length} incident marker${view.incidents.length === 1 ? '' : 's'}`;
      } else if (view.incidentTotal > 0) {
        incident.textContent = `${view.incidentTotal} incidents recorded; marker detail unavailable`;
      } else {
        incident.textContent = 'No incidents in this range';
      }
      incident.closest('.chart-context-legend')?.removeAttribute('hidden');
    }
  }

  function incidentMap(view) {
    const map = new Map();
    const resolutionMs = Math.max(1, view.resolutionSeconds || 1) * 1000;
    for (const incident of view.incidents) {
      const timestamp = toMillis(incident.ts);
      const key = timestamp == null ? null : Math.floor(timestamp / resolutionMs) * resolutionMs;
      if (key == null) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(String(incident.message || 'Incident'));
    }
    return map;
  }

  function tableValues(row, view) {
    if (view.metric === 'network') {
      return [
        `RX ${formatMetricValue(row.net_rx_avg, view)} / TX ${formatMetricValue(row.net_tx_avg, view)}`,
        `RX ${formatMetricValue(row.net_rx_max, view)} / TX ${formatMetricValue(row.net_tx_max, view)}`,
      ];
    }
    const config = PERCENT_METRICS[view.metric];
    return [formatMetricValue(finite(row[config.avg]), view), formatMetricValue(finite(row[config.peak]), view)];
  }

  function updateAccessibleTable(view) {
    const body = byId('chartDataRows');
    if (!body) return;
    body.replaceChildren();
    const incidents = incidentMap(view);
    const rows = view.samples.slice(-TABLE_ROWS).reverse();
    for (const row of rows) {
      const tr = document.createElement('tr');
      const timestamp = toMillis(row.ts);
      const values = tableValues(row, view);
      const cells = [
        timestamp == null ? '-' : new Date(timestamp).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' }),
        values[0],
        values[1],
        (incidents.get(timestamp) || []).join('; ') || '-',
      ];
      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function updateAccessibility(view) {
    const canvas = byId('historyChart');
    const metricLabel = view.metric === 'network' ? 'Network RX and TX' : PERCENT_METRICS[view.metric].label;
    const current = view.metric === 'network' ? formatNetworkPair(view.summary.current, view, false) : formatMetricValue(view.summary.current, view);
    const average = view.metric === 'network' ? formatNetworkPair(view.summary.avg, view, false) : formatMetricValue(view.summary.avg, view);
    const peak = view.metric === 'network' ? formatNetworkPair(view.summary.peak, view, false) : formatMetricValue(view.summary.peak, view);
    const threshold = view.summary.threshold == null ? '' : ` Threshold ${formatMetricValue(view.summary.threshold, view)}.`;
    const incidentSummary = view.incidentTotal > view.incidents.length
      ? `${view.incidents.length} plotted markers from ${view.incidentTotal} incidents.`
      : `${view.incidents.length} incident markers.`;
    const summary = `${metricLabel} over ${RANGE_LABELS[view.range] || view.range}. Current ${current}. Average ${average}. Peak ${peak}.${threshold} ${view.samples.length} plotted samples and ${incidentSummary} Latest sample ${formatAge(view.latestSampleAt)}. Recent values are available in the table.`;
    setText('chartA11ySummary', summary);
    if (canvas) {
      canvas.setAttribute('role', 'img');
      canvas.removeAttribute('aria-labelledby');
      canvas.setAttribute('aria-label', `${metricLabel} historical chart for ${RANGE_LABELS[view.range] || view.range}`);
      if (byId('chartA11ySummary')) canvas.setAttribute('aria-describedby', 'chartA11ySummary');
    }
  }

  function clearView(message) {
    setText('chartCurrent', '-');
    setText('chartAverage', '-');
    setText('chartPeak', '-');
    setText('chartSamples', '0');
    setText('chartA11ySummary', message);
    setText('chartFreshness', 'No samples');
    const freshness = byId('chartFreshness')?.closest('.chart-freshness');
    if (freshness) freshness.dataset.state = 'empty';
    byId('chartThresholdLegend')?.closest('.chart-context-legend')?.setAttribute('hidden', '');
    byId('chartIncidentLegend')?.closest('.chart-context-legend')?.setAttribute('hidden', '');
    byId('chartDataRows')?.replaceChildren();
    if (state.chart) {
      state.chart.data.datasets = [];
      state.chart.update('none');
    }
  }

  function setCommittedShellState(view) {
    if (isViewStale(view)) {
      setShellState('stale', 'Historical data is stale. Refresh to request the latest samples.');
    } else {
      setShellState('ready', `Showing ${view.metric === 'network' ? 'network' : PERCENT_METRICS[view.metric].label} history for ${RANGE_LABELS[view.range] || view.range}.`);
    }
  }

  function renderView(view) {
    state.committedView = view;
    renderChart(view);
    updateKpis(view);
    updateFreshness(view);
    updateAccessibility(view);
    updateAccessibleTable(view);
    setCommittedShellState(view);
  }

  function errorMessage(payload, response) {
    if (typeof payload?.error === 'string') return payload.error;
    if (payload?.error?.message) return String(payload.error.message);
    return `Chart request failed with HTTP ${response.status}.`;
  }

  async function fetchHistory(range, signal) {
    const response = await fetch(`/api/charts/history?range=${encodeURIComponent(range)}&max_points=${MAX_POINTS}`, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorMessage(payload, response));
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.samples)) {
      throw new Error('Chart API returned an invalid response.');
    }
    return payload;
  }

  async function refreshCharts(options = {}) {
    if (!isChartsVisible() && options.reason !== 'manual') {
      scheduleRefresh();
      return null;
    }
    const metric = state.metric;
    const range = state.range;
    const revision = ++state.revision;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;

    setShellState(state.committedView ? 'refreshing' : 'loading', state.committedView ? 'Refreshing historical data...' : 'Loading historical data...', true);
    try {
      const payload = await fetchHistory(range, controller.signal);
      if (controller.signal.aborted || revision !== state.revision) return null;
      const view = buildView(payload, metric, range);
      if (!view.samples.length || !hasRenderableData(view)) {
        const message = unavailableMessage(view);
        state.committedView = null;
        clearView(message);
        setShellState('empty', message);
      } else {
        renderView(view);
      }
      state.lastCommittedAt = Date.now();
      return view;
    } catch (error) {
      if (controller.signal.aborted || revision !== state.revision || error.name === 'AbortError') return null;
      const message = error.message || 'Historical chart request failed.';
      setShellState('error', `${message} Use Refresh to retry.`);
      if (!state.committedView) clearView(message);
      return null;
    } finally {
      if (revision === state.revision) {
        state.controller = null;
        const refresh = byId('chartRefresh');
        if (refresh) {
          refresh.disabled = false;
          refresh.setAttribute('aria-busy', 'false');
        }
        byId('chartShell')?.setAttribute('aria-busy', 'false');
        scheduleRefresh();
      }
    }
  }

  function selectValue(kind, value, options = {}) {
    const allowed = kind === 'metric' ? METRICS : RANGES;
    if (!allowed.includes(value)) return false;
    state[kind] = value;
    updateControls();
    if (options.refresh !== false && isChartsVisible()) refreshCharts({ reason: 'selection' });
    return true;
  }

  function setupRovingControls(selector, kind, dataKey) {
    const buttons = [...document.querySelectorAll(selector)];
    buttons.forEach(button => {
      button.addEventListener('click', () => selectValue(kind, button.dataset[dataKey]));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const currentIndex = buttons.indexOf(button);
        let nextIndex = currentIndex;
        if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = buttons.length - 1;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
        else nextIndex = (currentIndex + 1) % buttons.length;
        const next = buttons[nextIndex];
        selectValue(kind, next.dataset[dataKey]);
        next.focus();
      });
    });
  }

  function handleVisibilityChange() {
    clearRefreshTimer();
    if (document.visibilityState === 'hidden') {
      cancelActiveRequest();
      return;
    }
    if (!isChartsActive()) return;
    const stale = state.committedView && isViewStale(state.committedView);
    const selectionChanged = state.committedView && (
      state.committedView.metric !== state.metric || state.committedView.range !== state.range
    );
    if (!state.lastCommittedAt || stale || selectionChanged || Date.now() - state.lastCommittedAt >= AUTO_REFRESH_MS) {
      refreshCharts({ reason: 'visibility' });
    } else {
      scheduleRefresh();
    }
  }

  setupRovingControls('.chart-tab', 'metric', 'metric');
  setupRovingControls('.range-tab', 'range', 'range');
  updateControls();

  byId('chartRefresh')?.addEventListener('click', () => refreshCharts({ reason: 'manual' }));
  document.addEventListener('visibilitychange', handleVisibilityChange);
  document.addEventListener('vps:pagechange', event => {
    if (event.detail?.page === 'charts') scheduleRefresh();
    else {
      clearRefreshTimer();
      cancelActiveRequest();
    }
  });
  window.addEventListener('beforeunload', cancelActiveRequest);

  const themeObserver = new MutationObserver(() => updateChartTheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  window.prepareCharts = selection => prepareSelection(selection);
  window.selectChartMetric = metric => selectValue('metric', metric);
  window.selectChartRange = range => selectValue('range', range);
  window.refreshCharts = () => refreshCharts({ reason: 'manual' });
  window.loadCharts = () => {
    updateControls();
    return refreshCharts({ reason: 'navigation' });
  };
})();
