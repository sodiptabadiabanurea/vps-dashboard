import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function chartMarkup(active = true) {
  return `<!doctype html>
  <html data-theme="dark"><body>
    <button class="nav-btn" data-page="charts">Charts</button>
    <div class="page${active ? ' active' : ''}" id="page-charts">
      <section class="resource-trends" aria-labelledby="chartsTitle">
        <header class="charts-hero">
          <div class="charts-heading"><h2 id="chartsTitle">Resource Trends</h2></div>
          <div class="charts-hero-actions">
            <div class="chart-freshness"><strong id="chartFreshness">Waiting</strong></div>
            <button class="chart-refresh" id="chartRefresh" type="button"><span>Refresh</span></button>
          </div>
        </header>
        <div class="chart-controls">
          <fieldset class="chart-control-group"><legend>Metric</legend><div class="chart-tabs" role="group" aria-label="Resource metric">
            <button class="chart-tab active" type="button" data-metric="cpu">CPU</button>
            <button class="chart-tab" type="button" data-metric="ram">RAM</button>
            <button class="chart-tab" type="button" data-metric="disk">Disk</button>
            <button class="chart-tab" type="button" data-metric="swap">Swap</button>
            <button class="chart-tab" type="button" data-metric="network">Network</button>
          </div></fieldset>
          <fieldset class="chart-control-group chart-range-group"><legend>Range</legend><div class="chart-range-tabs" role="group" aria-label="History range">
            <button class="range-tab" type="button" data-range="1h">1h</button>
            <button class="range-tab active" type="button" data-range="6h">6h</button>
            <button class="range-tab" type="button" data-range="24h">24h</button>
            <button class="range-tab" type="button" data-range="7d">7d</button>
            <button class="range-tab" type="button" data-range="30d">30d</button>
          </div></fieldset>
        </div>
        <dl class="chart-kpi-grid">
          <div class="chart-kpi"><dt>Current</dt><dd id="chartCurrent">-</dd></div>
          <div class="chart-kpi"><dt>Average</dt><dd id="chartAverage">-</dd></div>
          <div class="chart-kpi"><dt>Peak</dt><dd id="chartPeak">-</dd></div>
          <div class="chart-kpi"><dt>Samples</dt><dd id="chartSamples">-</dd></div>
        </dl>
        <section class="chart-shell" id="chartShell">
          <header class="chart-shell-head"><h3 id="chartPanelTitle">CPU over the last 6 hours</h3>
            <div><span class="chart-context-legend"><span id="chartThresholdLegend"></span></span><span class="chart-context-legend"><span id="chartIncidentLegend"></span></span></div>
          </header>
          <div class="chart-container">
            <canvas id="historyChart">Historical chart fallback.</canvas>
            <div class="chart-status" id="chartStatus" role="status" aria-live="polite" hidden><span class="chart-status-spinner"></span><span>Loading</span></div>
          </div>
          <p id="chartA11ySummary"></p>
        </section>
        <details class="chart-data-details"><summary>Accessible data table</summary><div class="chart-data-scroll">
          <table class="chart-data-table"><thead><tr><th>Time</th><th>Average</th><th>Peak</th><th>Incident</th></tr></thead><tbody id="chartDataRows"></tbody></table>
        </div></details>
      </section>
    </div>
    <div class="page${active ? '' : ' active'}" id="page-dashboard"></div>
    <div id="alertToast" class="hidden"><span id="alertToastText"></span></div>
  </body></html>`;
}

