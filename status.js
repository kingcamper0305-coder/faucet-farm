const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, 'state.json');
const LOG_PATH = path.join(__dirname, 'farm.log');
const CONFIG_PATH = path.join(__dirname, 'config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

let state = {};
try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch(e) {}

console.log('\n🧠 FAUCET FARM STATUS');
console.log('='.repeat(50));

if (state.startedAt) {
  console.log(`Started: ${state.startedAt}`);
  console.log(`Last run: ${state.lastRun || 'never'}`);
  console.log(`Total claims: ${state.totalClaims || 0}`);
} else {
  console.log('Status: Not run yet');
}

console.log('\n📋 Faucet Status:');
for (const [key, lastClaim] of Object.entries(state.lastClaims || {})) {
  const minsAgo = Math.round((Date.now() - lastClaim) / 60000);
  const hrsAgo = (minsAgo / 60).toFixed(1);
  const eligible = minsAgo >= 60 ? '✅ READY' : `⏰ ${60 - minsAgo}min`;
  console.log(`  ${key}: last claimed ${hrsAgo}h ago — ${eligible}`);
}

// Show enabled faucets
console.log('\n🔧 Enabled Faucets:');
const faucets = config.faucets;
for (const [key, val] of Object.entries(faucets)) {
  if (val?.enabled) {
    const coins = val.coins || val.coin || (val.sites ? `${val.sites.length} sites` : '?');
    console.log(`  ✅ ${key}: ${coins}`);
  } else {
    console.log(`  ⬜ ${key}: disabled`);
  }
}

console.log('\n⚙️ Config:');
console.log(`  Tor: ${config.use_tor ? 'ON' : 'OFF'}`);
console.log(`  Headless: ${config.headless ? 'YES' : 'NO'}`);
console.log(`  FaucetPay email: ${config.faucetpay_email}`);

// Recent logs
if (fs.existsSync(LOG_PATH)) {
  const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean);
  console.log(`\n📜 Last 10 log entries (${lines.length} total):`);
  lines.slice(-10).forEach(l => console.log(`  ${l}`));
}
