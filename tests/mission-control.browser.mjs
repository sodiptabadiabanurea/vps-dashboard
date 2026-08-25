import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseURL = process.env.MC_BASE_URL || 'http://127.0.0.1:3317';
const username = process.env.MC_USER || 'mc-test';
const password = process.env.MC_PASS || 'mc-test-pass';

function collectDiagnostics(page) {
  const errors = [];
  const mutations = [];
  const baseOrigin = new URL(baseURL).origin;

  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('pageerror', error => errors.push(`page: ${error.message}`));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== baseOrigin || url.pathname.startsWith('/socket.io/')) return;
    if (!['GET', 'HEAD'].includes(request.method())) {
      mutations.push(`${request.method()} ${request.url()}`);
    }
  });

  return { errors, mutations };
}

async function assertNoOverflow(page, label) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert.ok(
    dimensions.document <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1,
    `${label} overflows horizontally: ${JSON.stringify(dimensions)}`
  );
}

async function waitForMission(page) {
  await page.waitForFunction(() => window.missionControlSnapshot?.schema_version === 1, null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const title = document.getElementById('missionNowTitle')?.textContent || '';
    return title && title !== 'Building the operational picture';
  }, null, { timeout: 15000 });
}

async function testDesktop(browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    httpCredentials: { username, password },
  });
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);

  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await waitForMission(page);
  await assertNoOverflow(page, 'desktop dashboard');

  assert.equal(await page.locator('.nav-btn[data-page="dashboard"]').getAttribute('aria-current'), 'page');
  const opener = page.locator('[data-mission-why="cpu"]').first();
  await opener.focus();
  await opener.click();
  await page.locator('#missionWhyLayer:not([hidden])').waitFor();
  assert.equal(await page.locator('#missionWhyDrawer').getAttribute('aria-modal'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'missionWhyClose');
  await page.keyboard.press('Escape');
  await page.locator('#missionWhyLayer').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.missionWhy), 'cpu');

  await page.locator('.nav-btn[data-page="processes"]').click();
  await page.waitForTimeout(6000);
  await page.locator('#procFull tr').first().waitFor({ timeout: 10000 });
  assert.ok(await page.locator('#processDiffDetails .process-diff-stat').count() >= 4);
  const observedAt = await page.evaluate(() => window.missionProcessDiff?.observed_at || 0);
  await page.waitForFunction(previous => (window.missionProcessDiff?.observed_at || 0) > previous, observedAt, { timeout: 8000 });
  const processMutations = await page.evaluate(async () => {
    const body = document.getElementById('procFull');
    let count = 0;
    const observer = new MutationObserver(records => { count += records.length; });
    observer.observe(body, { childList: true, subtree: true, characterData: true, attributes: true });
    await new Promise(resolve => setTimeout(resolve, 2500));
    observer.disconnect();
    return count;
  });
  assert.equal(processMutations, 0, 'routine mission-state updates rebuilt the process table');
  await assertNoOverflow(page, 'desktop processes');

  await page.locator('.nav-btn[data-page="timeline"]').click();
  await page.locator('[data-timeline-view="chronological"]').click();
  assert.equal(await page.locator('[data-timeline-view="chronological"]').getAttribute('aria-pressed'), 'true');
  await page.locator('[data-timeline-view="causal"]').click();
  assert.equal(await page.locator('[data-timeline-view="causal"]').getAttribute('aria-pressed'), 'true');
  await assertNoOverflow(page, 'desktop timeline');

  assert.deepEqual(diagnostics.mutations, [], `Mission Control triggered mutation requests: ${diagnostics.mutations.join(', ')}`);
  assert.deepEqual(diagnostics.errors, [], `Browser errors: ${diagnostics.errors.join(' | ')}`);
  await context.close();
}

async function testMobile(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    httpCredentials: { username, password },
  });
  const page = await context.newPage();
  const diagnostics = collectDiagnostics(page);

  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await waitForMission(page);
  for (const pageName of ['dashboard', 'processes', 'timeline', 'files', 'uptime']) {
    await page.locator(`.nav-btn[data-page="${pageName}"]`).click();
    await page.waitForTimeout(250);
    await assertNoOverflow(page, `mobile ${pageName}`);
  }

  await page.locator('.nav-btn[data-page="dashboard"]').click();
  const opener = page.locator('[data-mission-why="ram"]').first();
  await opener.click();
  await page.locator('#missionWhyLayer:not([hidden])').waitFor();
  const drawerBox = await page.locator('#missionWhyDrawer').boundingBox();
  assert.ok(drawerBox && drawerBox.width <= 390 && drawerBox.height <= 844, 'mobile explanation sheet exceeds the viewport');
  await page.keyboard.press('Escape');

  assert.deepEqual(diagnostics.mutations, [], `Mobile Mission Control triggered mutation requests: ${diagnostics.mutations.join(', ')}`);
  assert.deepEqual(diagnostics.errors, [], `Mobile browser errors: ${diagnostics.errors.join(' | ')}`);
  await context.close();
}

