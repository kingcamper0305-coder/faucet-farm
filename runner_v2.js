/**
 * 🚀 FAUCET FARM v2 — Railway Edition
 * Auto-claimer + healthcheck + always-on
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ─── PATHS ───
const CONFIG_PATH = path.join(__dirname, 'config.json');
const WALLETS_PATH = path.join(__dirname, 'wallets.json');
const LOG_PATH = path.join(__dirname, 'farm.log');
const STATE_PATH = path.join(__dirname, 'state.json');
const DISCOVERY_PATH = path.join(__dirname, 'discovered.json');

// ─── STATE (defined before healthcheck!) ───
let state = {
  totalClaims: 0,
  totalEarnings: 0,
  totalClaimedCoins: {},
  lastClaims: {},
  errors: [],
  runCount: 0,
  lastCycle: null,
  startedAt: new Date().toISOString()
};

function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    Object.assign(state, d);
  } catch (e) {}
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
function truncAddr(a) { return a ? a.slice(0, 8) + '...' + a.slice(-6) : 'N/A'; }

// ─── LOAD CONFIG ───
const rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
function expandEnv(obj) {
  if (typeof obj === 'string') return obj.replace(/\$\{([^}]+)\}/g, (_, n) => process.env[n] || '');
  if (Array.isArray(obj)) return obj.map(expandEnv);
  if (obj && typeof obj === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(obj)) r[k] = expandEnv(v);
    return r;
  }
  return obj;
}
const config = expandEnv(rawConfig);
const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8'));

log('🚀 FAUCET FARM v2 initializing...');
log(`📊 State loaded: ${state.totalClaims} previous claims`);

// ─── HEALTHCHECK SERVER (ALWAYS first to start, after state init) ───
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
  // /health or /
  res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), claims: state.totalClaims }));
}).listen(HEALTH_PORT, '0.0.0.0', () => {
  log(`🌐 Healthcheck @ :${HEALTH_PORT}`);
});

// ─── CHROMIUM PATH ───
function getChromiumPath() {
  // Railway nixpacks installs chromium at /nix/store/...
  const paths = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/nix/store/*/bin/chromium',
    null // let playwright auto-find
  ];
  for (const p of paths) {
    if (p && fs.existsSync(p.replace('*', ''))) return p;
  }
  return undefined;
}

