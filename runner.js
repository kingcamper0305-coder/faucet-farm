/**
 * Faucet Farm - Cloud Server Faucet Automation
 * Uses Playwright + Tor for automated crypto faucet claims
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const WALLETS_PATH = path.join(__dirname, 'wallets.json');
const LOG_PATH = path.join(__dirname, 'farm.log');
const STATE_PATH = path.join(__dirname, 'state.json');

// Load config + wallets
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const wallets = JSON.parse(fs.readFileSync(WALLETS_PATH, 'utf8')).wallets;

// State tracking
let state = {
  lastClaims: {},
  totalClaims: 0,
  errors: [],
  startedAt: new Date().toISOString()
};

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) { /* fresh start */ }
}

function saveState() {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

// Tor IP rotation
async function rotateTorIP() {
  try {
    const { execSync } = require('child_process');
    execSync('kill -HUP $(cat /var/run/tor/tor.pid 2>/dev/null || pgrep -f "tor --") 2>/dev/null', { timeout: 5000 });
    await sleep(3000);
    log('🔄 Tor circuit rotated');
  } catch (e) {
    log('⚠️ Tor rotation failed (non-critical): ' + e.message);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomDelay(min = 30000, max = 90000) {
  return Math.floor(min + Math.random() * (max - min));
}

// Browser factory
async function createBrowser() {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
  ];

  if (config.use_tor) {
    args.push(`--proxy-server=${config.tor_proxy}`);
  }

  const browser = await chromium.launch({
    headless: config.headless,
    executablePath: '/usr/bin/chromium',
    args
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });

  // Anti-detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  return { browser, context };
}

// ====== FAUCET CLAIMERS ======

// Map faucet site to wallet address
function getWalletForSite(site) {
  const siteLower = site.toLowerCase();
  if (siteLower.includes('freebitcoin') || siteLower.includes('btc')) return wallets.BTC;
  if (siteLower.includes('freeethereum') || siteLower.includes('eth')) return wallets.ETH;
  if (siteLower.includes('free-ltc') || siteLower.includes('ltc')) return wallets.LTC;
  if (siteLower.includes('free-doge') || siteLower.includes('doge')) return wallets.DOGE;
  if (siteLower.includes('freebinancecoin') || siteLower.includes('bnb') || siteLower.includes('freepancake')) return wallets.BNB;
  if (siteLower.includes('free-tron') || siteLower.includes('trx')) return wallets.TRX;
  if (siteLower.includes('freecardano') || siteLower.includes('ada')) return wallets.ADA;
  if (siteLower.includes('freedash') || siteLower.includes('dash')) return wallets.DASH;
  if (siteLower.includes('freeneo') || siteLower.includes('neo')) return wallets.NEO;
  if (siteLower.includes('freeshib') || siteLower.includes('shib')) return wallets.SHIB;
  if (siteLower.includes('freetether') || siteLower.includes('usdt')) return wallets.USDT;
  if (siteLower.includes('freeusdcoin') || siteLower.includes('usdc')) return wallets.USDC;
  if (siteLower.includes('coinfaucet') || siteLower.includes('xrp') || siteLower.includes('ripple')) return wallets.XRP;
  if (siteLower.includes('freenem') || siteLower.includes('xem')) return wallets.BTC; // NEM fallback
  if (siteLower.includes('freesteam') || siteLower.includes('steam')) return wallets.TRX; // STEAM fallback
  if (siteLower.includes('bch') || siteLower.includes('cash')) return wallets.BCH;
  if (siteLower.includes('zec')) return wallets.LTC; // ZEC fallback
  return config.faucetpay_email; // fallback
}

// CryptosFaucet Network (freebitcoin.io, freecardano.com, etc.)
async function claimCryptosFaucetNetwork(page, site) {
  const cfg = config.faucets.cryptosfaucet_network;
  const wallet = getWalletForSite(site);
  log(`🎰 Claiming from ${site} → ${wallet.substring(0, 12)}...`);

  try {
    await page.goto(site + '/login', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(2000);

    // Login
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

    // Find and click free/claim button
    const freeLink = await page.$('a[href*="free"], a:has-text("Free"), a:has-text("Claim"), a:has-text("Roll")');
    if (freeLink) {
      await freeLink.click();
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    }

    await sleep(2000);

    // Fill wallet address if field exists
    const addrInput = await page.$('input[name="address"], input[name="wallet"], #address, input[placeholder*="address" i]');
    if (addrInput) {
      await addrInput.fill(wallet);
      await sleep(500);
    }

    // Check for claim/roll button
    const rollBtn = await page.$('button:has-text("Roll"), button:has-text("Claim"), input[value*="Roll"], input[value*="Claim"]');
    if (rollBtn) {
      await rollBtn.click();
      await sleep(5000);
      log(`✅ Claimed from ${site}`);
      return true;
    }

    // Check if cooldown
    const cooldown = await page.$('text=hour, text=minute, text=wait, text=cooldown');
    if (cooldown) {
      log(`⏰ Cooldown active on ${site}`);
      return false;
    }

    log(`⚠️ No claim button found on ${site}`);
    return false;
  } catch (e) {
    log(`❌ Error on ${site}: ${e.message}`);
    return false;
  }
}

// Beefaucet Rotator
async function claimBeefaucet(page) {
  const coins = config.faucets.beefaucet.coins;
  log(`🎰 Starting beefaucet rotator (${coins.length} coins)`);

  for (const coin of coins) {
    try {
      const url = `https://beefaucet.org/${coin}-faucet/?r=${config.faucetpay_email}`;
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await sleep(3000);

      // Fill address with appropriate wallet
      const addrMap = {
        btc: wallets.BTC, eth: wallets.ETH, doge: wallets.DOGE, ltc: wallets.LTC,
        bch: wallets.BCH, dash: wallets.DASH, zec: wallets.LTC, tron: wallets.TRX,
        trx: wallets.TRX, bnb: wallets.BNB, sol: wallets.SOL, xrp: wallets.XRP,
        xlm: wallets.XRP, xmr: wallets.ETH, ton: wallets.TON, usdc: wallets.USDC,
        usdt: wallets.USDT, ada: wallets.ADA
      };
      const walletAddr = addrMap[coin] || config.faucetpay_email;

      const addrInput = await page.$('#address, input[name="address"]');
      if (addrInput) {
        await addrInput.fill(walletAddr);
      }

      // Click first claim button
      const claimBtn = await page.$('.btn.btn-block, .btn-primary');
      if (claimBtn) {
        await claimBtn.click();
        await sleep(5000);
      }

      // Try to find submit after captcha
      const submitBtn = await page.$('#login, button[type="submit"]');
      if (submitBtn) {
        const visible = await submitBtn.isVisible().catch(() => false);
        if (visible) {
          await submitBtn.click();
          await sleep(3000);
        }
      }

      log(`✅ beefaucet ${coin}: claimed → ${walletAddr.substring(0, 12)}...`);
      await sleep(randomDelay(5000, 15000));
    } catch (e) {
      log(`❌ beefaucet ${coin}: ${e.message}`);
    }
  }
}

// Pick.io claims
async function claimPickIo(page, coin) {
  const addrMap = {
    BNB: wallets.BNB, LTC: wallets.LTC, SOL: wallets.SOL,
    TON: wallets.TON, TRX: wallets.TRX, DOGE: wallets.DOGE
  };
  const walletAddr = addrMap[coin] || config.faucetpay_email;
  log(`🎰 Claiming Pick.io ${coin} → ${walletAddr.substring(0, 12)}...`);
  try {
    await page.goto(`https://pick.io/${coin.toLowerCase()}`, { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    // Fill wallet address
    const emailInput = await page.$('input[type="email"], input[name="email"], input[name="address"], input[placeholder*="address" i]');
    if (emailInput) {
      await emailInput.fill(walletAddr);
    }

    // Click claim
    const claimBtn = await page.$('button:has-text("Claim"), button:has-text("Roll"), button[type="submit"]');
    if (claimBtn) {
      await claimBtn.click();
      await sleep(8000);
    }

    log(`✅ Pick.io ${coin}: claimed`);
    return true;
  } catch (e) {
    log(`❌ Pick.io ${coin}: ${e.message}`);
    return false;
  }
}

// Freebitco.in
async function claimFreebitco(page) {
  const cfg = config.faucets.freebitco_in;
  log('🎰 Claiming Freebitco.in');

  try {
    await page.goto('https://freebitco.in', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    // Login if needed
    const loginLink = await page.$('a:has-text("LOGIN"), a[href*="login"]');
    if (loginLink) {
      await loginLink.click();
      await sleep(2000);

      const emailInput = await page.$('input[name="email"], input[type="email"]');
      const passInput = await page.$('input[name="password"], input[type="password"]');

      if (emailInput) await emailInput.fill(cfg.email);
      if (passInput) await passInput.fill(cfg.password);

      const loginBtn = await page.$('button:has-text("LOGIN"), input[value*="LOGIN"]');
      if (loginBtn) await loginBtn.click();
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    }

    await sleep(3000);

    // Roll
    const rollBtn = await page.$('#free_play_form_button, button:has-text("ROLL"), input[value*="ROLL"]');
    if (rollBtn) {
      await rollBtn.click();
      await sleep(10000);
      log('✅ Freebitco.in: rolled');
      return true;
    }

    // Cooldown check
    const timer = await page.$('#time_remaining, .countdown');
    if (timer) {
      log('⏰ Freebitco.in: cooldown active');
    }

    return false;
  } catch (e) {
    log(`❌ Freebitco.in: ${e.message}`);
    return false;
  }
}

// FaucetCrypto
async function claimFaucetCrypto(page) {
  const cfg = config.faucets.faucetcrypto;
  log('🎰 Claiming FaucetCrypto');

  try {
    await page.goto('https://faucetcrypto.com/login', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    const emailInput = await page.$('input[name="email"], input[type="email"]');
    const passInput = await page.$('input[name="password"], input[type="password"]');

    if (emailInput) await emailInput.fill(cfg.email);
    if (passInput) await passInput.fill(cfg.password);

    const loginBtn = await page.$('button[type="submit"], button:has-text("Login")');
    if (loginBtn) await loginBtn.click();
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});

    await sleep(3000);

    // Go to faucet claim
    await page.goto('https://faucetcrypto.com/task/faucet-claim', { waitUntil: 'networkidle', timeout: 30000 });
    await sleep(3000);

    const claimBtn = await page.$('button:has-text("Claim"), button:has-text("Roll")');
    if (claimBtn) {
      await claimBtn.click();
      await sleep(8000);
      log('✅ FaucetCrypto: claimed');
      return true;
    }

    log('⏰ FaucetCrypto: not ready yet');
    return false;
  } catch (e) {
    log(`❌ FaucetCrypto: ${e.message}`);
    return false;
  }
}

// ====== MAIN RUNNER ======

async function runCycle() {
  loadState();
  const { browser, context } = await createBrowser();
  let claimsThisCycle = 0;
  let claimsSinceRotate = 0;

  try {
    const page = await context.newPage();

    // 1. CryptosFaucet Network
    if (config.faucets.cryptosfaucet_network.enabled) {
      for (const site of config.faucets.cryptosfaucet_network.sites) {
        const lastClaim = state.lastClaims[site] || 0;
        const hoursSince = (Date.now() - lastClaim) / 3600000;

        if (hoursSince >= 1) {
          const claimed = await claimCryptosFaucetNetwork(page, site);
          if (claimed) {
            state.lastClaims[site] = Date.now();
            claimsThisCycle++;
            claimsSinceRotate++;
          }
          await sleep(randomDelay(...config.delay_between_claims));
        } else {
          log(`⏭️ ${site}: ${Math.round(hoursSince * 60)}min until next claim`);
        }

        // Rotate Tor IP periodically
        if (claimsSinceRotate >= (config.rotate_ip_every || 10)) {
          await rotateTorIP();
          claimsSinceRotate = 0;
        }
      }
    }

    // 2. Beefaucet Rotator
    if (config.faucets.beefaucet.enabled) {
      const lastClaim = state.lastClaims['beefaucet'] || 0;
      if ((Date.now() - lastClaim) / 3600000 >= 1) {
        await claimBeefaucet(page);
        state.lastClaims['beefaucet'] = Date.now();
        claimsThisCycle++;
        await sleep(randomDelay(...config.delay_between_claims));
      }
    }

    // 3. Pick.io (all coins)
    if (config.faucets.pick_io_bnb?.enabled) {
      for (const coinKey of ['pick_io_bnb', 'pick_io_ltc', 'pick_io_sol', 'pick_io_ton', 'pick_io_trx', 'pick_io_doge']) {
        const faucet = config.faucets[coinKey];
        if (!faucet?.enabled) continue;

        const lastClaim = state.lastClaims[coinKey] || 0;
        if ((Date.now() - lastClaim) / 3600000 >= 1) {
          const claimed = await claimPickIo(page, faucet.coin);
          if (claimed) {
            state.lastClaims[coinKey] = Date.now();
            claimsThisCycle++;
          }
          await sleep(randomDelay(...config.delay_between_claims));
        }
      }
    }

    // 4. Freebitco.in
    if (config.faucets.freebitco_in.enabled) {
      const lastClaim = state.lastClaims['freebitco_in'] || 0;
      if ((Date.now() - lastClaim) / 3600000 >= 1) {
        const claimed = await claimFreebitco(page);
        if (claimed) {
          state.lastClaims['freebitco_in'] = Date.now();
          claimsThisCycle++;
        }
      }
    }

    // 5. FaucetCrypto
    if (config.faucets.faucetcrypto.enabled) {
      const lastClaim = state.lastClaims['faucetcrypto'] || 0;
      if ((Date.now() - lastClaim) / 3600000 >= 0.66) { // ~40 min
        const claimed = await claimFaucetCrypto(page);
        if (claimed) {
          state.lastClaims['faucetcrypto'] = Date.now();
          claimsThisCycle++;
        }
      }
    }

    state.totalClaims += claimsThisCycle;
    state.lastRun = new Date().toISOString();
    saveState();

    log(`📊 Cycle complete: ${claimsThisCycle} claims this run, ${state.totalClaims} total`);

  } catch (e) {
    log(`💥 Cycle error: ${e.message}`);
  } finally {
    await browser.close();
  }

  return claimsThisCycle;
}

// Run continuously
async function main() {
  log('🚀 Faucet Farm starting...');
  loadState();
  log(`📊 Previous total claims: ${state.totalClaims}`);

  let cycle = 0;
  while (true) {
    cycle++;
    log(`\n=== CYCLE ${cycle} ===`);

    try {
      await runCycle();
    } catch (e) {
      log(`💥 Fatal cycle error: ${e.message}`);
    }

    // Wait before next cycle (25-35 min)
    const waitMs = randomDelay(1500000, 2100000);
    log(`💤 Sleeping ${Math.round(waitMs / 60000)} minutes until next cycle...\n`);
    await sleep(waitMs);
  }
}

// Export for single-run mode
module.exports = { runCycle, createBrowser, claimCryptosFaucetNetwork, claimBeefaucet, claimPickIo, claimFreebitco, claimFaucetCrypto };

// Run if called directly
if (require.main === module) {
  main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
  });
}
