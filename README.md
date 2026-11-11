# MOSN Safety API

Pay-per-call Solana token **rug / honeypot safety check** for AI agents and trading bots.
`GET /token-check?mint=<SOLANA_MINT>` → `{ "verdict": "SAFE|CAUTION|DANGER", "reasons": [...] }`
Payment: USDC via **x402**. First 5 calls/day free.

## Deploy on Render (always-on)
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → connect the repo (uses `render.yaml`).
3. In the dashboard, set the secret env vars (values from your MOSN `.env`):
   `X402_PUBLIC_URL` (your Render URL once known), `X402_PAY_TO` (vault),
   `BASE_PAY_TO`, `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `JUPITER_API_KEY`, `JUP_API_KEY`,
   `SOLANA_RPC_URL`, `SOLANA_RPC_FALLBACK`, `SOLANA_RPC_EXTRA`, `SOLANA_WALLET_PUBKEY` (public key only).
4. Deploy. Test: `curl "https://<your-render-url>/token-check?mint=So11111111111111111111111111111111111111112"` → should return a verdict (free tier) or HTTP 402 with payment terms.

Never set `WALLET_SECRET_KEY` here — the API only needs the public key.