async function installHarness(page) {
  await page.evaluate(() => {
    window.__visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => window.__visibility,
    });

    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const autoTimers = new Map();
    let nextAutoId = 900000;
    window.__nativeSetTimeout = nativeSetTimeout;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 60000) {
        const id = nextAutoId++;
        autoTimers.set(id, () => callback(...args));
        return id;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = id => {
      if (autoTimers.delete(id)) return;
      nativeClearTimeout(id);
    };
    window.__runAutoTimer = () => {
      const entry = [...autoTimers.entries()].at(-1);
      if (!entry) return false;
      autoTimers.delete(entry[0]);
      entry[1]();
      return true;
    };
    window.__autoTimerCount = () => autoTimers.size;

    const now = Math.floor(Date.now() / 1000);
    window.__makeChartPayload = (options = {}) => {
      const count = options.count ?? 12;
      const start = options.start ?? Math.floor((now - count * 60) / 60) * 60;
      const samples = Array.from({ length: count }, (_, index) => {
        const base = index + 1;
        return {
          ts: start + index * 60,
          cpu_avg: 20 + base,
          cpu_max: 30 + base,
          ram_avg: 40 + base / 10,
          ram_max: 50 + base / 10,
          disk_avg: 60 + base / 20,
          disk_max: 65 + base / 20,
          swap_avg: base / 10,
          swap_max: base / 8,
          net_rx_avg: base * 1024 * 1024,
          net_rx_max: base * 2 * 1024 * 1024,
          net_tx_avg: base * 512 * 1024,
          net_tx_max: base * 1024 * 1024,
        };
      });
      const latest = samples.at(-1)?.ts ?? null;
      const incidents = options.incidents || [{ ts: latest, type: 'cpu', metric: 'cpu', message: 'CPU threshold crossed', value: 92, threshold: 90 }];
      const incidentCounts = options.incidentCounts || incidents.reduce((counts, incident) => {
        const metric = incident.metric || incident.type;
        if (Object.hasOwn(counts, metric)) counts[metric] += 1;
        return counts;
      }, { cpu: 0, ram: 0, disk: 0, swap: 0, network: 0 });
      return {
        schema_version: 2,
        range: options.range || '6h',
        max_points: 1200,
        resolution_seconds: options.resolution ?? 60,
        generated_at: options.generatedAt ?? now,
        latest_sample_at: options.latestSampleAt === undefined ? latest : options.latestSampleAt,
        source_count: options.sourceCount ?? count,
        samples,
        incident_counts: incidentCounts,
        summaries: {
          cpu: { current: 32, avg: 28, peak: 88, threshold: 90, unit: 'percent' },
          ram: { current: 51, avg: 48, peak: 72, threshold: 85, unit: 'percent' },
          disk: { current: 64, avg: 62, peak: 70, threshold: 90, unit: 'percent' },
          swap: { current: 2, avg: 1, peak: 4, threshold: 50, unit: 'percent' },
          network: {
            current: { rx: 12 * 1024 * 1024, tx: 6 * 1024 * 1024 },
            avg: { rx: 8 * 1024 * 1024, tx: 4 * 1024 * 1024 },
            peak: { rx: 24 * 1024 * 1024, tx: 12 * 1024 * 1024 },
            threshold: null,
            unit: 'bytes_per_second',
          },
        },
        incidents,
      };
    };

    window.__chartApi = { calls: [], queue: [], defaultPayload: window.__makeChartPayload() };
    window.fetch = (url, options = {}) => {
      const item = window.__chartApi.queue.shift() || {};
      const range = new URL(String(url), 'https://dashboard.test').searchParams.get('range') || '6h';
      const payload = structuredClone(item.payload || { ...window.__chartApi.defaultPayload, range });
      const call = { url: String(url), range, aborted: false, status: item.status || 200 };
      window.__chartApi.calls.push(call);
      return new Promise((resolve, reject) => {
        const complete = () => {
          resolve({
            ok: call.status >= 200 && call.status < 300,
            status: call.status,
            json: async () => structuredClone(payload),
          });
        };
        const timer = item.hold ? null : window.__nativeSetTimeout(complete, item.delay || 0);
        if (item.hold) call.release = complete;
        options.signal?.addEventListener('abort', () => {
          if (timer != null) nativeClearTimeout(timer);
          call.aborted = true;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    };
    window.__releaseChartRequest = () => window.__chartApi.calls.findLast(call => typeof call.release === 'function')?.release();

    class FakeChart {
      static registry = new Map();
      static createCount = 0;
      static getChart(target) {
        const canvas = typeof target === 'string' ? document.getElementById(target) : target;
        return FakeChart.registry.get(canvas) || null;
      }
      constructor(canvas, config) {
        this.canvas = canvas;
        this.data = config.data;
        this.options = config.options;
        this.id = ++FakeChart.createCount;
        this.updateCount = 0;
        this.lastUpdateMode = null;
        FakeChart.registry.set(canvas, this);
      }
      update(mode) {
        this.updateCount += 1;
        this.lastUpdateMode = mode;
      }
      destroy() {
        FakeChart.registry.delete(this.canvas);
      }
    }
    window.Chart = FakeChart;

    document.querySelector('.nav-btn[data-page="charts"]').addEventListener('click', () => {
      document.querySelectorAll('.page').forEach(element => element.classList.remove('active'));
      document.getElementById('page-charts').classList.add('active');
      window.loadCharts?.();
      document.dispatchEvent(new CustomEvent('vps:pagechange', { detail: { page: 'charts' } }));
    });
  });
}

async function setupPage(browser, options = {}) {
  const context = await browser.newContext({ viewport: options.viewport || { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(chartMarkup(options.active !== false));
  await page.addStyleTag({ path: path.join(root, 'public/css/themes.css') });
  await page.addStyleTag({ path: path.join(root, 'public/css/main.css') });
  await page.addStyleTag({ path: path.join(root, 'public/css/charts.css') });
  await installHarness(page);
  await page.addScriptTag({ path: path.join(root, 'public/js/charts.js') });
  return { context, page, errors };
}

async function waitForState(page, expected) {
  await page.waitForFunction(value => document.getElementById('chartShell')?.dataset.state === value, expected);
}

const browser = await chromium.launch({ headless: true });
try {
  const { context, page, errors } = await setupPage(browser);

  await page.evaluate(() => {
    window.__chartApi.queue.push({ payload: window.__makeChartPayload(), hold: true });
    window.__loadPromise = window.loadCharts();
  });
  assert.equal(await page.locator('#chartShell').getAttribute('data-state'), 'loading');
  assert.equal(await page.locator('#chartStatus').isVisible(), true);
  assert.equal(await page.locator('#chartRefresh').evaluate(element => element.disabled), true);
  await page.evaluate(() => window.__releaseChartRequest());
  await waitForState(page, 'ready');

  const initial = await page.evaluate(() => {
    const chart = Chart.getChart('historyChart');
    return {
      createCount: Chart.createCount,
      labels: chart.data.datasets.map(dataset => dataset.label),
      samples: chart.data.datasets[0].data.length,
      current: document.getElementById('chartCurrent').textContent,
      summary: document.getElementById('chartA11ySummary').textContent,
      canvasRole: document.getElementById('historyChart').getAttribute('role'),
      canvasLabel: document.getElementById('historyChart').getAttribute('aria-label'),
      canvasDescription: document.getElementById('historyChart').getAttribute('aria-describedby'),
      rows: document.querySelectorAll('#chartDataRows tr').length,
      statusHidden: document.getElementById('chartStatus').hidden,
      requestUrl: window.__chartApi.calls[0].url,
    };
  });
  assert.equal(initial.createCount, 1);
  assert.deepEqual(initial.labels, ['CPU average', 'CPU peak', 'CPU threshold', 'Incidents']);
  assert.equal(initial.samples, 12);
  assert.match(initial.current, /32/);
  assert.match(initial.summary, /CPU over 6 hours/);
  assert.equal(initial.canvasRole, 'img');
  assert.match(initial.canvasLabel, /CPU historical chart/);
  assert.equal(initial.canvasDescription, 'chartA11ySummary');
  assert.equal(initial.rows, 10);
  assert.equal(initial.statusHidden, true);
  assert.match(initial.requestUrl, /max_points=1200/);
  assert.match(await page.locator('#chartIncidentLegend').textContent(), /incident marker/);
  assert.equal(await page.evaluate(() => Chart.getChart('historyChart').data.datasets[0].borderColor), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--chart-cpu').trim()));

  // A slow old range must abort and never replace the newer selection.
  await page.evaluate(() => {
    window.__chartApi.queue.push(
      { payload: window.__makeChartPayload({ range: '1h', count: 5 }), delay: 300 },
      { payload: window.__makeChartPayload({ range: '24h', count: 20 }), delay: 25 }
    );
  });
  await page.click('.range-tab[data-range="1h"]');
  await page.waitForTimeout(10);
  await page.click('.range-tab[data-range="24h"]');
  await waitForState(page, 'ready');
  await page.waitForTimeout(350);
  const race = await page.evaluate(() => ({
    active: document.querySelector('.range-tab.active').dataset.range,
    points: Chart.getChart('historyChart').data.datasets[0].data.length,
    aborted: window.__chartApi.calls.at(-2).aborted,
    createCount: Chart.createCount,
  }));
  assert.deepEqual(race, { active: '24h', points: 20, aborted: true, createCount: 1 });

  // Theme changes update colors/options in place and never refetch data.
  const themeBefore = await page.evaluate(() => {
    const chart = Chart.getChart('historyChart');
    return { calls: window.__chartApi.calls.length, updateCount: chart.updateCount, color: chart.data.datasets[0].borderColor };
  });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(40);
  const themeAfter = await page.evaluate(() => {
    const chart = Chart.getChart('historyChart');
    return { calls: window.__chartApi.calls.length, updateCount: chart.updateCount, color: chart.data.datasets[0].borderColor, mode: chart.lastUpdateMode };
  });
  assert.equal(themeAfter.calls, themeBefore.calls);
  assert.ok(themeAfter.updateCount > themeBefore.updateCount);
  assert.notEqual(themeAfter.color, themeBefore.color);
  assert.equal(themeAfter.mode, 'none');

  // Bounded incident payloads disclose the full count instead of claiming none.
  await page.evaluate(() => window.__chartApi.queue.push({
    payload: window.__makeChartPayload({ incidentCounts: { cpu: 123, ram: 0, disk: 0, swap: 0, network: 0 } }),
  }));
  await page.click('#chartRefresh');
  await waitForState(page, 'ready');
  assert.equal(await page.locator('#chartIncidentLegend').textContent(), 'Showing 1 of 123 incident markers');
  assert.match(await page.locator('#chartA11ySummary').textContent(), /1 plotted markers from 123 incidents/);

  // Cancelling a hidden-tab refresh restores controls immediately.
  await page.evaluate(() => {
    window.__chartApi.queue.push({ payload: window.__makeChartPayload(), hold: true });
    window.refreshCharts();
  });
  await waitForState(page, 'refreshing');
  const cancelledCall = await page.evaluate(() => window.__chartApi.calls.length - 1);
  await page.evaluate(() => {
    window.__visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('#chartRefresh').evaluate(element => element.disabled), false);
  assert.equal(await page.locator('#chartRefresh').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#chartShell').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#chartShell').getAttribute('data-state'), 'ready');
  assert.equal(await page.evaluate(index => window.__chartApi.calls[index].aborted, cancelledCall), true);
  const callsBeforeResume = await page.evaluate(() => window.__chartApi.calls.length);
  await page.evaluate(() => {
    window.__visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(40);
  assert.equal(await page.evaluate(() => window.__chartApi.calls.length), callsBeforeResume);

  // If the cancelled request represented a new selection, resume it immediately.
  await page.evaluate(() => {
    window.__chartApi.queue.push(
      { payload: window.__makeChartPayload({ range: '1h', count: 5 }), hold: true },
      { payload: window.__makeChartPayload({ range: '1h', count: 5 }) }
    );
  });
  await page.click('.range-tab[data-range="1h"]');
  await waitForState(page, 'refreshing');
  await page.evaluate(() => {
    window.__visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await page.locator('#chartRefresh').evaluate(element => element.disabled), false);
  await page.evaluate(() => {
    window.__visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitForState(page, 'ready');
  assert.equal(await page.locator('.range-tab[data-range="1h"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => Chart.getChart('historyChart').data.datasets[0].data.length), 5);

  // Error and empty states are explicit and recoverable through Refresh.
  await page.evaluate(() => window.__chartApi.queue.push({
    status: 500,
    payload: { error: { code: 'CHART_HISTORY_UNAVAILABLE', message: 'History unavailable' } },
  }));
  await page.click('#chartRefresh');
  await waitForState(page, 'error');
  assert.equal(await page.locator('#chartStatus').isVisible(), true);
  assert.match(await page.locator('#chartStatus').textContent(), /History unavailable/);

  await page.evaluate(() => window.__chartApi.queue.push({ payload: window.__makeChartPayload({ count: 0, sourceCount: 0, latestSampleAt: null, incidents: [] }) }));
  await page.click('#chartRefresh');
  await waitForState(page, 'empty');
  assert.equal(await page.locator('#chartStatus').isVisible(), true);
  assert.equal(await page.locator('#chartSamples').textContent(), '0');
  assert.equal(await page.evaluate(() => Chart.getChart('historyChart').data.datasets.length), 0);

  // Defensive downsampling caps hostile/legacy payloads at 1200 points.
  await page.evaluate(() => window.__chartApi.queue.push({ payload: window.__makeChartPayload({ count: 1500, sourceCount: 1500, incidents: [] }) }));
  await page.click('#chartRefresh');
  await waitForState(page, 'ready');
  assert.ok(await page.evaluate(() => Chart.getChart('historyChart').data.datasets[0].data.length <= 1200));
  assert.equal(await page.locator('#chartSamples').textContent(), '1200');
  assert.equal(await page.locator('#chartIncidentLegend').textContent(), 'No incidents in this range');

  // Network mode renders independent RX/TX series with adaptive units.
  await page.evaluate(() => {
    window.prepareCharts({ metric: 'network' });
    window.__chartApi.queue.push({ payload: window.__makeChartPayload({ incidents: [] }) });
    window.refreshCharts();
  });
  await waitForState(page, 'ready');
  const network = await page.evaluate(() => ({
    labels: Chart.getChart('historyChart').data.datasets.map(dataset => dataset.label),
    current: document.getElementById('chartCurrent').textContent,
    average: document.getElementById('chartAverage').textContent,
    title: document.getElementById('chartPanelTitle').textContent,
  }));
  assert.deepEqual(network.labels, ['RX average', 'TX average']);
  assert.match(network.current, /R .*MB\/s \| T .*MB\/s/);
  assert.match(network.average, /MB\/s/);
  assert.match(network.title, /Network/);
  assert.equal(await page.locator('#chartThresholdLegend').evaluate(element => element.closest('.chart-context-legend').hidden), true);
  assert.equal(await page.locator('#chartIncidentLegend').evaluate(element => element.closest('.chart-context-legend').hidden), false);
  assert.equal(await page.locator('#chartIncidentLegend').textContent(), 'No incidents in this range');

  // Null network rates remain visible gaps instead of being coerced to zero.
  await page.evaluate(() => {
    const payload = window.__makeChartPayload({ incidents: [] });
    payload.samples[3].net_rx_avg = null;
    payload.samples[3].net_tx_avg = null;
    window.__chartApi.queue.push({ payload });
    window.refreshCharts();
  });
  await waitForState(page, 'ready');
  const gaps = await page.evaluate(() => {
    const datasets = Chart.getChart('historyChart').data.datasets;
    return { rx: datasets[0].data[3].y, tx: datasets[1].data[3].y, rxSpan: datasets[0].spanGaps, txSpan: datasets[1].spanGaps };
  });
  assert.deepEqual(gaps, { rx: null, tx: null, rxSpan: false, txSpan: false });

  // A metric with only null samples gets an explicit unavailable state.
  await page.evaluate(() => {
    const payload = window.__makeChartPayload({ incidents: [] });
    payload.samples.forEach(sample => {
      sample.swap_avg = null;
      sample.swap_max = null;
    });
    payload.summaries.swap = { current: null, avg: null, peak: null, threshold: 50, unit: 'percent' };
    window.prepareCharts({ metric: 'swap' });
    window.__chartApi.queue.push({ payload });
    window.refreshCharts();
  });
  await waitForState(page, 'empty');
  assert.match(await page.locator('#chartStatus').textContent(), /Swap is not configured/);
  assert.equal(await page.locator('#chartSamples').textContent(), '0');

  // Hostile incident text stays literal in the table and accessibility copy.
  const hostile = '<img src=x onerror="window.__chartXss=1"><script>window.__chartXss=2</script>';
  await page.evaluate(value => {
    const payload = window.__makeChartPayload({ incidents: [] });
    payload.incidents = [{ ts: payload.samples.at(-1).ts, type: 'cpu', message: value, value: 99, threshold: 90 }];
    window.prepareCharts({ metric: 'cpu' });
    window.__chartApi.queue.push({ payload });
    window.refreshCharts();
  }, hostile);
  await waitForState(page, 'ready');
  assert.equal(await page.locator('#chartDataRows img, #chartDataRows script, #chartDataRows [onerror]').count(), 0);
  assert.equal(await page.evaluate(() => window.__chartXss), undefined);
  assert.ok((await page.locator('#chartDataRows').textContent()).includes('<img'));

  // Arrow keys provide roving selection and announce the active button.
  await page.evaluate(() => window.__chartApi.queue.push({ payload: window.__makeChartPayload({ incidents: [] }) }));
  await page.focus('.chart-tab[data-metric="cpu"]');
  await page.keyboard.press('ArrowRight');
  await waitForState(page, 'ready');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.metric), 'ram');
  assert.equal(await page.locator('.chart-tab[data-metric="ram"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.chart-tab[data-metric="cpu"]').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('.chart-tab[data-metric="ram"]').getAttribute('tabindex'), '0');

  // Visibility resumes stale data immediately; auto refresh pauses off-page.
  await page.evaluate(() => {
    const stale = window.__makeChartPayload({ latestSampleAt: Math.floor(Date.now() / 1000) - 181, resolution: 10800, incidents: [] });
    window.__chartApi.queue.push({ payload: stale });
    window.refreshCharts();
  });
  await waitForState(page, 'stale');
  await page.evaluate(() => {
    window.__visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenCalls = await page.evaluate(() => window.__chartApi.calls.length);
  assert.equal(await page.evaluate(() => window.__runAutoTimer()), false);
  await page.evaluate(() => {
    window.__chartApi.queue.push({ payload: window.__makeChartPayload({ incidents: [] }) });
    window.__visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitForState(page, 'ready');
  assert.equal(await page.evaluate(() => window.__chartApi.calls.length), hiddenCalls + 1);

  await page.evaluate(() => window.__chartApi.queue.push({ payload: window.__makeChartPayload({ incidents: [] }) }));
  assert.equal(await page.evaluate(() => window.__runAutoTimer()), true);
  await waitForState(page, 'ready');
  const beforeLeave = await page.evaluate(() => window.__chartApi.calls.length);
  await page.evaluate(() => {
    document.getElementById('page-charts').classList.remove('active');
    document.getElementById('page-dashboard').classList.add('active');
    document.dispatchEvent(new CustomEvent('vps:pagechange', { detail: { page: 'dashboard' } }));
  });
  assert.equal(await page.evaluate(() => window.__runAutoTimer()), false);
  assert.equal(await page.evaluate(() => window.__chartApi.calls.length), beforeLeave);

  // The production CSS keeps all controls touch-sized without page overflow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.getElementById('page-dashboard').classList.remove('active');
    document.getElementById('page-charts').classList.add('active');
    window.prepareCharts({ metric: 'network' });
    document.getElementById('chartCurrent').textContent = 'R 999,99 MB/s | T 999,99 MB/s';
    document.getElementById('chartAverage').textContent = 'R 888,88 MB/s | T 888,88 MB/s';
    document.getElementById('chartPeak').textContent = 'R 777,77 MB/s | T 777,77 MB/s';
  });
  const mobile = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    heights: [...document.querySelectorAll('.chart-tab,.range-tab,#chartRefresh')].map(element => element.getBoundingClientRect().height),
    networkKpis: [...document.querySelectorAll('.chart-kpi dd')].slice(0, 3).map(element => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    })),
  }));
  assert.ok(mobile.heights.every(height => height >= 44), `Short chart controls: ${JSON.stringify(mobile.heights)}`);
  assert.ok(mobile.networkKpis.every(({ client, scroll }) => scroll <= client + 1), `Clipped network KPIs: ${JSON.stringify(mobile.networkKpis)}`);
  assert.ok(mobile.document <= mobile.viewport + 1 && mobile.body <= mobile.viewport + 1, `Mobile overflow: ${JSON.stringify(mobile)}`);
  assert.deepEqual(errors, []);
  await context.close();

  // Palette commands prepare metric state before navigation, producing one fetch.
  const paletteSetup = await setupPage(browser, { active: false });
  await paletteSetup.page.addScriptTag({ path: path.join(root, 'public/js/palette.js') });
  await paletteSetup.page.evaluate(() => window.__chartApi.queue.push({ payload: window.__makeChartPayload({ incidents: [] }) }));
  await paletteSetup.page.keyboard.press('Control+k');
  await paletteSetup.page.fill('#paletteInput', 'RAM Chart');
  await paletteSetup.page.keyboard.press('Enter');
  await waitForState(paletteSetup.page, 'ready');
  const palette = await paletteSetup.page.evaluate(() => ({
    calls: window.__chartApi.calls.length,
    activeMetric: document.querySelector('.chart-tab.active')?.dataset.metric,
    label: Chart.getChart('historyChart').data.datasets[0].label,
    request: window.__chartApi.calls[0]?.url,
  }));
  assert.equal(palette.calls, 1);
  assert.equal(palette.activeMetric, 'ram');
  assert.equal(palette.label, 'RAM average');
  assert.match(palette.request, /range=6h/);
  assert.deepEqual(paletteSetup.errors, []);
  await paletteSetup.context.close();

  console.log('Charts browser regression passed');
} finally {
  await browser.close();
}
