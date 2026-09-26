/**
 * 🧠 FAUCET FARM v2 — Supercharged Edition
 * Auto-claimer + faucet discovery + captcha bypass
 * Deploy on Railway or any Node server with Chromium
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ─── RAILWAY HEALTHCHECK ───
const HEALTH_PORT = parseInt(process.env.PORT) || 8080;
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      uptime: process.uptime(), 
      totalClaims: state?.totalClaims || 0,
      lastCycle: state?.lastCycle || null
    }));
  } else if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      totalClaims: state?.totalClaims || 0,
      claimedCoins: state?.totalClaimedCoins || {},
      lastClaims: state?.lastClaims || {},
      errors: state?.errors?.slice(-5) || [],
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404); res.end();
  }
});
server.listen(HEALTH_PORT, '0.0.0.0', () => {
  console.log(`🌐 Healthcheck server on port ${HEALTH_PORT}`);
});

// ─── PATHS ───
const CONFIG_PATH = path.join(__dirname, 'config.json');
const WALLETS_PATH = path.join(__dirname, 'wallets.json');
const LOG_PATH = path.join(__dirname, 'farm.log');
const STATE_PATH = path.join(__dirname, 'state.json');
const DISCOVERY_PATH = path.join(__dirname, 'discovered.json');

const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Expand env var placeholders in config recursively
function expandEnv(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || '');
  }
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[k] = expandEnv(v);
    return result;
  }
  return obj;
}
const config = expandEnv(rawConfig);

const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8'));

let state = {
  lastClaims: {},
  totalClaims: 0,
  totalClaimedCoins: {},
  errors: [],
  stats: { today: 0, week: 0, month: 0 },
  startedAt: new Date().toISOString()
};

function loadState() {
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

function randDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getWallet(type, coin) {
  return wallets[coin] || wallets.BTC;
}

function truncAddr(addr) {
  return addr ? addr.slice(0, 8) + '...' + addr.slice(-6) : 'N/A';
}

// ─── 2CAPTCHA SOLVER ───
async function solveCaptcha2Captcha(page, siteKey, pageUrl) {
  const apiKey = config.captcha?.twocaptcha_key;
  if (!apiKey) return null;
  
  try {
    const resp = await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${pageUrl}&json=1`);
    const data = await resp.json();
    if (data.status !== 1) { log(`⚠️ 2captcha in.php failed: ${data.request}`); return null; }
    
    const captchaId = data.request;
    log(`⏳ 2captcha solving... ID: ${captchaId}`);
    
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const pollResp = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`);
      const pollData = await pollResp.json();
      if (pollData.status === 1) {
        log(`✅ 2captcha solved!`);
        return pollData.request;
      }
      if (pollData.request === 'ERROR_CAPTCHA_UNSOLVABLE') {
        log('⚠️ 2captcha unsolvable');
        return null;
      }
    }
    return null;
  } catch (e) {
    log(`❌ 2captcha error: ${e.message}`);
    return null;
  }
}

// ─── FAUCET CLAIMERS ───

// --- FaucetPay.io API (centralized claimer for 50+ coins) ---
async function claimFaucetPayAPI() {
  const apiKey = config.faucetpay_api_key;
  if (!apiKey) { log('⚠️ No FaucetPay API key, skipping'); return 0; }
  
  let claimed = 0;
  const coins = ['BTC', 'LTC', 'DOGE', 'TRX', 'USDT', 'SOL', 'BNB', 'ETH', 'TON', 'BCH', 'DASH', 'XRP', 'ADA'];
  
  for (const coin of coins) {
    const key = `faucetpay_${coin}`;
    const lastClaim = state.lastClaims[key] || 0;
    if ((Date.now() - lastClaim) < 3600000) continue;
    
    try {
      const resp = await fetch(`https://faucetpay.io/api/v1/claim?api_key=${apiKey}&coin=${coin}&address=${wallets[coin] || wallets.BTC}`);
      const data = await resp.json();
      if (data.success) {
        log(`💰 FaucetPay ${coin}: claimed ${data.amount} — balance: ${data.balance}`);
        state.lastClaims[key] = Date.now();
        state.totalClaimedCoins[coin] = (state.totalClaimedCoins[coin] || 0) + parseFloat(data.amount || 0);
        claimed++;
      } else {
        log(`⏰ FaucetPay ${coin}: ${data.message || 'not ready'}`);
      }
      await sleep(randDelay(2000, 5000));
    } catch (e) {
      log(`❌ FaucetPay ${coin}: ${e.message}`);
    }
  }
  return claimed;
}

// --- Allcoins.pw (BTC/DOGE/LTC faucet) ---
async function claimAllcoins(page, coin) {
  const addr = getWallet('allcoins', coin);
  log(`🎰 Allcoins ${coin} > ${truncAddr(addr)}`);
  try {
    await page.goto(`https://allcoins.pw/${coin.toLowerCase()}/`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const addrInput = await page.$('input[name="address"], input[placeholder*="address" i]');
    if (addrInput) await addrInput.fill(addr);
    await sleep(500);
    const claimBtn = await page.$('button:has-text("Claim"), button[type="submit"]');
    if (claimBtn) await claimBtn.click();
    await sleep(5000);
    log(`✅ Allcoins ${coin}: done`);
    return true;
  } catch (e) { log(`❌ Allcoins ${coin}: ${e.message}`); return false; }
}

// --- Moon Bitcoin / Litecoin / Doge ---
async function claimMoonFaucet(page, coin) {
  const domain = { BTC: 'moonbitcoin', LTC: 'moonlitecoin', DOGE: 'moondoge' }[coin];
  if (!domain) return false;
  const addr = getWallet('moon', coin);
  log(`🎰 ${domain} ${coin} > ${truncAddr(addr)}`);
  try {
    await page.goto(`https://${domain}.cash/`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(5000);
    const freeBtn = await page.$('a:has-text("Free"), button:has-text("Free"), .free-btn');
    if (freeBtn) await freeBtn.click();
    await sleep(3000);
    const addrInput = await page.$('input[placeholder*="Bitcoin"], input[placeholder*="address"], input[name="address"]');
    if (addrInput) await addrInput.fill(addr);
    await sleep(500);
    const startBtn = await page.$('button:has-text("Start"), a:has-text("Start"), input[value*="Start"]');
    if (startBtn) { await startBtn.click(); await sleep(10000); }
    log(`✅ ${domain}: done`);
    return true;
  } catch (e) { log(`❌ ${domain}: ${e.message}`); return false; }
}

// --- BonusBitcoin ---
async function claimBonusBitcoin(page) {
  const addr = wallets.BTC;
  log(`🎰 BonusBitcoin > ${truncAddr(addr)}`);
  try {
    await page.goto('https://bonusbitcoin.co', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const addrInput = await page.$('#btc_address, input[name="address"], input[placeholder*="address"]');
    if (addrInput) await addrInput.fill(addr);
    await sleep(1000);
    const claimBtn = await page.$('button:has-text("Claim"), a:has-text("Claim")');
    if (claimBtn) await claimBtn.click();
    await sleep(5000);
    log('✅ BonusBitcoin: done');
    return true;
  } catch (e) { log(`❌ BonusBitcoin: ${e.message}`); return false; }
}

// --- Pick.io (one coin per call) ---
async function claimPickIo(page, coin) {
  const addr = wallets[coin.toUpperCase()] || wallets.BTC;
  log(`🎯 Pick.io/${coin} > ${truncAddr(addr)}`);
  try {
    await page.goto(`https://pick.io/${coin.toLowerCase()}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const addrInput = await page.$('input[placeholder*="wallet"], input[placeholder*="address"], input[name="address"]');
    if (addrInput) await addrInput.fill(addr);
    await sleep(500);
    const claimBtn = await page.$('button:has-text("Claim"), button[type="submit"]');
    if (claimBtn) await claimBtn.click();
    await sleep(5000);
    log(`✅ Pick.io/${coin}: done`);
    return true;
  } catch (e) { log(`❌ Pick.io/${coin}: ${e.message}`); return false; }
}

// --- BeeFaucet (multi-coin) ---
async function claimBeeFaucet(page) {
  const beecfg = config.faucets.beefaucet;
  if (!beecfg?.enabled) return 0;
  let claimed = 0;
  for (const coin of beecfg.coins) {
    const addr = wallets[coin.toUpperCase()] || wallets.BTC;
    log(`🐝 BeeFaucet ${coin} > ${truncAddr(addr)}`);
    try {
      const url = `https://beefaucet.org/${coin}-faucet/?r=${wallets[coin.toUpperCase()] || wallets.BTC}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(3000);
      const claimBtn = await page.$('button:has-text("Claim"), a:has-text("Claim")');
      if (claimBtn) { await claimBtn.click(); await sleep(5000); }
      log(`✅ BeeFaucet ${coin}: done`);
      claimed++;
    } catch (e) { log(`❌ BeeFaucet ${coin}: ${e.message}`); }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// --- Freebitco.in, FaucetCrypto, etc (existing code) ---
async function claimBrowserFaucet(page, faucetId) {
  const fc = config.faucets[faucetId];
  if (!fc?.enabled) return false;
  
  const addr = wallets[fc.coin] || wallets.BTC;
  log(`🌐 ${faucetId} > ${fc.url} > ${truncAddr(addr)}`);
  
  try {
    await page.goto(fc.url, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(5000);
    
    // Login if email/password provided
    if (fc.email && fc.email.includes('@')) {
      const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i]');
      if (emailInput) {
        await emailInput.fill(fc.email);
        const passInput = await page.$('input[type="password"]');
        if (passInput && fc.password) {
          await passInput.fill(fc.password);
          const loginBtn = await page.$('button:has-text("Login"), button:has-text("Sign in"), input[value*="Login"]');
          if (loginBtn) await loginBtn.click();
          await sleep(5000);
        }
      }
    }
    
    // Try to solve captcha
    const captchaFrame = await page.$('iframe[src*="recaptcha"], iframe[title*="recaptcha"]');
    if (captchaFrame) {
      const frame = await captchaFrame.contentFrame();
      if (frame) {
        const checkbox = await frame.$('.recaptcha-checkbox');
        if (checkbox) await checkbox.click();
        await sleep(2000);
      }
    }
    
    // Click main claim button
    const claimBtn = await page.$('button:has-text("Claim"), a:has-text("Claim"), button:has-text("Roll"), input[value*="Claim"]');
    if (claimBtn) await claimBtn.click();
    await sleep(5000);
    
    log(`✅ ${faucetId}: claim submitted`);
    state.totalClaims++;
    state.totalClaimedCoins[fc.coin] = (state.totalClaimedCoins[fc.coin] || 0) + 1;
    return true;
  } catch (e) {
    log(`❌ ${faucetId}: ${e.message}`);
    return false;
  }
}

// --- Auto-discover new faucets ---
async function autoDiscover() {
  log('🔍 Auto-discovering new faucets...');
  const sources = [
    'https://pick.io/faucets',
  ];
  
  try {
    const resp = await fetch(sources[0]);
    const html = await resp.text();
    const coins = [...html.matchAll(/\/([a-z]{2,5})\/faucet/g)].map(m => m[1].toUpperCase());
    const unique = [...new Set(coins)];
    
    if (unique.length > 0) {
      const discovered = {};
      if (fs.existsSync(DISCOVERY_PATH)) {
        Object.assign(discovered, JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8')));
      }
      
      for (const coin of unique) {
        const key = `pick_io_${coin.toLowerCase()}`;
        if (!config.faucets[key] && !discovered[key]) {
          discovered[key] = { coin, url: `https://pick.io/${coin.toLowerCase()}` };
          log(`🆕 Discovered: Pick.io/${coin}`);
        }
      }
      
      fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discovered, null, 2));
      log(`✅ Discovery done: ${Object.keys(discovered).length} known`);
    }
  } catch (e) {
    log(`❌ Discovery error: ${e.message}`);
  }
}

// --- Main cycle ---
async function runCycle() {
  log('🔄 Starting claim cycle...');
  let claims = 0;
  
  // 1. FaucetPay API (no browser needed)
  claims += await claimFaucetPayAPI();
  
  // 2. Launch browser for Playwright faucets
  const browser = await chromium.launch({
    headless: config.headless !== false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();
  
  try {
    // Pick.io faucets
    for (const [key, fc] of Object.entries(config.faucets)) {
      if (!key.startsWith('pick_io_') || !fc.enabled) continue;
      const coin = fc.coin || key.replace('pick_io_', '');
      const lk = `pick_io_${coin.toLowerCase()}`;
      if ((Date.now() - (state.lastClaims[lk] || 0)) < 3600000) continue;
      
      if (await claimPickIo(page, coin.toLowerCase())) {
        claims++;
        state.lastClaims[lk] = Date.now();
      }
      await sleep(randDelay(3000, 8000));
    }
    
    // Freebitco.in
    if ((Date.now() - (state.lastClaims['freebitco_in'] || 0)) > 3600000) {
      if (await claimBrowserFaucet(page, 'freebitco_in')) {
        claims++;
        state.lastClaims['freebitco_in'] = Date.now();
      }
    }
    
    // FaucetCrypto
    if ((Date.now() - (state.lastClaims['faucetcrypto'] || 0)) > 2400000) {
      if (await claimBrowserFaucet(page, 'faucetcrypto')) {
        claims++;
        state.lastClaims['faucetcrypto'] = Date.now();
      }
    }
    
    // Moon faucets
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
      if (await claimMoonFaucet(page, coin)) claims++;
      await sleep(randDelay(3000, 8000));
    }
    
    // BonusBitcoin
    if (await claimBonusBitcoin(page)) claims++;
    await sleep(randDelay(3000, 8000));
    
    // Allcoins
    for (const coin of ['BTC', 'DOGE', 'LTC']) {
      if (await claimAllcoins(page, coin)) claims++;
      await sleep(randDelay(3000, 8000));
    }
    
    // BeeFaucet
    claims += await claimBeeFaucet(page);
    
    state.lastCycle = new Date().toISOString();
    state.runCount = (state.runCount || 0) + 1;
    state.lastRun = new Date().toISOString();
    saveState();

    log(`📊 Cycle done: ${claims} claims (total: ${state.totalClaims})`);

  } catch (e) {
    log(`💥 Cycle error: ${e.message}`);
  } finally {
    await browser.close();
  }
  return claims;
}

// ─── MAIN LOOP ───
async function main() {
  log('🚀 FAUCET FARM v2 starting...');
  loadState();
  
  // Auto-discover new faucets
  await autoDiscover();
  
  let cycle = 0;
  while (true) {
    cycle++;
    log(`\n═══ CYCLE ${cycle} ═══`);
    await runCycle();
    const wait = randDelay(1500000, 2100000); // 25-35 min
    log(`💤 Sleeping ${Math.round(wait / 60000)}min...\n`);
    await sleep(wait);
  }
}

// Run
if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
