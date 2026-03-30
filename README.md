# 🎰 Faucet Farm

Automated crypto faucet claiming from a cloud server. Uses Playwright + Tor for headless browser automation across multiple faucet sites.

## Features

- **26 faucet sites** across 5 networks (CryptosFaucet, beefaucet.org, Pick.io, Freebitco.in, FaucetCrypto)
- **17 cryptocurrencies** — BTC, ETH, LTC, DOGE, BNB, TRX, SOL, TON, XRP, ADA, DASH, BCH, USDT, SHIB, and more
- **Tor proxy** for IP rotation
- **Anti-detection** — hides webdriver fingerprint
- **Smart scheduling** — per-faucet cooldown tracking
- **Wallet routing** — auto-fills correct wallet address per coin

## Setup

```bash
# Install dependencies
npm install

# Configure your wallets
nano wallets.json

# Configure faucet accounts
nano config.json

# Run
node runner.js

# Check status
node status.js
```

## Requirements

- Node.js 18+
- Chromium (`apt install chromium`)
- Tor (`apt install tor`)

## Architecture

```
runner.js          — Main automation engine
config.json        — Faucet site credentials & settings
wallets.json       — Crypto wallet addresses per coin
status.js          — Status checker & progress viewer
```

## Faucet Networks

| Network | Sites | Coins |
|---------|-------|-------|
| CryptosFaucet | 16 | ADA, BNB, BTC, DASH, DOGE, ETH, LTC, TRX, XRP, etc. |
| beefaucet.org | 1 (rotates 9) | BTC, DOGE, LTC, TRX, BNB, SOL, ETH, XRP, TON |
| Pick.io | 6 | BNB, LTC, SOL, TON, TRX, DOGE |
| Freebitco.in | 1 | BTC |
| FaucetCrypto | 1 | Multi-coin |

## Known Limitations

- **Cloudflare Turnstile** blocks headless browsers on CryptosFaucet sites
- **Datacenter IPs** detected by FaucetCrypto and similar sites
- **Captcha solving** requires external service (2Captcha, CapMonster) for full automation
- **Account creation** needs manual registration or residential IP

## Status

🟢 Runner built & tested  
🟢 Tor proxy working  
🟡 Needs manual account creation (datacenter IP blocked)  
🟡 Captcha integration pending  

## License

MIT
