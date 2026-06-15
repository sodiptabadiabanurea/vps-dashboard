import { chromium } from 'playwright';
import fs from 'fs';

const DOCS_DIR = '/home/dipta/vps-dashboard/docs';
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  httpCredentials: { username: 'admin', password: 'changeme' }
});

const page = await context.newPage();

// Main dashboard
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${DOCS_DIR}/dashboard-main.png` });
console.log('✅ Screenshot 1: main dashboard');

// Charts
await page.click('[data-page="charts"]');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DOCS_DIR}/dashboard-charts.png` });
console.log('✅ Screenshot 2: charts');

// Tools
await page.click('[data-page="tools"]');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DOCS_DIR}/dashboard-tools.png` });
console.log('✅ Screenshot 3: tools');

// Security
await page.click('[data-page="security"]');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DOCS_DIR}/dashboard-security.png` });
console.log('✅ Screenshot 4: security');

// Logs
await page.click('[data-page="logs"]');
await page.waitForTimeout(2000);
await page.screenshot({ path: `${DOCS_DIR}/dashboard-logs.png` });
console.log('✅ Screenshot 5: logs');

await browser.close();
console.log('\nAll screenshots saved to', DOCS_DIR);