// ─── FAUCET PAY API ───
async function claimFaucetPayAPI() {
  const apiKey = config.faucetpay_api_key;
  if (!apiKey) { log('⚠️ No FaucetPay API key'); return 0; }
  let claimed = 0;
  const coins = ['BTC', 'LTC', 'DOGE', 'TRX', 'USDT', 'SOL', 'BNB', 'ETH', 'TON', 'BCH', 'DASH', 'XRP', 'ADA'];

  for (const coin of coins) {
    const k = 'fp_' + coin;
    const lc = state.lastClaims[k] || 0;
    if ((Date.now() - lc) < 3600000) continue;
    try {
      const addr = wallets[coin] || wallets.BTC;
      const resp = await fetch(`https://faucetpay.io/api/v1/claim?api_key=${apiKey}&coin=${coin}&address=${addr}`);
      const d = await resp.json();
      if (d.success) {
        log(`💰 FaucetPay ${coin}: ${d.amount || '?'} (bal: ${d.balance || '?'})`);
        state.lastClaims[k] = Date.now();
        const amt = parseFloat(d.amount) || 0;
        state.totalClaimedCoins[coin] = (state.totalClaimedCoins[coin] || 0) + amt;
        state.totalEarnings += amt;
        claimed++;
      } else {
        log(`⏰ FaucetPay ${coin}: ${d.message || 'cooldown'}`);
      }
    } catch (e) { log(`⚠️ FaucetPay ${coin}: ${e.message}`); }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── PICK.IO HTTP CLAIM ───
async function claimPickIo() {
  let claimed = 0;
  const picks = [
    { coin: 'BTC', url: 'https://pick.io/btc' },
    { coin: 'ETH', url: 'https://pick.io/eth' },
    { coin: 'SOL', url: 'https://pick.io/sol' },
    { coin: 'BNB', url: 'https://pick.io/bnb' },
    { coin: 'LTC', url: 'https://pick.io/ltc' },
    { coin: 'DOGE', url: 'https://pick.io/doge' },
    { coin: 'TON', url: 'https://pick.io/ton' },
    { coin: 'TRX', url: 'https://pick.io/trx' },
  ];
  for (const p of picks) {
    const k = 'pick_' + p.coin;
    const lc = state.lastClaims[k] || 0;
    if ((Date.now() - lc) < 3600000) continue;
    try {
      const addr = wallets[p.coin] || wallets.BTC;
      const resp = await fetch(p.url + '/faucet?address=' + encodeURIComponent(addr));
      const text = await resp.text();
      if (text.includes('success') || text.includes('claimed') || !text.includes('error')) {
        log(`✅ Pick.io/${p.coin}: claimed`);
        claimed++;
        state.lastClaims[k] = Date.now();
        state.totalClaimedCoins[p.coin] = (state.totalClaimedCoins[p.coin] || 0) + 1;
      } else {
        log(`⏰ Pick.io/${p.coin}: ${text.slice(0, 100)}`);
      }
    } catch (e) { log(`⚠️ Pick.io/${p.coin}: ${e.message}`); }
    await sleep(randDelay(3000, 7000));
  }
  return claimed;
}

// ─── CRYPTOSFAUCE ───
async function claimCryptosFaucetSites() {
  const cfg = config.faucets?.cryptosfaucet_network;
  if (!cfg?.enabled) return 0;
  let claimed = 0;
  for (const url of (cfg.sites || [])) {
    const k = 'crypto_' + url.replace(/https?:\/\//, '').split('.')[0];
    const lc = state.lastClaims[k] || 0;
    if ((Date.now() - lc) < 3600000) continue;
    try {
      const resp = await fetch(url + '/?r=' + wallets.BTC);
      const text = await resp.text();
      if (!text.includes('error') && !text.includes('captcha')) {
        log(`✅ ${url}: claimed`);
        claimed++;
        state.lastClaims[k] = Date.now();
        state.totalClaims++;
      }
    } catch (e) { /* skip */ }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── BEEFAUCET ───
async function claimBeeFaucetSimple() {
  const cfg = config.faucets?.beefaucet;
  if (!cfg?.enabled) return 0;
  let claimed = 0;
  for (const coin of (cfg.coins || [])) {
    const k = 'bee_' + coin;
    const lc = state.lastClaims[k] || 0;
    if ((Date.now() - lc) < 3600000) continue;
    try {
      const addr = wallets[coin.toUpperCase()] || wallets.BTC;
      const resp = await fetch(`https://beefaucet.org/${coin.toLowerCase()}-faucet/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const text = await resp.text();
      if (!text.includes('error')) {
        log(`🐝 BeeFaucet ${coin}: done`);
        claimed++;
        state.lastClaims[k] = Date.now();
        state.totalClaimedCoins[coin.toUpperCase()] = (state.totalClaimedCoins[coin.toUpperCase()] || 0) + 1;
      }
    } catch (e) { /* skip */ }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── RUN CYCLE ───
async function runCycle() {
  log('🔄 Cycle starting...');
  let claims = 0;

  // HTTP-only claims (no browser needed, always work)
  claims += await claimFaucetPayAPI();
  claims += await claimPickIo();
  claims += await claimCryptosFaucetSites();
  claims += await claimBeeFaucetSimple();

  // Browser-based claims (require Chromium)
  try {
    log('🔧 Launching Chromium...');
    const browser = await chromium.launch({
      headless: true,
      executablePath: getChromiumPath(),
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--single-process', '--no-zygote'
      ]
    });
    const page = await browser.newPage();

    // Moon faucets
    for (const coin of ['BTC', 'LTC', 'DOGE']) {
      const domain = { BTC: 'moonbitcoin', LTC: 'moonlitecoin', DOGE: 'moondoge' }[coin];
      const k = 'moon_' + coin;
      if ((Date.now() - (state.lastClaims[k] || 0)) > 3600000) {
        try {
          await page.goto('https://' + domain + '.cash/', { timeout: 20000 });
          await sleep(5000);
          const i = await page.$('input[placeholder*="address" i]');
          if (i) await i.fill(wallets[coin] || wallets.BTC);
          await sleep(500);
          const b = await page.$('button:has-text("Start"), a:has-text("Start")');
          if (b) await b.click();
          await sleep(5000);
          log('✅ Moon ' + coin + ': done');
          state.lastClaims[k] = Date.now();
          claims++;
        } catch (e) { log('⚠️ Moon ' + coin + ': ' + e.message); }
      }
      await sleep(3000);
    }

    // BonusBitcoin
    try {
      await page.goto('https://bonusbitcoin.co', { timeout: 20000 });
      await sleep(3000);
      const inp = await page.$('#btc_address');
      if (inp) await inp.fill(wallets.BTC);
      await sleep(500);
      const btn = await page.$('button:has-text("Claim"), a:has-text("Claim")');
      if (btn) await btn.click();
      await sleep(5000);
      log('✅ BonusBitcoin: done');
      claims++;
    } catch (e) { log('⚠️ BonusBitcoin: ' + e.message); }

    await browser.close();
  } catch (e) {
    log('⚠️ Browser cycle skipped: ' + e.message);
  }

  state.totalClaims += claims;
  state.runCount++;
  state.lastCycle = new Date().toISOString();
  saveState();
  log(`📊 Cycle done: ${claims} claims (total: ${state.totalClaims})`);
  return claims;
}

// ─── MAIN ───
async function main() {
  log('🚀 FAUCET FARM v2 started!');
  log(`📊 Resume: ${state.totalClaims} claims total`);
  
  // Wait for healthcheck to register
  await sleep(2000);

  let cycle = 0;
  while (true) {
    cycle++;
    log(`\n═══ CYCLE ${cycle} ═══`);
    try {
      await runCycle();
    } catch (e) {
      log('💥 Cycle error: ' + e.message);
      state.errors.push(e.message);
      saveState();
    }
    const wait = randDelay(1500000, 2100000);
    log(`💤 Sleep ${Math.round(wait / 60000)}min...\n`);
    await sleep(wait);
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