async function testHostileText(browser) {
  const hostile = '<img src=x onerror="window.__xss=1">';
  const initialGeneratedAt = Date.now();
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    httpCredentials: { username, password },
  });
  const page = await context.newPage();

  await page.route('**/socket.io/socket.io.js*', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      window.__socketHandlers = {};
      window.__emitSocket = (name, payload) => (window.__socketHandlers[name] || []).forEach(handler => handler(payload));
      window.io = () => {
        const socket = {
          auth: {},
          on(name, handler) {
            (window.__socketHandlers[name] ||= []).push(handler);
            return socket;
          },
          connect() { return socket; },
          emit() { return socket; }
        };
        return socket;
      };
    `,
  }));
  await page.route('**/api/mission-control', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      schema_version: 1,
      boot_id: 'boot-old',
      revision: 999,
      generated_at: initialGeneratedAt,
      incident_since: initialGeneratedAt - 10000,
      level: 'incident',
      status_label: 'Incident',
      weather: 'Test',
      headline: hostile,
      summary: hostile,
      recommendation: hostile,
      telemetry_age_ms: 0,
      metrics: { cpu: 91, ram: 40, disk: 30 },
      inactive_services: [],
      primary_signal: { key: 'cpu' },
      process_diff: { baseline: false, scope: 'top-process-sample', counts: {}, entered: [{ pid: 7, name: hostile }], left: [], cpu_spikes: [], memory_spikes: [] },
      causal_events: [
        { id: 1, ts: Math.floor(Date.now() / 1000) - 1, phase: 'change', correlation_id: 'action-test', title: hostile, detail: hostile },
        { id: 2, ts: Math.floor(Date.now() / 1000), phase: 'recovery', correlation_id: 'action-test', title: 'Recovered', detail: hostile },
      ],
      explanations: {
        cpu: { title: hostile, summary: hostile, confidence: 0.5, evidence: [{ label: hostile, value: hostile, tone: 'incident' }], next_checks: [] },
      },
    }),
  }));

  await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await waitForMission(page);
  const causalCount = await page.locator('#missionCausalEvents > li').count();
  await page.evaluate(() => {
    const snapshot = window.missionControlSnapshot;
    window.__emitSocket('mission-state', {
      ...snapshot,
      revision: snapshot.revision + 1,
      generated_at: snapshot.generated_at + 1,
    });
  });
  assert.equal(await page.locator('#missionCausalEvents > li').count(), causalCount);
  await page.locator('.nav-btn[data-page="timeline"]').click();
  await page.locator('.timeline-correlation-chain').first().waitFor();
  assert.equal(await page.locator('.timeline-correlation-chain').count(), 1);
  await page.locator('.nav-btn[data-page="dashboard"]').click();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#missionNow img, #missionWhyLayer img, #missionNow script, #missionWhyLayer script, #missionNow [onerror], #missionWhyLayer [onerror]').count(), 0);
  assert.ok((await page.locator('#missionNowTitle').textContent()).includes('<img'));
  await page.locator('[data-mission-why="cpu"]').first().click();
  assert.ok((await page.locator('#missionWhySummary').textContent()).includes('<img'));
  assert.equal(await page.evaluate(() => window.__xss), undefined);

  await page.evaluate(payload => {
    window.__emitSocket('services', {
      services: {
        ssh: { active: true, status: 'active' },
        nginx: { active: false, status: payload },
        fail2ban: { active: true, status: 'active' },
        _extra: { kernel: payload, uptime: payload, load: payload, last_apt_update: payload },
      },
      disk: {
        filesystems: [{ mount: payload, size: 100, used: 50, avail: 50, percent: 50 }],
        topDirs: [{ path: payload, size: payload }],
      },
    });
  }, hostile);
  assert.equal(await page.locator('#diskTable img, #dirsTable img, #servicesList img, #systemInfo img, #diskTable [onerror], #servicesList [onerror]').count(), 0);
  assert.ok((await page.locator('#systemInfo').textContent()).includes('<img'));
  assert.equal(await page.evaluate(() => window.__xss), undefined);

  await page.evaluate(generatedAt => {
    window.__emitSocket('mission-state', {
      schema_version: 1,
      boot_id: 'boot-new',
      revision: 1,
      generated_at: generatedAt,
      incident_since: generatedAt,
      level: 'healthy',
      status_label: 'Healthy',
      weather: 'Clear',
      headline: 'New server boot accepted',
      summary: 'Fresh state after restart',
      recommendation: 'No action required',
      telemetry_age_ms: 0,
      metrics: { cpu: 10, ram: 20, disk: 30 },
      inactive_services: [],
      unavailable_sources: [],
      primary_signal: null,
    });
  }, initialGeneratedAt + 10000);
  await page.waitForFunction(() => window.missionControlSnapshot?.boot_id === 'boot-new');
  await page.waitForTimeout(750);
  assert.equal(await page.evaluate(() => window.missionControlSnapshot?.boot_id), 'boot-new');
  assert.equal(await page.evaluate(() => window.missionControlSnapshot?.explanations), undefined);
  assert.equal(await page.locator('#missionCausalEvents').textContent(), 'No causal signals in the latest window.');
  assert.equal(await page.locator('#missionNowTitle').textContent(), 'New server boot accepted');
  await context.close();
}

const browser = await chromium.launch({ headless: true });
try {
  await testDesktop(browser);
  await testMobile(browser);
  await testHostileText(browser);
  console.log('Mission Control browser regression passed');
} finally {
  await browser.close();
}
