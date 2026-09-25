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
const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8')).wallets;

// ─── STATE ───
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
  // Update rolling stats
  const today = new Date().toDateString();
  if (state.statsDate !== today) {
    state.stats = { today: 0, week: state.stats?.week || 0, month: state.stats?.month || 0 };
    state.statsDate = today;
  }
  state.stats.today = Object.keys(state.lastClaims).length;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randDelay(min, max) { return Math.floor(min + Math.random() * (max - min)); }
function truncAddr(addr) { return addr ? addr.substring(0, 10) + '...' : 'N/A'; }

// ====== 2CAPTCHA INTEGRATION (bypass captchas automatically) ======
async function solveCaptcha2Captcha(page, siteKey, pageUrl) {
  const apiKey = config.captcha?.twocaptcha_key;
  if (!apiKey) return null;
  
  try {
    // Get the g-recaptcha-response by submitting to 2captcha
    const resp = await fetch(`https://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${pageUrl}&json=1`);
    const data = await resp.json();
    if (data.status !== 1) { log(`⚠️ 2captcha in.php failed: ${data.request}`); return null; }
    
    const captchaId = data.request;
    log(`⏳ 2captcha solving... ID: ${captchaId}`);
    
    // Poll for solution
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const pollResp = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${captchaId}&json=1`);
      const pollData = await pollResp.json();
      if (pollData.status === 1) {
        log(`✅ 2captcha solved!`);
        return pollData.request;
      }
    }
  } catch (e) {
    log(`❌ 2captcha error: ${e.message}`);
  }
  return null;
}

// ====== CAPTCHA DETECTION & BYPASS ======
async function detectAndSolveCaptcha(page) {
  // Check for reCAPTCHA v2 iframe
  const recaptchaFrame = await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"]').catch(() => null);
  if (recaptchaFrame) {
    log('🔍 Captcha detected!');
    
    // Try clicking through (sometimes it's just a checkbox)
    const captchaCheckbox = await page.$('.recaptcha-checkbox, #recaptcha-anchor, [class*="hcaptcha"]').catch(() => null);
    if (captchaCheckbox) {
      await captchaCheckbox.click();
      await sleep(2000);
      // Check if solved
      const checked = await page.$('.recaptcha-checkbox-checked, [aria-checked="true"]').catch(() => null);
      if (checked) { log('✅ Captcha checkbox clicked!'); return true; }
    }
    
    // Try 2captcha if configured
    const siteKey = await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      return el ? el.getAttribute('data-sitekey') : null;
    }).catch(() => null);
    
    if (siteKey && config.captcha?.twocaptcha_key) {
      const token = await solveCaptcha2Captcha(page, siteKey, page.url());
      if (token) {
        await page.evaluate((t) => {
          document.getElementById('g-recaptcha-response')?.remove();
          const ta = document.createElement('textarea');
          ta.id = 'g-recaptcha-response';
          ta.textContent = t;
          ta.style.display = 'none';
          document.body.appendChild(ta);
        }, token);
        
        // Trigger callback
        await page.evaluate(() => {
          const callback = document.querySelector('[data-callback]')?.getAttribute('data-callback');
          if (callback && window[callback]) window[callback]();
        });
        await sleep(1000);
        return true;
      }
    }
    
    // Last resort: try to wait for auto-solve
    log('⚠️ Captcha not auto-solved, waiting 10s...');
    await sleep(10000);
    return false;
  }
  return false; // No captcha detected
}

// ====== TOR IP ROTATION ======
async function rotateTorIP() {
  try {
    const { execSync } = require('child_process');
    execSync('kill -HUP $(cat /var/run/tor/tor.pid 2>/dev/null || pgrep -f "tor --") 2>/dev/null', { timeout: 5000 });
    await sleep(3000);
    log('🔄 Tor circuit rotated');
  } catch (e) {
    log('⚠️ Tor rotation failed: ' + e.message);
  }
}

// ====== BROWSER ======
async function createBrowser() {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars', '--disable-dev-shm-usage',
  ];
  if (config.use_tor) args.push(`--proxy-server=${config.tor_proxy}`);

  const browser = await chromium.launch({
    headless: config.headless ?? true,
    args
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });
  return { browser, context };
}

// ====== WALLET MAPPER ======
function getWallet(site, coin) {
  const s = (site + '' + (coin || '')).toLowerCase();
  if (s.includes('btc')) return wallets.BTC;
  if (s.includes('eth') || s.includes('shib')) return wallets.ETH;
  if (s.includes('sol')) return wallets.SOL;
  if (s.includes('ltc')) return wallets.LTC;
  if (s.includes('doge')) return wallets.DOGE;
  if (s.includes('bnb')) return wallets.BNB;
  if (s.includes('trx') || s.includes('tron') || s.includes('usdt')) return wallets.TRX;
  if (s.includes('ton')) return wallets.TON;
  if (s.includes('ada') || s.includes('cardano')) return wallets.ADA;
  if (s.includes('bch')) return wallets.BCH;
  if (s.includes('dash')) return wallets.DASH;
  if (s.includes('xrp')) return wallets.XRP;
  return wallets.BTC; // fallback
}

// ====== HTTP-based claimer (lightweight, no browser) ======
async function httpClaim(url, options = {}) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

// ====== FAUCET CLAIMERS ======

// --- FaucetPay.io API (centralized claimer for 50+ coins) ---
async function claimFaucetPayAPI() {
  const apiKey = config.faucetpay_api_key;
  if (!apiKey) { log('⚠️ No FaucetPay API key, skipping'); return 0; }
  
  let claimed = 0;
  const coins = ['BTC', 'LTC', 'DOGE', 'TRX', 'USDT', 'SOL', 'BNB', 'ETH', 'TON', 'BCH', 'DASH', 'XRP', 'ADA'];
  
  for (const coin of coins) {
    const key = `faucetpay_${coin}`;
    const lastClaim = state.lastClaims[key] || 0;
    if ((Date.now() - lastClaim) < 3600000) continue; // 1h cooldown
    
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
  log(`🎰 Allcoins ${coin} → ${truncAddr(addr)}`);
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
  log(`🎰 ${domain} ${coin} → ${truncAddr(addr)}`);
  try {
    await page.goto(`https://${domain}.cash/`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(5000);
    // Click "Free" button
    const freeBtn = await page.$('a:has-text("Free"), button:has-text("Free"), .free-btn');
    if (freeBtn) await freeBtn.click();
    await sleep(3000);
    // Enter address and claim
    const addrInput = await page.$('input[placeholder*="Bitcoin"], input[placeholder*="address"], input[name="address"]');
    if (addrInput) await addrInput.fill(addr);
    await sleep(500);
    // Start mining/claiming
    const startBtn = await page.$('button:has-text("Start"), a:has-text("Start"), input[value*="Start"]');
    if (startBtn) { await startBtn.click(); await sleep(10000); }
    log(`✅ ${domain}: done`);
    return true;
  } catch (e) { log(`❌ ${domain}: ${e.message}`); return false; }
}

