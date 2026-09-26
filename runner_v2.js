const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── PATHS ───
const CONFIG_PATH = path.join(__dirname, 'config.json');
const WALLETS_PATH = path.join(__dirname, 'wallets.json');
const LOG_PATH = path.join(__dirname, 'farm.log');
const STATE_PATH = path.join(__dirname, 'state.json');

// ─── STATE ───
let state = {
  totalClaims: 0, totalEarnings: 0, totalClaimedCoins: {},
  lastClaims: {}, errors: [], runCount: 0, lastCycle: null,
  startedAt: new Date().toISOString()
};
function loadState() {
  try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))); } catch (e) {}
}
function saveState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) {}
}
loadState();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}
function randDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── HEALTHCHECK (STARTS IMMEDIATELY - no deps needed) ───
const HEALTH_PORT = parseInt(process.env.PORT) || 8080;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url === '/stats') {
    return res.end(JSON.stringify({
      totalClaims: state.totalClaims,
      claimedCoins: state.totalClaimedCoins,
      lastCycle: state.lastCycle,
      uptime: process.uptime()
    }));
  }
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), claims: state.totalClaims }));
}).listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`🌐 Healthcheck @ :${HEALTH_PORT}`);
});

// ─── CONFIG ───
const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const expandEnv = (obj) => {
  if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] || '');
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj && typeof obj === 'object') { const r = {}; for (const [k, v] of Object.entries(obj)) r[k] = expandEnv(v); return r; }
  return obj;
};
const config = expandEnv(rawConfig);
const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8'));

log('🚀 FAUCET FARM v2 initialized!');
log(`📊 Resume: ${state.totalClaims} claims total`);

// ─── OPTIONAL BROWSER ───
let chromium = null;
async function getBrowser() {
  if (chromium) return chromium;
  try {
    const pw = require('playwright');
    chromium = pw.chromium;
    return chromium;
  } catch (e) {
    log('⚠️ Playwright not available - browser claims disabled');
    return null;
  }
}

// ─── FAUCETPAY API ───
async function claimFaucetPayAPI() {
  // Get API key from environment variable
  const apiKey = process.env.FAUCETPAY_API_KEY || '';
  if (!apiKey) {
    log('⚠️ FAUCETPAY_API_KEY not set - skipping FaucetPay API claims');
    return 0;
  }
  let claimed = 0;
  const coins = ['BTC', 'LTC', 'DOGE', 'TRX', 'USDT', 'SOL', 'BNB', 'ETH', 'TON', 'BCH', 'DASH', 'XRP', 'ADA'];
  for (const coin of coins) {
    const k = 'fp_' + coin;
    if ((Date.now() - (state.lastClaims[k] || 0)) < 3600000) continue;
    try {
      const addr = wallets[coin] || wallets.BTC;
      const resp = await fetch(`https://faucetpay.io/api/v1/claim?api_key=${apiKey}&coin=${coin}&address=${addr}`);
      const d = await resp.json();
      if (d.success) {
        log(`💰 FaucetPay ${coin}: ${d.amount || '?'}`);
        state.lastClaims[k] = Date.now();
        state.totalClaimedCoins[coin] = (state.totalClaimedCoins[coin] || 0) + parseFloat(d.amount || 0);
        claimed++;
      } else { log(`⏰ FaucetPay ${coin}: ${d.message || '?'}`); }
    } catch (e) { /* skip */ }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── BROWSER CLAIMS ───
async function claimBrowser(faucet) {
  const browser = await getBrowser();
  if (!browser) return false;
  
  try {
    const ctx = await browser.launchPersistentContext('/tmp/profile', {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await ctx.newPage();
    
    // Navigate to faucet
    await page.goto(faucet.url, { timeout: 30000 });
    
    // Wait for main content
    await page.waitForTimeout(2000);
    
    // Try to find and click claim button
    const claimBtn = await page.$('[data-testid="claim-button"], button:has-text("Claim"), .claim-btn, input[type="submit"][value*="Claim"]');
    
    if (claimBtn) {
      await claimBtn.click();
      await page.waitForTimeout(2000);
      
      // Check for success message
      const success = await page.$('[class*="success"], [class*="congratulations"]');
      
      if (success) {
        log(`✅ Browser claim: ${faucet.name}`);
        state.lastClaims['br_' + faucet.name] = Date.now();
        await ctx.close();
        return true;
      }
    }
    
    await ctx.close();
    return false;
  } catch (e) {
    log(`❌ Browser claim failed: ${e.message}`);
    return false;
  }
}

// ─── MAIN CYCLE ───
async function runCycle() {
  state.runCount++;
  log(`\n🔄 Cycle #${state.runCount}`);
  
  try {
    // API claims
    const apiClaimed = await claimFaucetPayAPI();
    state.totalClaims += apiClaimed;
    
    // Browser claims
    let browserClaimed = 0;
    for (const faucet of config.browserFaucets || []) {
      const claimed = await claimBrowser(faucet);
      if (claimed) browserClaimed++;
      await sleep(randDelay(5000, 10000));
    }
    state.totalClaims += browserClaimed;
    
    // Log cycle summary
    state.lastCycle = new Date().toISOString();
    log(`📈 Cycle complete: +${apiClaimed + browserClaimed} claims (total: ${state.totalClaims})`);
    saveState();
    
  } catch (e) {
    log(`❌ Cycle error: ${e.message}`);
    state.errors.push({ time: new Date().toISOString(), error: e.message });
    saveState();
  }
}

// ─── SCHEDULER ───
const INTERVAL = (config.claimIntervalMinutes || 30) * 60 * 1000;
log(`⏱️ Auto-claim every ${config.claimIntervalMinutes || 30} minutes`);

// Run first cycle immediately
runCycle();

// Then run on schedule
setInterval(runCycle, INTERVAL);

log('✅ FAUCET FARM running - PID: ' + process.pid);

