import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function card(tool, input, extras = '', options = {}) {
  const prefix = tool === 'traceroute' ? 'trace' : tool === 'portscan' ? 'port' : tool;
  const className = options.className ? ` ${options.className}` : '';
  return `<section class="tool-box${className}" data-tool-card="${tool}" ${options.attributes || ''}>
    <div class="tool-input-row">
      <input id="${input}" class="search-input">
      ${extras}
      <button id="${prefix}Run" type="button">Run</button>
      <button id="${prefix}Cancel" type="button" hidden>Cancel</button>
    </div>
    <div class="tool-run-state" id="${prefix}State" data-state="idle"><span id="${prefix}Badge">Ready</span><span id="${prefix}Meta"></span></div>
    <p id="${prefix}Summary"></p><pre id="${prefix}Result" class="tool-output"></pre>
    ${options.footer || ''}
  </section>`;
}

async function setupPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  await page.setContent(`<!doctype html><body><div class="tool-grid">
    ${card('diagnose', 'diagnoseHost', '<input id="diagnoseTrace" type="checkbox">', {
      className: 'tool-box-wide network-diagnosis',
      attributes: 'data-recommended="true"',
      footer: '<ol id="diagnoseStages"></ol>',
    })}
    ${card('ping', 'pingHost', '<select id="pingCount"><option value="3">3</option></select>', {
      footer: '<div class="tool-followup" id="pingDiagnosisAction" hidden><p id="pingDiagnosisHint">Ping URL follow-up</p><button class="btn btn-ghost tool-diagnosis-link" type="button" data-send-to-diagnosis="ping" aria-describedby="pingDiagnosisHint">Use URL in Diagnosis</button></div>',
    })}
    ${card('traceroute', 'traceHost', '<select id="traceHops"><option value="12">12</option></select>', {
      footer: '<div class="tool-followup" id="traceDiagnosisAction" hidden><p id="traceDiagnosisHint">Trace URL follow-up</p><button class="btn btn-ghost tool-diagnosis-link" type="button" data-send-to-diagnosis="traceroute" aria-describedby="traceDiagnosisHint">Use URL in Diagnosis</button></div>',
    })}
    ${card('dns', 'dnsHost', '<select id="dnsType"><option value="A">A</option></select>')}
    ${card('portscan', 'portHost', '<input id="portList" class="search-input tool-port-input" value="22,80">')}
  </div><div id="sslCerts"></div><div id="cronJobs"></div><div id="backupList"></div></body>`);
  await page.addStyleTag({ path: path.join(root, 'public/css/main.css') });
  await page.evaluate(() => {
    window.__calls = [];
    window.__activeIntervals = new Set();
    const nativeSetInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = (...args) => {
      const interval = nativeSetInterval(...args);
      window.__activeIntervals.add(interval);
      return interval;
    };
    window.clearInterval = interval => {
      window.__activeIntervals.delete(interval);
      return nativeClearInterval(interval);
    };
    window.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      let body = null;
      try { body = options.body ? JSON.parse(options.body) : null; } catch (_) {}
      const call = { url: String(url), aborted: false, body };
      window.__calls.push(call);
      const isTrace = call.url.includes('/trace');
      const isPing = call.url.includes('/ping');
      const isDns = call.url.includes('/dns');
      const isDiagnose = call.url.includes('/diagnose');
      const delay = isTrace && body?.target === '127.0.0.1'
        ? 5000
        : isPing ? 250 : isDns && window.__calls.filter(item => item.url.includes('/dns')).length === 1 ? 120 : 35;
      const timer = setTimeout(() => {
        const payload = isDiagnose
          ? {
              ok: true,
              duration_ms: delay,
              output: 'diagnosis evidence',
              diagnosis: { code: 'REACHABLE_ICMP_FILTERED', severity: 'healthy', summary: 'Web is reachable.' },
              stages: ['dns', 'tcp', 'tls', 'http', 'icmp', 'trace'].map(id => ({ id, state: id === 'icmp' ? 'warn' : id === 'trace' ? 'skipped' : 'pass', code: `<${id}>`, summary: `<img src=x onerror=1> ${id}` })),
            }
          : isTrace
          ? {
              ok: true,
              duration_ms: delay,
              output: 'trace output',
              data: { provider: 'mtr', transport: 'tcp', port: 443 },
              diagnosis: { code: 'TRACE_REACHED', severity: 'healthy', summary: 'Destination reached.' },
            }
          : isDns
          ? { ok: true, duration_ms: delay, result: ['203.0.113.7'], diagnosis: { code: 'ANSWER', severity: 'healthy', summary: '<img src=x onerror=1>' } }
          : { ok: true, duration_ms: delay, output: 'diagnostic output', warnings: isPing ? ['URL_NORMALIZED_TO_HOST', 'URL_PATH_IGNORED'] : [], diagnosis: { code: 'REACHABLE', severity: 'healthy', summary: 'Target reachable.' } };
        resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }, delay);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        call.aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  });
  await page.addScriptTag({ path: path.join(root, 'public/js/tools.js') });
  return page;
}