// --- BonusBitcoin (multicoin faucet) ---
async function claimBonusBitcoin(page) {
  const addr = wallets.BTC;
  log(`🎰 BonusBitcoin → ${truncAddr(addr)}`);
  try {
    await page.goto('https://bonusbitcoin.co', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const addrInput = await page.$('#btc_address, input[name="address"], input[placeholder*="address"]');
    if (addrInput) await addrInput.fill(addr);
    await sleep(500);
    const claimBtn = await page.$('#captcha_submit, button:has-text("Claim"), input[value*="Claim"]');
    if (claimBtn) await claimBtn.click();
    await sleep(8000);
    log(`✅ BonusBitcoin: done`);
    return true;
  } catch (e) { log(`❌ BonusBitcoin: ${e.message}`); return false; }
}

// --- Original faucets (refactored) ---
async function claimCryptosFaucetNetwork(page, site) {
  const cfg = config.faucets.cryptosfaucet_network;
  const wallet = getWallet(site + ' ' + cfg.coin, '');
  log(`🎰 CryptosFaucet ${site} → ${truncAddr(wallet)}`);
  try {
    await page.goto(site + '/login', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);
    const emailInput = await page.$('input[type="email"], input[name="email"]');
    const passInput = await page.$('input[type="password"], input[name="password"]');
    if (emailInput && passInput) {
      await emailInput.fill(cfg.email);
      await passInput.fill(cfg.password);
      const loginBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (loginBtn) await loginBtn.click();
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    }
    await sleep(3000);
    const freeLink = await page.$('a[href*="free"], a:has-text("Free"), a:has-text("Claim"), a:has-text("Roll")');
    if (freeLink) { await freeLink.click(); await page.waitForNavigation({ timeout: 15000 }).catch(() => {}); }
    await sleep(2000);
    const addrInput = await page.$('input[name="address"], input[name="wallet"], #address, input[placeholder*="address" i]');
    if (addrInput) await addrInput.fill(wallet);
    await detectAndSolveCaptcha(page);
    const rollBtn = await page.$('button:has-text("Roll"), button:has-text("Claim"), input[value*="Roll"], input[value*="Claim"]');
    if (rollBtn) { await rollBtn.click(); await sleep(5000); log(`✅ ${site}: claimed`); return true; }
    log(`⏰ ${site}: cooldown?`); return false;
  } catch (e) { log(`❌ ${site}: ${e.message}`); return false; }
}

async function claimBeefaucet(page) {
  const coins = config.faucets.beefaucet.coins;
  log(`🎰 Beefaucet (${coins.length} coins)`);
  for (const coin of coins) {
    try {
      const url = `https://beefaucet.org/${coin}-faucet/?r=${wallets[coin.toUpperCase()] || wallets.BTC}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(3000);
      const addrMap = { btc: wallets.BTC, eth: wallets.ETH, doge: wallets.DOGE, ltc: wallets.LTC, bch: wallets.BCH, dash: wallets.DASH, tron: wallets.TRX, trx: wallets.TRX, bnb: wallets.BNB, sol: wallets.SOL, xrp: wallets.XRP, ton: wallets.TON, usdt: wallets.USDT, ada: wallets.ADA };
      const wAddr = addrMap[coin] || wallets.BTC;
      const addrInput = await page.$('#address, input[name="address"]');
      if (addrInput) await addrInput.fill(wAddr);
      await detectAndSolveCaptcha(page);
      const claimBtn = await page.$('.btn.btn-block, .btn-primary');
      if (claimBtn) await claimBtn.click();
      await sleep(5000);
      log(`✅ Beefaucet ${coin}: done`);
      await sleep(randDelay(3000, 10000));
    } catch (e) { log(`❌ Beefaucet ${coin}: ${e.message}`); }
  }
}

async function claimPickIo(page, coin) {
  const addr = getWallet('pickio', coin);
  log(`🎰 Pick.io ${coin} → ${truncAddr(addr)}`);
  try {
    await page.goto(`https://pick.io/${coin.toLowerCase()}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);
    const emailInput = await page.$('input[type="email"], input[name="email"], input[name="address"], input[placeholder*="address" i]');
    if (emailInput) await emailInput.fill(addr);
    await detectAndSolveCaptcha(page);
    const claimBtn = await page.$('button:has-text("Claim"), button:has-text("Roll"), button[type="submit"]');
    if (claimBtn) { await claimBtn.click(); await sleep(8000); log(`✅ Pick.io ${coin}: done`); return true; }
    return false;
  } catch (e) { log(`❌ Pick.io ${coin}: ${e.message}`); return false; }
}

// ====== AUTO FAUCET DISCOVERY ======
async function discoverNewFaucets() {
  log('🔍 Searching for new faucets...');
  let discovered = [];
  
  // Sources to check for faucet lists
  const sources = [
    'https://raw.githubusercontent.com/.../faucets.txt', // placeholder
    'https://faucetlist.io',
    'https://freefaucetlist.com',
  ];
  
  // Check our known faucet providers for new coins
  try {
    // Pick.io — check what coins they support
    const resp = await fetch('https://pick.io/faucets');
    const html = await resp.text();
    const matches = html.match(/\/[a-z]{2,5}"/g) || [];
    for (const m of matches) {
      const coin = m.replace(/\/|"/g, '').toUpperCase();
      if (['BTC', 'ETH', 'LTC', 'DOGE', 'BNB', 'SOL', 'TRX', 'TON', 'XRP', 'ADA', 'BCH', 'DASH', 'ZEC'].includes(coin)) {
        if (!config.faucets[`pick_io_${coin.toLowerCase()}`]) {
          log(`🆕 Discovered new Pick.io faucet: ${coin}`);
          discovered.push({ source: 'pick.io', coin, url: `https://pick.io/${coin.toLowerCase()}` });
        }
      }
    }
  } catch (e) {}
  
  // Save discoveries
  if (discovered.length > 0) {
    const existing = JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8').catch(() => '[]'));
    const all = [...existing, ...discovered.map(d => ({ ...d, discoveredAt: new Date().toISOString() }))];
    fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(all, null, 2));
    log(`📝 Saved ${discovered.length} new discoveries`);
  }
  
  return discovered;
}

// ====== MAIN CYCLE ======
async function runCycle() {
  loadState();
  const { browser, context } = await createBrowser();
  let claims = 0;
  let sinceRotate = 0;

  try {
    const page = await context.newPage();
    
    // ─── NEW: FaucetPay API claims (no browser needed) ───
    if (config.faucetpay_api_key) {
      log('📡 Claiming via FaucetPay API...');
      claims += await claimFaucetPayAPI();
    }

    // ─── Moon faucets ───
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
      const key = `moon_${coin}`;
      if ((Date.now() - (state.lastClaims[key] || 0)) < 3600000) continue;
      if (await claimMoonFaucet(page, coin)) { state.lastClaims[key] = Date.now(); claims++; }
      await sleep(randDelay(10000, 20000));
    }

    // ─── BonusBitcoin ───
    if ((Date.now() - (state.lastClaims['bonusbitcoin'] || 0)) > 3600000) {
      if (await claimBonusBitcoin(page)) { state.lastClaims['bonusbitcoin'] = Date.now(); claims++; }
      await sleep(randDelay(5000, 15000));
    }

    // ─── CryptosFaucet Network ───
    if (config.faucets.cryptosfaucet_network.enabled) {
      for (const site of config.faucets.cryptosfaucet_network.sites) {
        const last = state.lastClaims[site] || 0;
        if ((Date.now() - last) < 3600000) { log(`⏭️ CryptosFaucet ${site}: on cooldown`); continue; }
        if (await claimCryptosFaucetNetwork(page, site)) { state.lastClaims[site] = Date.now(); claims++; }
        await sleep(randDelay(5000, 20000));
        if (++sinceRotate >= (config.rotate_ip_every || 5)) { await rotateTorIP(); sinceRotate = 0; }
      }
    }

    // ─── Beefaucet ───
    if (config.faucets.beefaucet.enabled && (Date.now() - (state.lastClaims['beefaucet'] || 0)) > 3600000) {
      await claimBeefaucet(page);
      state.lastClaims['beefaucet'] = Date.now();
      claims++;
      await sleep(randDelay(5000, 15000));
    }

    // ─── Pick.io ───
    const pickCoins = ['pick_io_bnb', 'pick_io_ltc', 'pick_io_sol', 'pick_io_ton', 'pick_io_trx', 'pick_io_doge', 'pick_io_btc', 'pick_io_eth'];
    for (const key of pickCoins) {
      const fc = config.faucets[key];
      if (!fc?.enabled) continue;
      if ((Date.now() - (state.lastClaims[key] || 0)) < 3600000) continue;
      if (await claimPickIo(page, fc.coin)) { state.lastClaims[key] = Date.now(); claims++; }
      await sleep(randDelay(5000, 15000));
    }

    // ─── Original faucets (Freebitco, FaucetCrypto) ───
    if (config.faucets.freebitco_in?.enabled && (Date.now() - (state.lastClaims['freebitco_in'] || 0)) > 3600000) {
      const { claimFreebitco } = require('./runner.js');
      if (await claimFreebitco(page)) { state.lastClaims['freebitco_in'] = Date.now(); claims++; }
    }
    if (config.faucets.faucetcrypto?.enabled && (Date.now() - (state.lastClaims['faucetcrypto'] || 0)) > 2400000) {
      const { claimFaucetCrypto } = require('./runner.js');
      if (await claimFaucetCrypto(page)) { state.lastClaims['faucetcrypto'] = Date.now(); claims++; }
    }

    // ─── NEW: Allcoins ───
    for (const coin of ['BTC', 'DOGE', 'LTC']) {
      const key = `allcoins_${coin}`;
      if ((Date.now() - (state.lastClaims[key] || 0)) < 3600000) continue;
      if (await claimAllcoins(page, coin)) { state.lastClaims[key] = Date.now(); claims++; }
      await sleep(randDelay(5000, 15000));
    }

    // ─── Auto-discover new faucets every 10 cycles ───
    if ((state.runCount || 0) % 10 === 0) {
      await discoverNewFaucets();
    }

    state.totalClaims += claims;
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

// ─── AUTO-ADD DISCOVERED FAUCETS ───
async function autoAddFaucets() {
  if (!fs.existsSync(DISCOVERY_PATH)) return;
  const discovered = JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8'));
  let added = 0;
  
  for (const d of discovered) {
    if (d.added) continue;
    if (d.source === 'pick.io') {
      const key = `pick_io_${d.coin.toLowerCase()}`;
      if (!config.faucets[key]) {
        config.faucets[key] = { enabled: true, url: d.url, coin: d.coin };
        added++;
      }
    }
    d.added = true;
  }
  
  if (added > 0) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discovered, null, 2));
    log(`✅ Auto-added ${added} new faucets to config!`);
  }
}

// ─── MAIN LOOP ───
async function main() {
  log('🚀 FAUCET FARM v2 starting...');
  loadState();
  
  // Check for discovered faucets to auto-add
  await autoAddFaucets();
  
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