# Football Packs: Telegram Mini App

## Files
- `index.html`: the whole app (Packs, Collection, Rewards, pack-opening animation). Self-contained: images are embedded, so it works by itself.
- `wallet.html`: the separate Wallet screen (Add Funds, withdraw to bank / wallet). Not linked to `index.html` yet; the + button shows a placeholder message.
- `assets/`: the same images as separate files (pack art, 24 player cutouts, logo, ball) for your designer or developer.

## Run the app and API
1. Use Node.js 22.13 or newer, then run `npm install`.
2. Copy `.env.example` to `.env` (or set the same variables in your host's dashboard). Set `APP_URL` to the public HTTPS URL of this server, `BOT_TOKEN` to the Telegram bot token, `DEPOSIT_ADDRESS` to a Solana address you control, `HELIUS_AUTH` to a private webhook secret, and optionally `APP_ORIGIN` and `ADMIN_TOKEN`.
3. Run `npm start`. The server hosts the app at `/` and the API at `/api`. The SQLite database is stored in `data/phygitals.sqlite`; keep that directory on a persistent disk and back it up.
4. Configure a Helius webhook for the deposit address, USDC and USDT token transfers, and the URL `/webhook/helius`. Set its Authorization header to the same `HELIUS_AUTH` value. Configure the provider to send confirmed transactions.
5. In Telegram, open **@BotFather** > `/newapp` (or Bot Settings > Menu Button) and set the Web App URL to the HTTPS URL serving this server.
6. Set `botLink` in the `CFG` block to your real bot link, for example `https://t.me/YourBot/app?startapp=`.

The backend verifies Telegram Web App data, stores Telegram accounts and $1 referral rewards in SQLite, and credits confirmed USDC/USDT deposits once per transaction. For a shared deposit address, users must link and sign with the wallet they send from; deposits from unlinked wallets are recorded as unclaimed until that wallet is linked. Deposits from exchanges generally cannot be matched because they use shared sender addresses. The server does not hold a signing key. Withdrawal requests are reserved in the account and require manual payout/review using the admin endpoint; configuring that endpoint does not itself send funds.

With `ADMIN_TOKEN`, review pending withdrawals at `GET /admin/withdrawals` and unclaimed deposits at `GET /admin/unclaimed-deposits` using the `X-Admin-Token` header. After manually sending a payout, mark it complete with `POST /admin/withdrawals/{id}/review` and `{"action":"paid","reference":"<payout transaction id>"}`; use `{"action":"reject"}` to release a rejected request. Pack openings, card sales and card withdrawals remain disabled in the live API flow until they are server-authoritative.

## Withdrawal processing fee (on-chain, verified)

When enabled, every withdrawal first needs a **$3.29 USDC processing fee**, paid by the user on Solana to your fee wallet. The fee is separate from the withdrawal (it is not also deducted from the amount) and separate from Solana's own network fee, and the app explains both before the user confirms.

Set these in `.env` or your host's dashboard (all public values; **no private key is ever given to the server**):
- `FEE_WALLET_ADDRESS`: the Solana address that receives fees. Must be a wallet you control and must differ from `DEPOSIT_ADDRESS`, or fee payments would also be treated as deposits.
- `SOLANA_RPC_URL`: an RPC endpoint (for example your Helius RPC URL) the server uses to read the chain. Treat it as a secret if it contains an API key.
- Optional: `SOLANA_COMMITMENT` (`finalized`, the default, or `confirmed`) and `FEE_PAYMENT_TTL_MINUTES` (default 30).

If either required value is missing or invalid, the server logs why and falls back to the old behavior (fee deducted from the amount).

How it works:
1. The user confirms the notice. The server creates the withdrawal in stage `awaiting_fee` (the amount is reserved) with a unique payment **reference** and a Solana Pay link.
2. The server finds the payment itself by looking the reference up on-chain and checks that the transaction succeeded, carries that reference, and credited at least $3.29 USDC to `FEE_WALLET_ADDRESS`. A response from the browser is never trusted. A background job checks every 15 seconds as well.
3. Once verified, the withdrawal becomes `queued` and appears in `GET /admin/withdrawals`, where the existing manual payout and review flow takes over. Requests still waiting for their fee are never reviewable. The fee transaction hash is stored on the payment, and the payout hash is the `reference` you enter when marking the request paid.
4. Each payment is confirmed at most once (unique reference, unique transaction signature, guarded state change).
5. Unpaid requests expire after the time limit and release the reserved amount. A payment that arrives after expiry, or a withdrawal you reject after the fee was paid, is returned to the user's USDC balance instead of being kept.
6. Everything is written to `audit_log` (`withdrawal_requested`, `withdrawal_fee_confirmed`, `withdrawal_fee_expired`, `withdrawal_fee_refunded`, `withdrawal_paid`, ...).

The server still does not send the payout itself; that remains the manual step described above.

## Withdraw to Whoop Wallet (automatic)

The **Withdraw** button in the app sends winnings straight to the user's linked Whoop Wallet. There is no review step and no pasted address:

1. The user links Whoop once with a one-time code (Whoop Wallet > Profile > Phygitals).
2. They pick USDC or USDT, enter an amount and tap **Withdraw**.
3. The server reserves the amount, credits Whoop in the same request, then deducts the balance. The money is already in Whoop when the request returns.

`POST /api/whoop/withdraw` and `GET /api/whoop/quote` take an optional `token` (`usdc`, `usdt`, or `credits`, the default). Funds held by a pending Whoop withdrawal cannot also be requested on-chain. Set `WHOOP_API_URL` and `WHOOP_INTEGRATION_KEY` (must equal `PHYGITALS_INTEGRATION_KEY` on the Whoop server). If Whoop is unreachable the amount stays held and is retried every 30 seconds.

The older on-chain route (`POST /api/withdraw`, manual payout and optional on-chain fee) still exists but the app no longer uses it.

## Telegram bot (/start)

On startup the server uses `BOT_TOKEN` + `APP_URL` to register itself with Telegram automatically: it sets the webhook (`/telegram/webhook`, protected by a secret header), the `/start` command, the **Play** menu button that opens the Mini App, and the bot description. When someone sends `/start` the bot replies with a welcome message and an **Open Phygitals** button that launches the Mini App. `/start <referral code>` carries the code into the app. Edit the text in `welcomeText()` in `bot.js`.

Check it worked: the server log prints `Telegram bot setup: {...}` with `true` for each step. If `APP_URL` is missing the bot is disabled and the log says so.

For referral links like `https://t.me/<bot>?startapp=<code>` to open the app directly, set the Main Mini App in @BotFather (Bot Settings > Configure Mini App) to your `APP_URL`, and make sure `CFG.botLink` in `index.html` uses your real bot username.

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