const browser = await chromium.launch({ headless: true });
try {
  const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
  const diagnosisPosition = indexHtml.indexOf('data-tool-card="diagnose"');
  const pingPosition = indexHtml.indexOf('data-tool-card="ping"');
  assert.ok(diagnosisPosition >= 0 && diagnosisPosition < pingPosition, 'Unified Diagnosis is not the first Network Tools path');
  assert.match(indexHtml, /data-tool-card="diagnose" data-recommended="true"/);
  assert.match(indexHtml, /Start here for URLs/);

  const page = await setupPage(browser, { width: 1440, height: 900 });
  assert.equal(await page.locator('[data-tool-card]').first().getAttribute('data-tool-card'), 'diagnose');
  assert.equal(await page.locator('[data-tool-card="diagnose"]').getAttribute('data-recommended'), 'true');
  await page.fill('#pingHost', '127.0.0.1');
  await page.click('#pingRun');
  assert.equal(await page.locator('#pingRun').isDisabled(), true);
  assert.equal(await page.locator('#pingCancel').isVisible(), true);
  assert.equal(await page.locator('#pingState').getAttribute('data-state'), 'running');
  await page.waitForFunction(() => document.getElementById('pingState')?.dataset.state === 'success');
  assert.equal(await page.locator('#pingRun').isDisabled(), false);
  assert.equal(await page.locator('#pingResult').textContent(), 'diagnostic output');
  assert.match(await page.locator('#pingSummary').textContent(), /normalized to its hostname/i);
  assert.match(await page.locator('#pingSummary').textContent(), /path, query, and fragment were ignored/i);

  const urlTarget = 'https://example.com/<img src=x onerror=1>';
  await page.fill('#pingHost', urlTarget);
  await page.click('#pingRun');
  await page.waitForFunction(() => document.getElementById('pingState')?.dataset.state === 'success');
  assert.equal(await page.locator('#pingDiagnosisAction').isVisible(), true);
  const diagnoseCallsBeforeHandoff = await page.evaluate(() => window.__calls.filter(call => call.url.includes('/diagnose')).length);
  await page.click('#pingDiagnosisAction [data-send-to-diagnosis]');
  await page.waitForFunction(() => document.activeElement?.id === 'diagnoseHost');
  assert.equal(await page.locator('#diagnoseHost').inputValue(), urlTarget);
  assert.equal(await page.locator('[data-tool-card="diagnose"]').getAttribute('data-prepared'), 'true');
  assert.match(await page.locator('#diagnoseSummary').textContent(), /run the diagnosis explicitly/i);
  assert.equal(await page.locator('[data-tool-card="diagnose"] img, [data-tool-card="diagnose"] [onerror]').count(), 0);
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.url.includes('/diagnose')).length), diagnoseCallsBeforeHandoff);
  await page.click('#diagnoseRun');
  await page.waitForFunction(() => document.getElementById('diagnoseState')?.dataset.state === 'success');
  assert.equal(await page.evaluate(() => window.__calls.find(call => call.url.includes('/diagnose'))?.body?.target), urlTarget);

  await page.fill('#traceHost', '127.0.0.1');
  await page.click('#traceRun');
  await page.click('#traceCancel');
  await page.waitForFunction(() => document.getElementById('traceState')?.dataset.state === 'cancelled');
  assert.equal(await page.locator('#traceRun').isDisabled(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'traceRun');
  assert.equal(await page.evaluate(() => window.__calls.some(call => call.url.includes('/trace') && call.aborted)), true);

  await page.fill('#traceHost', 'https://trace.example/path');
  await page.click('#traceRun');
  await page.waitForFunction(() => document.getElementById('traceState')?.dataset.state === 'success');
  assert.match(await page.locator('#traceMeta').textContent(), /mtr/i);
  assert.match(await page.locator('#traceMeta').textContent(), /TCP 443/);
  assert.match(await page.locator('#traceResult').textContent(), /^Trace mode: mtr .* TCP 443/m);
  assert.equal(await page.locator('#traceDiagnosisAction').isVisible(), true);
  const diagnoseCallsBeforeTraceHandoff = await page.evaluate(() => window.__calls.filter(call => call.url.includes('/diagnose')).length);
  await page.click('#traceDiagnosisAction [data-send-to-diagnosis]');
  await page.waitForFunction(() => document.activeElement?.id === 'diagnoseHost');
  assert.equal(await page.locator('#diagnoseHost').inputValue(), 'https://trace.example/path');
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.url.includes('/diagnose')).length), diagnoseCallsBeforeTraceHandoff);

  await page.fill('#dnsHost', 'example.com');
  await page.evaluate(() => { window.runDns(); window.runDns(); });
  await page.waitForFunction(() => document.getElementById('dnsState')?.dataset.state === 'success');
  assert.equal(await page.locator('#dnsResult').textContent(), '203.0.113.7');
  assert.equal(await page.locator('#dnsSummary img').count(), 0);
  assert.ok((await page.locator('#dnsSummary').textContent()).includes('<img'));
  assert.equal(await page.evaluate(() => window.__calls.filter(call => call.url.includes('/dns') && call.aborted).length), 1);
  assert.equal(await page.evaluate(() => window.__activeIntervals.size), 0);

  await page.fill('#diagnoseHost', 'example.com');
  await page.click('#diagnoseRun');
  await page.waitForFunction(() => document.getElementById('diagnoseState')?.dataset.state === 'success');
  assert.equal(await page.locator('#diagnoseStages > li').count(), 6);
  assert.equal(await page.locator('#diagnoseStages img, #diagnoseStages [onerror]').count(), 0);
  assert.ok((await page.locator('#diagnoseStages').textContent()).includes('<img'));

  const mobile = await setupPage(browser, { width: 390, height: 844 });
  await mobile.fill('#pingHost', 'https://mobile.example/path');
  await mobile.click('#pingRun');
  await mobile.waitForFunction(() => document.getElementById('pingState')?.dataset.state === 'success');
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert.equal(overflow, false);
  for (const selector of ['#pingHost', '#traceHost', '#dnsHost', '#portHost', '#portList', '#diagnoseHost']) {
    const box = await mobile.locator(selector).boundingBox();
    assert.ok(box && box.height >= 44, `${selector} is shorter than the 44px mobile touch target`);
  }
  const followupBox = await mobile.locator('#pingDiagnosisAction [data-send-to-diagnosis]').boundingBox();
  assert.ok(followupBox && followupBox.height >= 44, 'Diagnosis follow-up is shorter than the 44px mobile touch target');
  await mobile.close();
  await page.close();
  console.log('Network Tools browser regression passed');
} finally {
  await browser.close();
}
