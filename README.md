# Football Packs: Telegram Mini App

## Files
- `index.html`: the whole app (Packs, Collection, Rewards, pack-opening animation). Self-contained: images are embedded, so it works by itself.
- `wallet.html`: the separate Wallet screen (Add Funds, withdraw to bank / wallet). Not linked to `index.html` yet; the + button shows a placeholder message.
- `assets/`: the same images as separate files (pack art, 24 player cutouts, logo, ball) for your designer or developer.

## Run the app and API
1. Use Node.js 22.13 or newer, then run `npm install`.
2. Set `BOT_TOKEN` to the Telegram bot token, `DEPOSIT_ADDRESS` to a Solana address you control, `HELIUS_AUTH` to a private webhook secret, and optionally `APP_ORIGIN` and `ADMIN_TOKEN`.
3. Run `npm start`. The server hosts the app at `/` and the API at `/api`. The SQLite database is stored in `data/phygitals.sqlite`; keep that directory on a persistent disk and back it up.
4. Configure a Helius webhook for the deposit address, USDC and USDT token transfers, and the URL `/webhook/helius`. Set its Authorization header to the same `HELIUS_AUTH` value. Configure the provider to send confirmed transactions.
5. In Telegram, open **@BotFather** > `/newapp` (or Bot Settings > Menu Button) and set the Web App URL to the HTTPS URL serving this server.
6. Set `botLink` in the `CFG` block to your real bot link, for example `https://t.me/YourBot/app?startapp=`.

The backend verifies Telegram Web App data, stores Telegram accounts and $1 referral rewards in SQLite, and credits confirmed USDC/USDT deposits once per transaction. For a shared deposit address, users must link and sign with the wallet they send from; deposits from unlinked wallets are recorded as unclaimed until that wallet is linked. Deposits from exchanges generally cannot be matched because they use shared sender addresses. The server does not hold a signing key. Withdrawal requests are reserved in the account and require manual payout/review using the admin endpoint; configuring that endpoint does not itself send funds.

With `ADMIN_TOKEN`, review pending withdrawals at `GET /admin/withdrawals` and unclaimed deposits at `GET /admin/unclaimed-deposits` using the `X-Admin-Token` header. After manually sending a payout, mark it complete with `POST /admin/withdrawals/{id}/review` and `{"action":"paid","reference":"<payout transaction id>"}`; use `{"action":"reject"}` to release a rejected request. Pack openings, card sales and card withdrawals remain disabled in the live API flow until they are server-authoritative.

## Important before launch
- **Pack draw and collection:** random draws, purchases, card ownership, and sell-back still run in the browser and are not persisted by this backend. Do not treat those client-side actions or displayed amounts as real money; move them server-side before enabling real withdrawals.
- **Odds:** edit them in the `FB_PACKS` list. The page shows the odds it uses, so the server must use the same numbers. Keep each pack's average card value below its price after the sell-back rate (`CFG.buyback`).
- **Card payments and withdrawals:** card checkout is not connected. Crypto deposits are credited 1:1 as pack credits after the webhook confirms them. Withdrawal requests are manual and only use server-held USDC/USDT balances; operator review requires `ADMIN_TOKEN`.
- **Shared deposit address:** a linked sending wallet allows on-chain attribution. Exchange withdrawals generally use shared sender addresses and cannot be reliably matched this way; users should not send from exchanges until unique deposit addresses or memo-based attribution are implemented.
- **Operational/security:** use HTTPS, restrict `APP_ORIGIN` when hosting the UI separately, protect `ADMIN_TOKEN` and webhook secrets, and check local money-services/gambling rules before launch.
- **Player data:** names, ratings, positions and countries are in the `PL` list and are placeholders.

## Rights to sort out before launch
- Player photos, names, club crests and kit sponsors need licenses (many source sites do not allow commercial use).
- Selling random paid packs with cash-out prizes can count as gambling in many places, including Nigeria, the US and the UK. Check the licensing, age and location rules.
- Brand and logo files are yours; the pack art text and website are editable in `assets/packs` and in the page.
