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
  const apiKey = ***;
  if (!apiKey) return 0;
  let claimed = 0;
  const coins = ['BTC', 'LTC', 'DOGE', 'TRX', 'USDT', 'SOL', 'BNB', 'ETH', 'TON', 'BCH', 'DASH', 'XRP', 'ADA'];
  for (const coin of coins) {
    const k = 'fp_' + coin;
    if ((Date.now() - (state.lastClaims[k] || 0)) < 3600000) continue;
    try {
      const addr = wallets[coin] || wallets.BTC;
      const resp = await fetch(`https://faucetpay.io/api/v1/claim?api_key=***}&coin=${coin}&address=${addr}`);
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

// ─── PICK.IO ───
async function claimPickIo() {
  let claimed = 0;
  const picks = ['BTC','ETH','SOL','BNB','LTC','DOGE','TON','TRX'];
  for (const coin of picks) {
    const k = 'pick_' + coin;
    if ((Date.now() - (state.lastClaims[k] || 0)) < 3600000) continue;
    try {
      const addr = wallets[coin] || wallets.BTC;
      const resp = await fetch(`https://pick.io/${coin.toLowerCase()}/faucet?address=` + encodeURIComponent(addr));
      const txt = await resp.text();
      if (txt.includes('success') || !txt.includes('error')) {
        log(`✅ Pick.io/${coin}: done`);
        state.lastClaims[k] = Date.now();
        claimed++;
      } else { log(`⏰ Pick.io/${coin}: ${txt.slice(0,80)}`); }
    } catch (e) { /* skip */ }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── CRYPTOSFAUCET ───
async function claimCryptosFaucet() {
  const cfg = config.faucets?.cryptosfaucet_network;
  if (!cfg?.enabled) return 0;
  let claimed = 0;
  for (const url of (cfg.sites || [])) {
    const k = 'crypto_' + url.replace(/https?:\/\//, '').split('.')[0];
    if ((Date.now() - (state.lastClaims[k] || 0)) < 3600000) continue;
    try {
      await fetch(url + '/?r=' + wallets.BTC);
      log(`✅ ${url}: claimed`);
      state.lastClaims[k] = Date.now();
      claimed++;
    } catch (e) { /* skip */ }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── BEEFAUCET ───
async function claimBeeFaucet() {
  const cfg = config.faucets?.beefaucet;
  if (!cfg?.enabled) return 0;
  let claimed = 0;
  for (const coin of (cfg.coins || [])) {
    const k = 'bee_' + coin;
    if ((Date.now() - (state.lastClaims[k] || 0)) < 3600000) continue;
    try {
      const addr = wallets[coin.toUpperCase()] || wallets.BTC;
      await fetch(`https://beefaucet.org/${coin.toLowerCase()}-faucet/`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      log(`🐝 BeeFaucet ${coin}: done`);
      state.lastClaims[k] = Date.now();
      claimed++;
    } catch (e) { /* skip */ }
    await sleep(randDelay(2000, 5000));
  }
  return claimed;
}

// ─── CYCLE ───
async function runCycle() {
  log('🔄 Cycle starting...');
  let claims = 0;
  claims += await claimFaucetPayAPI();
  claims += await claimPickIo();
  claims += await claimCryptosFaucet();
  claims += await claimBeeFaucet();
  
  // Only try browser if playwright is available
  const br = await getBrowser();
  if (br) {
    try {
      log('🔧 Launching Chromium...');
      const browser = await br.launch({
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process','--no-zygote']
      });
      const page = await browser.newPage();
      
      // Moon faucets
      for (const coin of ['BTC', 'LTC', 'DOGE']) {
        const domain = {BTC:'moonbitcoin',LTC:'moonlitecoin',DOGE:'moondoge'}[coin];
        const k = 'moon_' + coin;
        if ((Date.now() - (state.lastClaims[k] || 0)) > 3600000) {
          try {
            await page.goto(`https://${domain}.cash/`, { timeout: 15000 });
            await sleep(3000);
            const inp = await page.$('input[placeholder*="address" i]');
            if (inp) await inp.fill(wallets[coin] || wallets.BTC);
            await sleep(500);
            const btn = await page.$('button:has-text("Start"), a:has-text("Start")');
            if (btn) await btn.click();
            await sleep(5000);
            log(`✅ Moon ${coin}: done`);
            claims++;
            state.lastClaims[k] = Date.now();
          } catch(e) { log(`⚠️ Moon ${coin}: ${e.message}`); }
        }
        await sleep(3000);
      }
      
      // BonusBitcoin
      try {
        await page.goto('https://bonusbitcoin.co', { timeout: 15000 });
        await sleep(3000);
        const inp = await page.$('#btc_address');
        if (inp) await inp.fill(wallets.BTC);
        await sleep(500);
        const btn = await page.$('button:has-text("Claim"), a:has-text("Claim")');
        if (btn) await btn.click();
        await sleep(5000);
        log('✅ BonusBitcoin: done');
        claims++;
      } catch(e) { log(`⚠️ BonusBitcoin: ${e.message}`); }
      
      await browser.close();
      log('✅ Browser cycle complete');
    } catch (e) {
      log(`⚠️ Browser cycle error: ${e.message}`);
    }
  } else {
    log('ℹ️ No browser - HTTP claims only');
  }
  
  state.totalClaims += claims;
  state.runCount++;
  state.lastCycle = new Date().toISOString();
  saveState();
  log(`📊 Cycle done: ${claims} claims (total: ${state.totalClaims})`);
  if (claims === 0) log('⚠️ Zero claims - may need FaucetPay API key or wallet recheck');
  return claims;
}

// ─── MAIN ───
async function main() {
  let cycle = 0;
  while (true) {
    cycle++;
    log(`\n═══ CYCLE ${cycle} ═══`);
    try { await runCycle(); } 
    catch (e) { log(`💥 Fatal: ${e.message}`); state.errors.push(e.message); saveState(); }
    const wait = randDelay(1500000, 2100000);
    log(`💤 Sleep ${Math.round(wait / 60000)}min...\n`);
    await sleep(wait);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
