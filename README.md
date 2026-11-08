# Football Packs: Telegram Mini App (front-end prototype)

## Files
- `index.html`: the whole app (Packs, Collection, Rewards, pack-opening animation). Self-contained: images are embedded, so it works by itself.
- `wallet.html`: the separate Wallet screen (Add Funds, withdraw to bank / wallet). Not linked to `index.html` yet; the + button shows a placeholder message.
- `assets/`: the same images as separate files (pack art, 24 player cutouts, logo, ball) for your designer or developer.

## Run it
1. Host the folder on any HTTPS static host (Netlify, Vercel, Cloudflare Pages, GitHub Pages).
2. In Telegram, open **@BotFather** > `/newapp` (or Bot Settings > Menu Button) and set the Web App URL to your `index.html` address.
3. `index.html` already loads `https://telegram.org/js/telegram-web-app.js`, so the haptics, back button and share sheet work inside Telegram.
4. Set `botLink` in the `CFG` block (top of the script) to your real bot link, for example `https://t.me/YourBot/app?startapp=`.

## What is demo-only (needs a backend before launch)
- **Pack draw and prices:** the random draw, balances and collection run in the browser. In production the server must pick the card, take the payment, and save balances per Telegram user (verify `Telegram.WebApp.initData` on the server).
- **Odds:** edit them in the `FB_PACKS` list. The page shows the odds it uses, so the server must use the same numbers. Keep each pack's average card value below its price after the sell-back rate (`CFG.buyback`).
- **Payments and withdrawals:** the Apple Pay / card and crypto flows are placeholders. Fees are in `CFG` (`netFee`, `bankPct`, `minWd`). Show every fee before the user confirms.
- **Referrals:** `CFG.refBonus` is demo logic. Pay out on the server, and consider paying only after the friend's first deposit, to stop fake accounts.
- **Player data:** names, ratings, positions and countries are in the `PL` list and are placeholders.

## Rights to sort out before launch
- Player photos, names, club crests and kit sponsors need licenses (many source sites do not allow commercial use).
- Selling random paid packs with cash-out prizes can count as gambling in many places, including Nigeria, the US and the UK. Check the licensing, age and location rules.
- Brand and logo files are yours; the pack art text and website are editable in `assets/packs` and in the page.
