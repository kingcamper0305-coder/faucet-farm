# 🚀 Faucet Farm v2 — Supercharged

Automated crypto faucet claiming with CAPTCHA bypass, auto-discovery, and API integration.

## 🔥 New in v2

- **CAPTCHA bypass** — Detects reCAPTCHA v2 and solves via 2Captcha API (CAPTCHA_KEY)
- **FaucetPay API** — Claims 50+ coins directly via API (no browser, no CAPTCHA)
- **Moon faucets** — moonbitcoin.cash, moonlitecoin.cash, moondoge.cash
- **BonusBitcoin** — bitcoin faucet
- **Allcoins.pw** — BTC/DOGE/LTC claims
- **Auto faucet discovery** — Scrapes faucet sites for new coins every 10 cycles
- **Auto-add** — Newly discovered faucets auto-added to config.json
- **Rolling stats** — Today/week/month claim tracking in state.json
- **Healthcheck HTTP server** — Railway-friendly on port 8080

## Supported Faucets (50+)

| Network | Sites/Pairs | Pays |
|---------|-------------|------|
| CryptosFaucet | 16 sites | ADA, BNB, BTC, DASH, DOGE, ETH, LTC, TRX, XRP, etc |
| Beefaucet | 9 coins | BTC, DOGE, LTC, TRX, BNB, SOL, ETH, XRP, TON |
| Pick.io | 8 coins | BTC, ETH, BNB, LTC, SOL, TON, TRX, DOGE |
| FaucetPay API | 13 coins | BTC, LTC, DOGE, TRX, USDT, SOL, BNB, ETH, TON, BCH, DASH, XRP, ADA |
| Moon faucets | 3 | BTC, LTC, DOGE |
| BonusBitcoin | 1 | BTC |
| Allcoins.pw | 3 | BTC, DOGE, LTC |
| Freebitco.in | 1 | BTC |
| FaucetCrypto | 1 | Multi-coin |
| StormGain | 1 | BTC (cloud mining) |

## Quick Start

### Railway (free)
Deploy at railway.app, add these env vars:
- FAUCET_EMAIL — Email for logged-in faucets
- FAUCET_PASS — Password
- FAUCETPAY_KEY — (optional) FaucetPay API key
- CAPTCHA_KEY — (optional) 2Captcha key

### Self-hosted
```bash
npm install
nano config.json   # replace ${FAUCET_EMAIL} etc with your credentials
node runner_v2.js
```

## Files

| File | Purpose |
|------|---------|
| runner_v2.js | v2 main engine — all features |
| runner.js | v1 original (legacy) |
| config.json | Faucet accounts, wallet routes, settings |
| wallets.json | Your crypto wallet addresses |
| status.js | Claim status viewer |
| state.json | Auto-generated — claim history |
| discovered.json | Auto-generated — newly found faucets |

## Env Variables (Railway)

FAUCET_EMAIL, FAUCET_PASS, FAUCETPAY_KEY, CAPTCHA_KEY, PORT=8080

## License
MIT