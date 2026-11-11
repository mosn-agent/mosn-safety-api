// mosn_safety_api.mjs — MOSN sells its token-safety check to other bots, paid per call in USDC on Solana (x402).
// Run (on the always-on server):  node --env-file=.env mosn_safety_api.mjs
// Paid route:  GET /token-check?mint=<token mint>   → verdict SAFE / CAUTION / DANGER with reasons
// Free routes: GET /  (what this is)   GET /health
import express from 'express';
import fs from 'fs';
import axios from 'axios';
import bs58 from 'bs58';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getExtensionTypes, ExtensionType, getTransferFeeConfig, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { paymentMiddleware, paymentMiddlewareFromHTTPServer } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactSvmScheme } from '@x402/svm/exact/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { holderConcentration, holderVerdict, pickBestPairs } from './mosn_signals.mjs';
import { startKeyStore, spend, COST } from './mosn_apikeys.mjs'; // v3.3: prepaid keys bought with SOL

const PORT = Number(process.env.PORT || process.env.X402_PORT || 4021); // Render/Railway inject PORT
const PRICE = process.env.X402_PRICE || '$0.005';
const NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; // Solana mainnet
const BASE_NETWORK = 'eip155:8453';                          // Base mainnet (v2: buyers can also pay in Base USDC)
const BASE_PAY_TO = process.env.BASE_PAY_TO || '';
const PRICE_POOLS = process.env.X402_PRICE_POOLS || '$0.01';
const PRICE_HOLDERS = process.env.X402_PRICE_HOLDERS || '$0.002';
const PRICE_ALPHA = process.env.X402_PRICE_ALPHA || '$0.05';
const PRICE_DATASET = process.env.X402_PRICE_DATASET || '$0.25';
const SWAP_FEE_BPS = Number(process.env.SAFE_SWAP_FEE_BPS || 30); // 0.3% platform fee, paid in SOL (wSOL) to MOSN
const BOT_FEE_BPS = Number(process.env.SWAPBOT_FEE_BPS || 50);      // v2.5: 0.5% for people using the Telegram bot / swap page (Trojan & BonkBot charge 1%)
const FACILITATOR = process.env.FACILITATOR_URL || 'https://facilitator.payai.network';
const PUBLIC_URL = (process.env.X402_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const WSOL = 'So11111111111111111111111111111111111111112';
const JUP = 'https://api.jup.ag/swap/v1/quote';
const jupHeaders = (process.env.JUPITER_API_KEY || process.env.JUP_API_KEY) ? { 'x-api-key': process.env.JUPITER_API_KEY || process.env.JUP_API_KEY } : {};

const payTo = process.env.X402_PAY_TO
    || process.env.SOLANA_WALLET_PUBKEY
    || (process.env.WALLET_SECRET_KEY ? Keypair.fromSecretKey(bs58.decode(process.env.WALLET_SECRET_KEY.trim())).publicKey.toBase58() : '');
if (!payTo) throw new Error('No payout address: set X402_PAY_TO (your wallet address) in .env');
if (!process.env.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL missing in .env');
// v2: use the Alchemy key first (Helius free credits can run out), then Helius, then public
const RPCS = [process.env.SOLANA_RPC_EXTRA, process.env.SOLANA_RPC_URL, process.env.SOLANA_RPC_FALLBACK]
    .filter(u => /^https:\/\//.test(u || '')).sort((a, b) => /helius/i.test(a) - /helius/i.test(b)) // v2.7: Helius last (often out of credits)
    .map(u => new Connection(u, 'confirmed'));
const connection = RPCS[0];
async function withAnyRpc(fn) { let last; for (const c of RPCS) { try { return await fn(c); } catch (e) { last = e; } } throw last; }

const DANGEROUS_EXT = new Set([ExtensionType.PermanentDelegate, ExtensionType.TransferHook, ExtensionType.ConfidentialTransferMint, ExtensionType.DefaultAccountState]);

function mosnHistory(mint) {
    try {
        const s = JSON.parse(fs.readFileSync('./mosn_state.json', 'utf8'));
        const ban = s.blacklistedMints?.[mint];
        const trades = (s.closedTrades || []).filter(t => t.mint === mint);
        return {
            flaggedByMosn: !!ban, flagReason: ban?.reason || null,
            mosnTrades: trades.length, mosnStuckSells: trades.filter(t => t.stuck).length
        };
    } catch { return { flaggedByMosn: false, flagReason: null, mosnTrades: 0, mosnStuckSells: 0 }; }
}

async function authorities(mint) {
    const key = new PublicKey(mint);
    let info, program = 'spl-token';
    try { info = await withAnyRpc(c => getMint(c, key, 'confirmed', TOKEN_PROGRAM_ID)); }
    catch { info = await withAnyRpc(c => getMint(c, key, 'confirmed', TOKEN_2022_PROGRAM_ID)); program = 'token-2022'; }
    const out = { program, mintAuthorityActive: info.mintAuthority !== null, freezeAuthorityActive: info.freezeAuthority !== null, dangerousExtensions: [], transferFeeBps: 0, decimals: info.decimals };
    if (program === 'token-2022') {
        for (const e of getExtensionTypes(info.tlvData || Buffer.alloc(0))) if (DANGEROUS_EXT.has(e)) out.dangerousExtensions.push(ExtensionType[e]);
        const tf = getTransferFeeConfig(info);
        if (tf) out.transferFeeBps = Number(tf.newerTransferFee?.transferFeeBasisPoints ?? 0);
    }
    return out;
}

async function market(mint) {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { timeout: 6000 });
    const p = pickBestPairs(r.data?.pairs)[0];
    if (!p) return null;
    return {
        symbol: p.baseToken?.symbol, dex: p.dexId, priceUsd: Number(p.priceUsd || 0),
        liquidityUsd: Number(p.liquidity?.usd || 0), volume5mUsd: Number(p.volume?.m5 || 0), volume1hUsd: Number(p.volume?.h1 || 0),
        change5mPct: Number(p.priceChange?.m5 || 0), change1hPct: Number(p.priceChange?.h1 || 0),
        buys5m: p.txns?.m5?.buys || 0, sells5m: p.txns?.m5?.sells || 0,
        ageHours: p.pairCreatedAt ? Math.round((Date.now() - p.pairCreatedAt) / 360000) / 10 : null
    };
}

// Simulate buying 0.1 SOL of the token and selling it straight back: no route = can't sell; big loss = trap or thin liquidity
async function exitTest(mint) {
    try {
        const buy = await axios.get(JUP, { params: { inputMint: WSOL, outputMint: mint, amount: 100_000_000, slippageBps: 500 }, headers: jupHeaders, timeout: 6000 });
        const sell = await axios.get(JUP, { params: { inputMint: mint, outputMint: WSOL, amount: buy.data.outAmount, slippageBps: 500 }, headers: jupHeaders, timeout: 6000 });
        const back = Number(sell.data.outAmount) / 1e8; // fraction of 0.1 SOL returned
        return { sellRouteExists: true, roundTripLossPct: Math.round((1 - back) * 1000) / 10 };
    } catch (e) {
        if (e.response && e.response.status >= 400 && e.response.status < 500 && e.response.status !== 429) {
            return { sellRouteExists: false, roundTripLossPct: null, note: 'No buy/sell route found on Jupiter' };
        }
        return { sellRouteExists: null, roundTripLossPct: null, note: 'Exit test unavailable right now' };
    }
}

function verdict(a, h, m, x, hist) {
    const danger = [], caution = [];
    if (a.mintAuthorityActive) danger.push('Creator can still mint unlimited new tokens');
    if (a.freezeAuthorityActive) danger.push('Creator can freeze holders (you may be unable to sell)');
    if (a.dangerousExtensions.length) danger.push(`Dangerous token settings: ${a.dangerousExtensions.join(', ')}`);
    if (a.transferFeeBps > 300) danger.push(`Transfer tax ${a.transferFeeBps / 100}%`);
    if (x.sellRouteExists === false) danger.push('No route to sell it back');
    if (x.sellRouteExists == null) caution.push('Sell-route test unavailable right now');
    if (x.roundTripLossPct != null && x.roundTripLossPct > 25) danger.push(`Buying and immediately selling loses ${x.roundTripLossPct}%`);
    if (h && h.top1 > 20) danger.push(`One wallet holds ${h.top1.toFixed(1)}% of supply`);
    if (h && h.top10 > 50) danger.push(`Top 10 wallets hold ${h.top10.toFixed(1)}%`);
    if (m && m.liquidityUsd < 5000) danger.push(`Very thin liquidity ($${Math.round(m.liquidityUsd)})`);
    if (hist.mosnStuckSells) danger.push('MOSN previously could not sell this token');

    if (h && h.top1 > 10 && h.top1 <= 20) caution.push(`One wallet holds ${h.top1.toFixed(1)}%`);
    if (h && h.top10 > 35 && h.top10 <= 50) caution.push(`Top 10 wallets hold ${h.top10.toFixed(1)}%`);
    if (x.roundTripLossPct != null && x.roundTripLossPct > 10 && x.roundTripLossPct <= 25) caution.push(`Round-trip loss ${x.roundTripLossPct}%`);
    if (m && m.ageHours != null && m.ageHours < 1) caution.push('Pool is less than 1 hour old');
    if (m && m.sells5m > m.buys5m * 1.5) caution.push('Sellers heavily outnumber buyers right now');
    if (!m) caution.push('No DEX market data found');
    if (hist.flaggedByMosn) caution.push(`MOSN flagged it before: ${hist.flagReason}`);

    return { verdict: danger.length ? 'DANGER' : caution.length ? 'CAUTION' : 'SAFE', reasons: [...danger, ...caution] };
}

const cache = new Map(); // mint → { at, body }
async function tokenCheck(mint) {
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.at < 60_000) return hit.body;
    const [a, h, m, x] = await Promise.all([
        authorities(mint),
        withAnyRpc(c => holderConcentration(c, mint)).catch(() => null),
        market(mint).catch(() => null),
        exitTest(mint)
    ]);
    const hist = mosnHistory(mint);
    let v = verdict(a, h, m, x, hist);
    // v3.1: well-known issuer-backed tokens (stablecoins, major liquid-staked SOL) keep mint/freeze powers BY DESIGN — not a rug signal
    const ISSUER = { 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC (Circle)', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': 'USDT (Tether)', '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD (PayPal/Paxos)', 'So11111111111111111111111111111111111111112': 'Wrapped SOL', 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn': 'JitoSOL', 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So': 'mSOL (Marinade)', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN': 'JUP (Jupiter)' };
    if (ISSUER[mint]) v = { verdict: 'SAFE', reasons: [`Well-known token: ${ISSUER[mint]}. Any mint/freeze authority is held by the issuer by design — not a rug signal.`, ...v.reasons.filter(r => !/authority|freeze|mint/i.test(r)).slice(0, 2)] };
    const body = {
        mint, checkedAt: new Date().toISOString(), ...v,
        authorities: a,
        holders: h ? { topWalletPct: +h.top1.toFixed(2), top10WalletsPct: +h.top10.toFixed(2), note: 'Pool/program accounts excluded' } : null,
        market: m, exit: x, mosnHistory: hist,
        disclaimer: 'Automated risk signals, not financial advice.'
    };
    cache.set(mint, { at: Date.now(), body });
    return body;
}

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR });
// v3.4: COINBASE (CDP) facilitator first — payments settled through it get MOSN listed in the Coinbase x402 Bazaar.
// PayAI stays as the backup. If Coinbase doesn't answer at startup, MOSN runs on PayAI alone (never crashes).
let facilitators = [facilitator];
if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET) {
    try {
        const { createFacilitatorConfig } = await import('@coinbase/x402');
        const cdp = new HTTPFacilitatorClient(createFacilitatorConfig(process.env.CDP_API_KEY_ID, process.env.CDP_API_KEY_SECRET));
        const sup = await Promise.race([cdp.getSupported(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 12000))]);
        const nets = [...new Set((sup?.kinds || []).map(k => k.network))];
        facilitators = [cdp, facilitator];
        console.log(`[${new Date().toLocaleTimeString()}] [CDP] ✅ Coinbase facilitator connected (networks: ${nets.join(', ') || '?'}) — PayAI kept as backup`);
    } catch (e) { console.log(`[${new Date().toLocaleTimeString()}] [CDP] ⚠️ Coinbase facilitator not available (${String(e.message).slice(0, 120)}) — using PayAI only`); }
}
const resourceServer = new x402ResourceServer(facilitators).register(NETWORK, new ExactSvmScheme());
if (BASE_PAY_TO) resourceServer.register(BASE_NETWORK, new ExactEvmScheme());
// every paid route accepts Solana USDC, and Base USDC when a Base address is set
const acceptsFor = price => [
    { scheme: 'exact', price, network: NETWORK, payTo },
    ...(BASE_PAY_TO ? [{ scheme: 'exact', price, network: BASE_NETWORK, payTo: BASE_PAY_TO }] : [])
];

const example = { mint: 'So11111111111111111111111111111111111111112', verdict: 'CAUTION', reasons: ['Top 10 wallets hold 41.2%'] };
const routes = {
    'GET /token-check': {
        accepts: acceptsFor(PRICE),
        description: 'Solana token rug/safety check: mint & freeze authority, dangerous Token-2022 settings, real-wallet holder concentration (pools excluded), sell-route round-trip test, live buy/sell flow. Verdict SAFE/CAUTION/DANGER with reasons. First 5 checks per day are FREE (no payment, no signup).',
        mimeType: 'application/json',
        // this x402 version wants the address as a plain string, with name/tags as their own fields
        resource: `${PUBLIC_URL}/token-check`,
        serviceName: 'MOSN Token Safety',
        tags: ['solana', 'token', 'security', 'rugcheck', 'trading'],
        extensions: {
            ...declareDiscoveryExtension({
                input: { mint: 'So11111111111111111111111111111111111111112' },
                inputSchema: { properties: { mint: { type: 'string', description: 'Solana token mint address to check' } }, required: ['mint'] },
                output: {
                    example,
                    schema: { type: 'object', properties: { mint: { type: 'string' }, verdict: { type: 'string', enum: ['SAFE', 'CAUTION', 'DANGER'] }, reasons: { type: 'array', items: { type: 'string' } } } }
                }
            })
        }
    },
    'GET /new-pools': {
        accepts: acceptsFor(PRICE_POOLS),
        description: 'Brand-new Solana pools (PumpSwap + Raydium CPMM) detected in real time from on-chain pool-creation logs, newest first, with live liquidity/volume/price change where DEX data exists. Optional ?minutes=1-120 (default 15).',
        mimeType: 'application/json',
        resource: `${PUBLIC_URL}/new-pools`,
        serviceName: 'MOSN New Solana Pools',
        tags: ['solana', 'new-tokens', 'sniper', 'memecoins', 'realtime', 'trading'],
        extensions: { ...declareDiscoveryExtension({
            input: { minutes: 15 },
            inputSchema: { properties: { minutes: { type: 'number', description: 'Look-back window in minutes (1-120)' } } },
            output: { example: { count: 1, pools: [{ mint: 'So11111111111111111111111111111111111111112', seenSecondsAgo: 42, symbol: 'EX', liquidityUsd: 12000 }] } }
        }) }
    },
    'GET /alpha': {
        accepts: acceptsFor(PRICE_ALPHA),
        description: 'Fresh Solana alpha: up to 10 brand-new tokens MOSN screened in the last 5-120 minutes (default 30) that PASSED its rug/scam check, real-wallet holder check and buy/sell-flow filters — with MOSN AI verdict, confidence and reason, plus live price/liquidity/flow now.',
        mimeType: 'application/json',
        resource: `${PUBLIC_URL}/alpha`,
        serviceName: 'MOSN Fresh Solana Alpha',
        tags: ['solana', 'alpha', 'memecoins', 'new-tokens', 'screened', 'signals', 'trading'],
        extensions: { ...declareDiscoveryExtension({
            input: { minutes: 30 },
            inputSchema: { properties: { minutes: { type: 'number', description: 'Look-back window in minutes (5-120)' } } },
            output: { example: { count: 1, tokens: [{ mint: '...', symbol: 'EX', topWalletPct: 1.2, mosnAi: { decision: 'SKIP', confidence: 55 }, now: { m5ChangePct: 12.3 } }] } }
        }) }
    },
    'GET /dataset': {
        accepts: acceptsFor(PRICE_DATASET),
        description: 'Labeled Solana new-token dataset: every fresh token MOSN screened in the last 1-72 hours (default 24) — liquidity, volume, flow, holder concentration, age, socials, AI verdict — joined with its price change 5/10/15 minutes later. Up to 2000 rows of JSON. For training and backtesting memecoin models.',
        mimeType: 'application/json',
        resource: `${PUBLIC_URL}/dataset`,
        serviceName: 'MOSN Labeled Memecoin Dataset',
        tags: ['solana', 'dataset', 'machine-learning', 'backtesting', 'memecoins', 'labeled-data'],
        extensions: { ...declareDiscoveryExtension({
            input: { hours: 24 },
            inputSchema: { properties: { hours: { type: 'number', description: 'Look-back window in hours (1-72)' } } },
            output: { example: { rows: 1, labeledRows: 1, data: [{ mint: '...', ageMin: 1, liquidityUsd: 40000, top10Pct: 4.5, aiDecision: 'SKIP', after15mPct: 28.8 }] } }
        }) }
    },
    'GET /holders': {
        accepts: acceptsFor(PRICE_HOLDERS),
        description: 'Solana token holder concentration from REAL wallets only (liquidity pools and program accounts excluded): top wallet %, top-10 %, whale/insider flag.',
        mimeType: 'application/json',
        resource: `${PUBLIC_URL}/holders`,
        serviceName: 'MOSN Holder Check',
        tags: ['solana', 'holders', 'whales', 'insiders', 'rugcheck'],
        extensions: { ...declareDiscoveryExtension({
            input: { mint: 'So11111111111111111111111111111111111111112' },
            inputSchema: { properties: { mint: { type: 'string', description: 'Solana token mint address' } }, required: ['mint'] },
            output: { example: { mint: '...', topWalletPct: 3.4, top10WalletsPct: 21.4, whaleRisk: false, reason: null } }
        }) }
    }
};

const app = express();
app.set('trust proxy', true); // honor Render's X-Forwarded-* so CDP-derived x402 resource URLs are https + correct host
app.get('/', (_q, res) => res.json({ service: 'MOSN Solana Data API', tryFree: `${PUBLIC_URL}/token-check?mint=<SOLANA_MINT> — ${Number(process.env.API_FREE_PER_DAY || 5)} free checks per day, no payment or signup`, paidRoutes: menu(), payWith: BASE_PAY_TO ? 'USDC on Solana or Base (x402)' : 'USDC on Solana (x402)', docs: `${PUBLIC_URL}/openapi.json` }));
app.get('/health', (_q, res) => res.json({ ok: true }));
// v2: machine-readable menu so agents and directories can find every paid route
const menu = () => Object.entries(routes).map(([k, r]) => ({ method: k.split(' ')[0], path: k.split(' ')[1], url: r.resource, name: r.serviceName, description: r.description, price: r.accepts[0].price, networks: r.accepts.map(a => a.network), tags: r.tags }));
// v2.4: proof that MOSN controls this domain (official MCP Registry 'HTTP' auth). Public key only.
app.get('/.well-known/mcp-registry-auth', (_q, res) => { try { res.type('text/plain').send(fs.readFileSync('./mcp-registry-auth', 'utf8')); } catch { res.status(404).end(); } });
app.get('/.well-known/x402', (_q, res) => res.json({ x402Version: 2, provider: 'MOSN', resources: menu() }));
// v2.1: discovery for AI agents — A2A agent card + llms.txt, so agent crawlers and LLM tools can find and use MOSN
app.get(['/.well-known/agent.json', '/.well-known/agent-card.json'], (_q, res) => res.json({
    name: 'MOSN', description: 'Autonomous Solana agent selling pay-per-call token intelligence: rug/safety checks, real-wallet holder concentration, and a real-time new-pool feed. Pay per call with USDC via x402 (Solana or Base).',
    url: PUBLIC_URL, version: '2.1.0', provider: { organization: 'MOSN' },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'],
    payments: { protocol: 'x402', networks: [NETWORK, ...(BASE_PAY_TO ? [BASE_NETWORK] : [])], asset: 'USDC' },
    skills: menu().map(m => ({ id: m.path.replace('/', ''), name: m.name, description: `${m.description} Price ${m.price} per call. ${m.method} ${m.url}`, tags: m.tags }))
}));
// v3.2: MOSN TERMINAL — private live dashboard (needs ?k=TERMINAL_KEY; anything else = 404)
const termOk = req => process.env.TERMINAL_KEY && req.query.k === process.env.TERMINAL_KEY;
app.get('/terminal', (req, res) => termOk(req) ? res.sendFile(new URL('./mosn_terminal.html', import.meta.url).pathname) : res.status(404).end());
app.get('/terminal/data', (req, res) => { if (!termOk(req)) return res.status(404).end(); try { res.set('Cache-Control', 'no-store').type('json').send(fs.readFileSync('./terminal_state.json', 'utf8')); } catch { res.status(503).json({ error: 'MOSN has not written its state yet' }); } });
app.get(['/logo.png','/avatar.png'], (_q, res) => res.sendFile(new URL('./mosn_avatar.png', import.meta.url).pathname));
app.get('/llms.txt', (_q, res) => res.type('text/plain').send([
    '# MOSN Solana Data API', '', '> Pay-per-call Solana token intelligence for AI agents and trading bots. Payment: USDC via x402 (Solana or Base). No API key, no signup.', '',
    '## Pay with SOL (prepaid key)', 'Buy 2,000 or 20,000 calls with SOL in Telegram: https://t.me/MOSNSafeSwapBot → /api. Then send header x-mosn-key: <key> (or ?key=<key>). Costs: token-check 1, holders 1, new-pools 2, alpha 10, dataset 50 credits.', '', '## Try free', `GET ${PUBLIC_URL}/token-check?mint=<mint> — 5 free Solana rug checks per day, no payment or signup. After that, pay per call with x402.`, '',
    '## Paid endpoints', ...menu().map(m => `- [${m.name}](${m.url}): ${m.description} Price ${m.price}.`), '',
    `- [MOSN Safe Swap](${PUBLIC_URL}/safe-swap?mint=<mint>&side=buy&amountSol=0.1&wallet=<your pubkey>): FREE. Safety-checks the token, refuses DANGER buys, returns an unsigned Jupiter swap for your wallet (${SWAP_FEE_BPS / 100}% fee).`, '',
    `- MCP server (for Claude, Cursor, any MCP agent): ${PUBLIC_URL}/mcp — tools: mosn_token_check, mosn_safe_swap, mosn_paid_endpoints`, '',
    '- Free alerts channel: https://t.me/MOSNAlpha', 
    '- Telegram bot for people: https://t.me/MOSNSafeSwapBot — rug check + one-tap buy/sell in your own wallet (0.5% fee).', '',
    '## Machine-readable', `- [OpenAPI](${PUBLIC_URL}/openapi.json)`, `- [x402 manifest](${PUBLIC_URL}/.well-known/x402)`, `- [Agent card](${PUBLIC_URL}/.well-known/agent.json)`
].join('\n')));
app.get('/openapi.json', (_q, res) => res.json({
    openapi: '3.0.3',
    info: { title: 'MOSN Solana Data API', version: '2.0.0', description: 'Pay-per-call Solana token intelligence for agents and trading bots. Paid with USDC via x402 (Solana or Base).' },
    servers: [{ url: PUBLIC_URL }],
    paths: {
        '/token-check': { get: { summary: routes['GET /token-check'].description, parameters: [{ name: 'mint', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Verdict SAFE/CAUTION/DANGER with reasons' }, 402: { description: 'Payment required (x402)' } } } },
        '/new-pools': { get: { summary: routes['GET /new-pools'].description, parameters: [{ name: 'minutes', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 120 } }], responses: { 200: { description: 'List of new pools' }, 402: { description: 'Payment required (x402)' } } } },
        '/alpha': { get: { summary: routes['GET /alpha'].description, parameters: [{ name: 'minutes', in: 'query', required: false, schema: { type: 'integer', minimum: 5, maximum: 120 } }], responses: { 200: { description: 'Screened fresh tokens' }, 402: { description: 'Payment required (x402)' } } } },
        '/dataset': { get: { summary: routes['GET /dataset'].description, parameters: [{ name: 'hours', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 72 } }], responses: { 200: { description: 'Labeled rows' }, 402: { description: 'Payment required (x402)' } } } },
        '/safe-swap': { get: { summary: `FREE to call. Runs MOSN's full safety check, refuses buys into DANGER tokens, then returns an unsigned Jupiter swap transaction for your wallet (MOSN takes a ${SWAP_FEE_BPS / 100}% platform fee in SOL).`, parameters: ['mint', 'side', 'wallet', 'amountSol', 'amountRaw', 'slippageBps'].map(n => ({ name: n, in: 'query', required: ['mint', 'wallet'].includes(n), schema: { type: 'string' } })), responses: { 200: { description: 'Unsigned swap transaction + safety verdict' }, 403: { description: 'Refused: DANGER token' } } } },
        '/holders': { get: { summary: routes['GET /holders'].description, parameters: [{ name: 'mint', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Holder concentration' }, 402: { description: 'Payment required (x402)' } } } }
    }
}));
app.use('/holders', (req, res, next) => {
    const creds = req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-mosn-key'] || req.query.key;
    try { new PublicKey(String(req.query.mint || '')); return next(); }
    catch { return creds ? res.status(400).json({ error: 'Pass ?mint=<valid Solana token mint address>' }) : next(); }
});
// validate input BEFORE charging anyone — but let an UNPAID x402 discovery probe (no mint) reach the 402 challenge, so the Bazaar can read our payment metadata
app.use('/token-check', (req, res, next) => {
    const creds = req.headers['payment-signature'] || req.headers['x-payment'] || req.headers['x-mosn-key'] || req.query.key;
    try { new PublicKey(String(req.query.mint || '')); return next(); }
    catch { return creds ? res.status(400).json({ error: 'Pass ?mint=<valid Solana token mint address>' }) : next(); }
});
// log rejected payments with the reason, so problems are visible in mosn_api.log
app.use(['/token-check', '/new-pools', '/holders', '/alpha', '/dataset'], (req, res, next) => {
    const paid = req.headers['payment-signature'] || req.headers['x-payment'];
    if (paid) res.on('finish', () => {
        if (res.statusCode === 402) {
            let why = res.getHeader('payment-required') || '';
            try { why = JSON.stringify(JSON.parse(Buffer.from(String(why), 'base64').toString('utf8')).error || why); } catch (_) {}
            console.log(`[${new Date().toLocaleTimeString()}] [X402_REJECTED] payment refused: ${String(why).slice(0, 300)}`);
        }
    });
    next();
});
// v2: internal (free) access for MOSN's own workers — loopback only + secret key. Never exposed publicly.
app.get('/internal/:what', async (req, res) => {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    if (!local || !process.env.INTERNAL_API_KEY || req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY || req.headers['cf-connecting-ip']) return res.status(404).end();
    try {
        const w = req.params.what, mint = String(req.query.mint || '');
        if (!['new-pools', 'alpha', 'dataset'].includes(w)) new PublicKey(mint);
        if (w === 'token-check') return res.json(await tokenCheck(mint));
        if (w === 'holders') return res.json(await holdersData(mint));
        if (w === 'new-pools') return res.json(await newPoolsData(req.query.minutes));
        if (w === 'alpha') return res.json(await alphaData(req.query.minutes));
        if (w === 'dataset') return res.json(datasetData(req.query.hours));
        res.status(404).end();
    } catch (e) { res.status(400).json({ error: String(e.message).slice(0, 120) }); }
});
// v2.5: SWAP PAGE — opened inside Phantom / Solflare (or any browser with a Solana wallet). The user connects THEIR wallet,
// MOSN safety-checks the token, builds the swap, and the user signs it. MOSN never holds keys or funds.
app.get('/swap', (req, res) => {
    const esc = v => String(v || '').replace(/[^A-Za-z0-9._-]/g, '');
    const mint = esc(req.query.mint), side = req.query.side === 'sell' ? 'sell' : 'buy', amt = Number(req.query.amount) || 0.1;
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOSN Safe Swap</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0f14;color:#e8eef5;margin:0;padding:20px;max-width:480px;margin:auto}
.c{background:#141b24;border-radius:14px;padding:18px;margin:12px 0}button{width:100%;padding:14px;border:0;border-radius:10px;font-size:17px;font-weight:600;background:#14f195;color:#000;margin-top:10px}
button:disabled{opacity:.5}.s{color:#9fb0c3;font-size:14px}.v{font-size:22px;font-weight:700}.SAFE{color:#14f195}.CAUTION{color:#ffcc4d}.DANGER{color:#ff5c5c}code{word-break:break-all;font-size:12px}</style></head>
<body><h2>🛡️ MOSN Safe Swap</h2><div class="c"><div class="s">${side === 'buy' ? 'Buy' : 'Sell'} token</div><code>${mint}</code>
<div class="s" style="margin-top:8px">${side === 'buy' ? 'Amount: <b>' + amt + ' SOL</b>' : 'Amount: <b>' + (Number(req.query.pct) || 100) + '% of your tokens</b>'}</div></div>
<div class="c" id="chk"><div class="s">Safety check…</div></div><button id="go" disabled>Connect wallet</button>
<p class="s">MOSN checks the token, builds the trade, and <b>you sign it in your own wallet</b>. MOSN never holds your keys or funds. Fee ${BOT_FEE_BPS / 100}%. New tokens are very risky — not financial advice.</p>
<script src="https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js"></script><script>
const mint=${JSON.stringify(mint)},side=${JSON.stringify(side)},amt=${amt},pct=${Number(req.query.pct) || 100};
const W=()=>window.phantom?.solana||window.solflare||window.solana;const go=document.getElementById('go'),chk=document.getElementById('chk');
fetch('/safe-swap-check?mint='+mint).then(r=>r.json()).then(j=>{chk.innerHTML='<div class="v '+j.verdict+'">'+j.verdict+'</div><div class="s">'+((j.reasons||[]).slice(0,4).join('<br>')||'No red flags found')+'</div>';
 if(j.verdict==='DANGER'&&side==='buy'){go.textContent='Blocked: DANGER token';go.disabled=true;}else{go.disabled=false;}}).catch(()=>{chk.innerHTML='<div class="s">Check unavailable</div>';go.disabled=false;});
go.onclick=async()=>{try{const w=W();if(!w){go.textContent='Open this page in Phantom or Solflare';return;}
 go.disabled=true;go.textContent='Connecting…';const c=await w.connect();const pk=(c?.publicKey||w.publicKey).toString();
 let q='/safe-swap?src=bot&mint='+mint+'&side='+side+'&wallet='+pk;
 if(side==='buy')q+='&amountSol='+amt;else{const r=await fetch('/token-balance?mint='+mint+'&wallet='+pk).then(r=>r.json());if(!r.raw||r.raw==='0'){go.textContent='You hold none of this token';return;}q+='&amountRaw='+(BigInt(r.raw)*BigInt(pct)/100n).toString();}
 go.textContent='Building trade…';const j=await fetch(q).then(r=>r.json());if(j.refused||!j.swapTransaction){go.textContent=j.refused?'Blocked: DANGER token':('Error: '+(j.error||'no route'));return;}
 const tx=solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(atob(j.swapTransaction),c=>c.charCodeAt(0)));
 go.textContent='Approve in your wallet…';const r=await w.signAndSendTransaction(tx);const sig=r.signature||r;
 go.textContent='✅ Sent!';chk.innerHTML+='<p class="s"><a style="color:#14f195" href="https://solscan.io/tx/'+sig+'">View on Solscan</a></p>';fetch('/swap-done?side='+side+'&sig='+sig);
}catch(e){go.disabled=false;go.textContent='Try again ('+(e.message||e).toString().slice(0,60)+')';}};
</script></body></html>`);
});
app.get('/safe-swap-check', async (req, res) => { try { new PublicKey(String(req.query.mint || '')); const c = await tokenCheck(String(req.query.mint)); res.json({ verdict: c.verdict, reasons: c.reasons }); } catch (e) { res.status(400).json({ error: 'bad mint' }); } });
app.get('/token-balance', async (req, res) => {
    try {
        const owner = new PublicKey(String(req.query.wallet)), mint = new PublicKey(String(req.query.mint));
        const r = await withAnyRpc(c => c.getParsedTokenAccountsByOwner(owner, { mint }));
        const raw = r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
        res.json({ raw: raw.toString() });
    } catch (e) { res.status(400).json({ error: 'bad input' }); }
});
app.get('/swap-done', (req, res) => { console.log(`[${new Date().toLocaleTimeString()}] [SWAP_DONE] 💸 ${req.query.side === 'sell' ? 'Sell' : 'Buy'} signed by a user ${String(req.query.sig || '').slice(0, 12)}…`); res.json({ ok: true }); });

// v2.4: REMOTE MCP SERVER — lets Claude, Cursor and any MCP-capable AI agent use MOSN as a tool.
// Free tools: safe swap (MOSN earns the swap fee), token check (5 free/day per caller, then use the paid x402 route).
app.use('/mcp', express.json({ limit: '64kb' }));
const mcpFree = new Map(); // caller → { day, n }
const MCP_TOOLS = [
    { name: 'mosn_token_check', description: 'Rug/safety check for a Solana token: mint & freeze authority, dangerous Token-2022 settings, real-wallet holder concentration (pools excluded), live sell-route test. Returns SAFE/CAUTION/DANGER with reasons. 5 free checks per day, then use the paid x402 endpoint.',
      inputSchema: { type: 'object', properties: { mint: { type: 'string', description: 'Solana token mint address' } }, required: ['mint'] } },
    { name: 'mosn_safe_swap', description: `Build a Solana token swap that is safety-checked first: MOSN refuses buys into DANGER tokens, then returns an unsigned Jupiter swap transaction for YOUR wallet to sign (MOSN takes a ${SWAP_FEE_BPS / 100}% platform fee). Free to call.`,
      inputSchema: { type: 'object', properties: { mint: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, wallet: { type: 'string', description: 'Your Solana wallet public key' }, amountSol: { type: 'number', description: 'For buys: SOL to spend' }, amountRaw: { type: 'string', description: 'For sells: token amount in base units' }, slippageBps: { type: 'number' } }, required: ['mint', 'side', 'wallet'] } },
    { name: 'mosn_paid_endpoints', description: 'List MOSN paid data endpoints (x402, USDC on Solana or Base): fresh screened Solana alpha, real-time new pools, holder checks, labeled memecoin dataset.',
      inputSchema: { type: 'object', properties: {} } }
];
app.get('/mcp', (_q, res) => res.json({ name: 'MOSN', transport: 'streamable-http (POST JSON-RPC to this URL)', tools: MCP_TOOLS.map(t => t.name) }));
app.post('/mcp', async (req, res) => {
    const m = req.body || {}; const id = m.id ?? null;
    const ok = result => res.json({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => res.json({ jsonrpc: '2.0', id, error: { code, message } });
    try {
        if (m.method === 'initialize') return ok({ protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mosn', version: '2.4.0' }, instructions: 'MOSN: Solana token safety + safe swaps. Always run mosn_token_check before buying new tokens.' });
        if (m.method === 'notifications/initialized' || (m.method || '').startsWith('notifications/')) return res.status(202).end();
        if (m.method === 'ping') return ok({});
        if (m.method === 'tools/list') return ok({ tools: MCP_TOOLS });
        if (m.method === 'tools/call') {
            const name = m.params?.name, a = m.params?.arguments || {};
            const text = obj => ok({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
            if (name === 'mosn_paid_endpoints') return text({ payWith: 'x402 (USDC on Solana or Base)', endpoints: menu(), docs: `${PUBLIC_URL}/openapi.json` });
            if (name === 'mosn_safe_swap') { const body = await safeSwapData(a); console.log(`[${new Date().toLocaleTimeString()}] [SAFE_SWAP] (MCP) ${body.refused ? 'refused DANGER' : 'built ' + body.side}`); return text(body); }
            if (name === 'mosn_token_check') {
                const who = callerOf(req); const day = new Date().toISOString().slice(0, 10);
                const u = mcpFree.get(who); const n = u && u.day === day ? u.n : 0;
                if (n >= 5) return text({ limit: 'Free daily checks used. Unlimited checks: pay-per-call x402 endpoint', url: `${PUBLIC_URL}/token-check?mint=${a.mint}`, price: PRICE });
                new PublicKey(String(a.mint || ''));
                mcpFree.set(who, { day, n: n + 1 });
                console.log(`[${new Date().toLocaleTimeString()}] [MCP] free token check ${n + 1}/5`);
                return text(await tokenCheck(String(a.mint)));
            }
            return fail(-32602, 'Unknown tool');
        }
        return fail(-32601, 'Method not found');
    } catch (e) { return fail(-32000, String(e.response?.data?.error || e.message).slice(0, 160)); }
});

// v2.3: Safe Swap is FREE to call (MOSN earns the swap fee instead). 20 calls/min per caller.
app.get('/safe-swap', async (req, res) => {
    const ip = callerOf(req);
    const now = Date.now(); const hits = (swapHits.get(ip) || []).filter(t => now - t < 60_000); hits.push(now); swapHits.set(ip, hits);
    if (hits.length > 20) return res.status(429).json({ error: 'Slow down: 20 calls per minute' });
    try {
        const body = await safeSwapData(req.query);
        console.log(`[${new Date().toLocaleTimeString()}] [SAFE_SWAP] ${body.refused ? '🛑 refused DANGER' : '🔁 built ' + body.side + ' (fee ' + body.platformFeeBps + ' bps)'} ${String(req.query.mint).slice(0, 8)}…`);
        res.status(body.refused ? 403 : 200).json(body);
    } catch (e) { res.status(400).json({ error: String(e.response?.data?.error || e.message).slice(0, 160) }); }
});
// v3.3: PREPAID KEYS — buyers who paid SOL in @MOSNSafeSwapBot (/api) send  x-mosn-key: <key>  (or ?key=). Each call uses credits.
startKeyStore();
let keySales = 0;
const keyed = (path, run) => app.get(path, async (req, res, next) => {
    const key = req.headers['x-mosn-key'] || req.query.key;
    if (!key) return next();
    const r = spend(String(key), COST[path]);
    if (!r.ok) return res.status(402).json({ error: `MOSN key: ${r.why}. Top up in Telegram: https://t.me/MOSNSafeSwapBot → /api` });
    try {
        const body = await run(req);
        res.set('X-MOSN-Credits-Remaining', String(r.left)); res.json(body);
        if (++keySales % 50 === 1) console.log(`[${new Date().toLocaleTimeString()}] [KEY_CALL] 🔑 prepaid-key call ${path} (${r.left} credits left on that key)`);
    } catch (e) { spend(String(key), -COST[path]); res.status(502).json({ error: `Check failed: ${String(e.message).slice(0, 100)}` }); } // failed call → credits back
});
keyed('/token-check', req => tokenCheck(String(req.query.mint)));
keyed('/holders', req => holdersData(String(req.query.mint)));
keyed('/new-pools', req => newPoolsData(req.query.minutes));
keyed('/alpha', req => alphaData(req.query.minutes));
keyed('/dataset', req => datasetData(req.query.hours));

// v3.0: FREE TIER — every caller gets FREE_PER_DAY token checks a day on the normal /token-check URL, no payment needed.
// After that the usual x402 payment applies. Lets developers and agents try MOSN before they pay.
// v3.2 FIX: behind the Cloudflare forwarder every request carried the WORKER's IP, so all callers shared ONE free quota.
// The forwarder now passes the real caller's IP in x-mosn-client-ip.
function callerOf(req) { return String(req.headers['x-mosn-client-ip'] || req.headers['cf-connecting-ip'] || req.socket.remoteAddress); }
const FREE_PER_DAY = Number(process.env.API_FREE_PER_DAY || 5);
const freeUse = new Map(); // caller → { day, n }
let freeServed = 0;
app.get('/token-check', async (req, res, next) => {
    if (req.headers['payment-signature'] || req.headers['x-payment']) return next(); // paying → normal paid path
    try { new PublicKey(String(req.query.mint || '')); } catch { return next(); } // no valid mint → let the x402 layer answer (402 discovery probe)
    const who = callerOf(req), day = new Date().toISOString().slice(0, 10);
    const u = freeUse.get(who), n = u && u.day === day ? u.n : 0;
    if (n >= FREE_PER_DAY) return next(); // quota used → 402 payment challenge
    if (freeUse.size > 20000) freeUse.clear();
    freeUse.set(who, { day, n: n + 1 });
    try {
        const body = await tokenCheck(String(req.query.mint));
        freeServed++;
        console.log(`[${new Date().toLocaleTimeString()}] [FREE_CHECK] 🆓 free token check ${n + 1}/${FREE_PER_DAY} (${String(req.query.mint).slice(0, 8)}… → ${body.verdict})`);
        res.set('X-MOSN-Free-Remaining', String(FREE_PER_DAY - n - 1));
        res.json({ ...body, freeTier: { usedToday: n + 1, limitPerDay: FREE_PER_DAY, afterThat: `pay-per-call ${PRICE} via x402 (USDC on Solana or Base)` } });
    } catch (e) { freeUse.set(who, { day, n }); res.status(502).json({ error: `Check failed: ${String(e.message).slice(0, 100)}` }); } // a failed check doesn't use up a free one
});
app.get('/stats', (_q, res) => res.json({ service: 'MOSN Solana Data API', freeChecksServedThisRun: freeServed, paidSalesThisRun: sales, freePerDay: FREE_PER_DAY }));

app.use(paymentMiddleware(routes, resourceServer));

let sales = 0;
app.get('/token-check', async (req, res) => {
    try {
        const body = await tokenCheck(String(req.query.mint));
        sale('token check', PRICE, `${body.mint.slice(0, 8)}… → ${body.verdict}`);
        res.json(body);
    } catch (e) {
        res.status(502).json({ error: `Check failed: ${String(e.message).slice(0, 100)}` });
    }
});

function sale(what, price, extra = '') {
    sales++;
    console.log(`[${new Date().toLocaleTimeString()}] [X402_SALE] 💰 Paid ${what} #${sales}${extra ? ': ' + extra : ''}`);
    phone(`💰 Sale! Someone paid ${price} for ${what} (#${sales} this run)${extra ? ' → ' + extra : ''}`);
}

async function newPoolsData(minutesArg) {
        const minutes = Math.max(1, Math.min(120, Number(minutesArg) || 15));
        let pools = [];
        try { pools = JSON.parse(fs.readFileSync('./new_pools.json', 'utf8')).pools || []; } catch (_) {}
        pools = pools.filter(p => Date.now() - p.seenAt <= minutes * 60_000).sort((a, b) => b.seenAt - a.seenAt).slice(0, 60);
        const md = new Map();
        for (let i = 0; i < pools.length; i += 30) {
            try {
                const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${pools.slice(i, i + 30).map(p => p.mint).join(',')}`, { timeout: 6000 });
                for (const p of pickBestPairs(r.data?.pairs)) md.set(p.baseToken?.address, p);
            } catch (_) {}
        }
        const out = pools.map(p => {
            const m = md.get(p.mint);
            return {
                mint: p.mint, seenAt: new Date(p.seenAt).toISOString(), seenSecondsAgo: Math.round((Date.now() - p.seenAt) / 1000),
                symbol: m?.baseToken?.symbol || null, dex: m?.dexId || null, priceUsd: m ? Number(m.priceUsd || 0) : null,
                liquidityUsd: m ? Number(m.liquidity?.usd || 0) : null, volume5mUsd: m ? Number(m.volume?.m5 || 0) : null,
                change5mPct: m ? Number(m.priceChange?.m5 || 0) : null, buys5m: m?.txns?.m5?.buys ?? null, sells5m: m?.txns?.m5?.sells ?? null
            };
        });
        return { windowMinutes: minutes, count: out.length, pools: out, note: 'Fresh pools are extremely risky. Run /token-check before buying. Not financial advice.' };
}
app.get('/new-pools', async (req, res) => {
    try {
        const body = await newPoolsData(req.query.minutes);
        sale('new-pools feed', PRICE_POOLS, `${body.count} pools`);
        res.json(body);
    } catch (e) { res.status(502).json({ error: String(e.message).slice(0, 100) }); }
});

// v2.2: FRESH SOLANA ALPHA — new tokens MOSN already screened in the last N minutes that PASSED its scam check,
// holder check and flow filters, with the AI verdict and live market data.
function readTail(file, bytes = 400_000) {
    try {
        const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
        const len = Math.min(bytes, size); const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
        return buf.toString('utf8').split('\n').slice(1);
    } catch { return []; }
}
async function alphaData(minutesArg) {
    const minutes = Math.max(5, Math.min(120, Number(minutesArg) || 30));
    const cut = Date.now() - minutes * 60_000;
    const seen = new Map();
    for (const l of readTail('./mosn_decisions.jsonl')) {
        let d; try { d = JSON.parse(l); } catch { continue; }
        if (!d?.mint || d.ts < cut) continue;
        seen.set(d.mint, d); // keep the latest look at each token
    }
    let picks = [...seen.values()];
    const md = new Map();
    for (let i = 0; i < picks.length; i += 30) {
        try {
            const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${picks.slice(i, i + 30).map(p => p.mint).join(',')}`, { timeout: 6000 });
            for (const p of pickBestPairs(r.data?.pairs)) md.set(p.baseToken?.address, p);
        } catch (_) {}
    }
    picks = picks.map(d => {
        const m = md.get(d.mint);
        const nowPrice = m ? Number(m.priceUsd || 0) : null;
        return {
            mint: d.mint, symbol: d.symbol, screenedAt: new Date(d.ts).toISOString(), ageMinAtScreen: d.ageMin,
            passed: ['scam check (mint/freeze authority, Token-2022 settings)', 'real-wallet holder concentration', 'buy/sell flow', 'volume/liquidity corridor'],
            topWalletPct: +Number(d.top1 || 0).toFixed(2), top10WalletsPct: +Number(d.top10 || 0).toFixed(2),
            atScreen: { liquidityUsd: Math.round(d.liq || 0), m5ChangePct: d.m5Change, buys5m: d.buys, sells5m: d.sells },
            now: m ? { priceUsd: nowPrice, liquidityUsd: Number(m.liquidity?.usd || 0), m5ChangePct: Number(m.priceChange?.m5 || 0), h1ChangePct: Number(m.priceChange?.h1 || 0), buys5m: m.txns?.m5?.buys ?? null, sells5m: m.txns?.m5?.sells ?? null } : null,
            mosnAi: { decision: d.decision, confidence: d.confidence, rationale: d.rationale }
        };
    }).filter(x => x.now && x.now.liquidityUsd > 5000)
      .sort((a, b) => (b.mosnAi.decision === 'BUY') - (a.mosnAi.decision === 'BUY') || b.mosnAi.confidence - a.mosnAi.confidence || b.now.m5ChangePct - a.now.m5ChangePct)
      .slice(0, 10);
    return { windowMinutes: minutes, count: picks.length, tokens: picks, note: 'Screened by MOSN in real time. New tokens are extremely risky (about 1 in 4 rugs). Not financial advice.' };
}

// v2.3: LABELED DATASET — every new token MOSN screened (features + AI verdict) joined with what the price did
// 5/10/15 min later (shadow tracking). Useful to anyone training a memecoin model. No wallet addresses of people.
function datasetData(hoursArg) {
    const hours = Math.max(1, Math.min(72, Number(hoursArg) || 24));
    const cut = Date.now() - hours * 3600_000;
    const outcome = new Map();
    for (const l of readTail('./shadow_skips.jsonl', 3_000_000)) { try { const r = JSON.parse(l); if (r.at >= cut - 3600_000) outcome.set(r.mint, r); } catch (_) {} }
    const rows = [];
    for (const l of readTail('./mosn_decisions.jsonl', 6_000_000)) {
        let d; try { d = JSON.parse(l); } catch { continue; }
        if (!d?.mint || d.ts < cut) continue;
        const o = outcome.get(d.mint);
        rows.push({ ts: new Date(d.ts).toISOString(), mint: d.mint, symbol: d.symbol, ageMin: d.ageMin, liquidityUsd: Math.round(d.liq || 0), volume5mUsd: Math.round(d.volumeM5 || 0),
            volRatio: +Number(d.volRatio || 0).toFixed(3), m5ChangePct: d.m5Change, h1ChangePct: d.h1Change, buys5m: d.buys, sells5m: d.sells, top1Pct: +Number(d.top1 || 0).toFixed(2), top10Pct: +Number(d.top10 || 0).toFixed(2),
            hasSocials: !!d.hasSocials, source: d.source || null, aiDecision: d.decision, aiConfidence: d.confidence,
            after5mPct: o?.m5 ?? null, after10mPct: o?.m10 ?? null, after15mPct: o?.m15 ?? null });
    }
    const labeled = rows.filter(r => r.after15mPct != null).length;
    return { hours, rows: rows.length, labeledRows: labeled, fields: rows[0] ? Object.keys(rows[0]) : [], data: rows.slice(-2000),
        note: 'Tokens that passed MOSN scam + holder screens. Outcomes are price change vs. screen time (capped at +1000%, -100% = gone). Not financial advice.' };
}

// v2.3: SAFE SWAP — any bot can buy/sell a Solana token through MOSN: it runs the full safety check first and REFUSES
// DANGER tokens, then returns an unsigned Jupiter swap for the caller's wallet. MOSN earns a small platform fee (in SOL).
// v2.6: fees land in a separate fee wallet (the trading wallet's wSOL account gets closed by every trade)
const FEE_OWNER = (() => { try { return JSON.parse(fs.readFileSync('./fee_wallet.json', 'utf8')).publicKey; } catch { return payTo; } })();
const feeAta = getAssociatedTokenAddressSync(new PublicKey(WSOL), new PublicKey(FEE_OWNER));
let feeAtaReady = { at: 0, ok: false };
async function feeAccountOk() {
    if (Date.now() - feeAtaReady.at < 60_000) return feeAtaReady.ok;
    const info = await withAnyRpc(c => c.getAccountInfo(feeAta)).catch(() => null);
    feeAtaReady = { at: Date.now(), ok: !!info };
    return feeAtaReady.ok;
}
const swapHits = new Map(); // ip → [timestamps] (simple rate limit)
async function safeSwapData(q) {
    const mint = String(q.mint || ''); const side = String(q.side || 'buy').toLowerCase();
    const wallet = new PublicKey(String(q.wallet || '')).toBase58(); new PublicKey(mint);
    if (!['buy', 'sell'].includes(side)) throw new Error('side must be buy or sell');
    const check = await tokenCheck(mint);
    if (side === 'buy' && check.verdict === 'DANGER') return { refused: true, verdict: check.verdict, reasons: check.reasons, note: 'MOSN refuses to route buys into DANGER tokens.' };
    const slippageBps = Math.max(50, Math.min(3000, Number(q.slippageBps) || 500));
    let amount;
    if (side === 'buy') amount = Math.round(Math.max(0.001, Math.min(50, Number(q.amountSol) || 0)) * 1e9);
    else amount = String(q.amountRaw || '').replace(/\D/g, '');
    if (!amount || amount === '0') throw new Error(side === 'buy' ? 'Pass amountSol' : 'Pass amountRaw (token base units)');
    const feeBps = q.src === 'bot' ? BOT_FEE_BPS : SWAP_FEE_BPS;
    const withFee = feeBps > 0 && await feeAccountOk();
    const quote = (await axios.get('https://api.jup.ag/swap/v1/quote', { params: { inputMint: side === 'buy' ? WSOL : mint, outputMint: side === 'buy' ? mint : WSOL, amount, slippageBps, ...(withFee ? { platformFeeBps: feeBps } : {}) }, headers: jupHeaders, timeout: 8000 })).data;
    const swap = (await axios.post('https://api.jup.ag/swap/v1/swap', { quoteResponse: quote, userPublicKey: wallet, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 100000, priorityLevel: 'high' } }, ...(withFee ? { feeAccount: feeAta.toBase58() } : {}) },
        { headers: { 'Content-Type': 'application/json', ...jupHeaders }, timeout: 12000 })).data;
    return { refused: false, verdict: check.verdict, reasons: check.reasons, side, inAmount: quote.inAmount, expectedOutAmount: quote.outAmount, priceImpactPct: Number(quote.priceImpactPct || 0) * 100,
        platformFeeBps: withFee ? feeBps : 0, swapTransaction: swap.swapTransaction, lastValidBlockHeight: swap.lastValidBlockHeight,
        howTo: 'Deserialize swapTransaction (base64 VersionedTransaction), sign with your wallet, send. Not financial advice.' };
}

async function holdersData(mint) {
    const h = await withAnyRpc(c => holderConcentration(c, mint));
    const why = holderVerdict(h);
    return { mint, topWalletPct: +h.top1.toFixed(2), top10WalletsPct: +h.top10.toFixed(2), realWalletsCounted: h.wallets, whaleRisk: !!why, reason: why, note: 'Pool/program accounts excluded. Not financial advice.' };
}
app.get('/dataset', async (req, res) => {
    try {
        const body = datasetData(req.query.hours);
        sale('labeled dataset', PRICE_DATASET, `${body.rows} rows`);
        res.json(body);
    } catch (e) { res.status(502).json({ error: String(e.message).slice(0, 100) }); }
});

app.get('/alpha', async (req, res) => {
    try {
        const body = await alphaData(req.query.minutes);
        sale('fresh Solana alpha', PRICE_ALPHA, `${body.count} tokens`);
        res.json(body);
    } catch (e) { res.status(502).json({ error: String(e.message).slice(0, 100) }); }
});

app.get('/holders', async (req, res) => {
    try {
        const body = await holdersData(String(req.query.mint));
        sale('holder check', PRICE_HOLDERS, body.mint.slice(0, 8) + '…');
        res.json(body);
    } catch (e) { res.status(502).json({ error: `Check failed: ${String(e.message).slice(0, 100)}` }); }
});

function phone(text) {
    const t = process.env.TELEGRAM_BOT_TOKEN, c = process.env.TELEGRAM_CHAT_ID;
    if (!t || !c) return;
    axios.post(`https://api.telegram.org/bot${t}/sendMessage`, { chat_id: c, text, disable_web_page_preview: true }, { timeout: 10000 }).catch(() => {});
}

app.listen(PORT, process.env.API_BIND || '0.0.0.0', () => { // host deploy binds all interfaces // v2.9 security: only this Mac (and the Cloudflare tunnel) can reach it — not others on your Wi-Fi
    console.log(`MOSN Solana Data API v2 on port ${PORT} | routes: /token-check ${PRICE}, /new-pools ${PRICE_POOLS}, /holders ${PRICE_HOLDERS}, /alpha ${PRICE_ALPHA}, /dataset ${PRICE_DATASET}, /safe-swap free (+${SWAP_FEE_BPS / 100}% fee) | pay to ${payTo}${BASE_PAY_TO ? ' (Solana) + ' + BASE_PAY_TO + ' (Base)' : ''} | public URL: ${PUBLIC_URL}`);
    phone(`💰 MOSN paid API v2 is live — 3 paid routes (token check, new pools, holders), USDC on Solana${BASE_PAY_TO ? ' or Base' : ''}\n${PUBLIC_URL}`);
});

// ── CDP x402 BAZAAR ROUTE (ADDITIVE v3.5) ─────────────────────────────────────────────────────────────
// A SECOND, parallel payment avenue powered by Coinbase's own createX402Server. It auto-attaches the Bazaar
// discovery + builder-code extensions on settlement (EVM/Base especially), so paid calls on THIS route get
// MOSN listed in the Coinbase x402 Bazaar. It does NOT touch the existing /token-check, free tier, prepaid
// keys, or the PayAI layer — it is a brand-new /x402/* path. Uses MOSN's existing vault addresses (no new
// wallet, no new secret). Mounted AFTER app.listen + guarded + timed out, so it can never delay/crash boot.
try {
    if (process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET && process.env.ENABLE_CDP_BAZAAR !== '0') {
        const { createX402Server } = await import('@coinbase/cdp-sdk/x402'); // dynamic: a missing module degrades gracefully, never crashes boot
        const cdpRoutes = {
            'GET /x402/token-check': {
                price: PRICE,
                description: 'Solana token rug/safety check: mint & freeze authority, dangerous Token-2022 settings, real-wallet holder concentration (pools excluded), sell-route round-trip test, live buy/sell flow. Verdict SAFE/CAUTION/DANGER with reasons.',
                networks: [...(BASE_PAY_TO ? [BASE_NETWORK] : []), NETWORK], // Base first (Bazaar auto-indexes EVM), Solana too
            },
        };
        const cdpBazaar = await Promise.race([
            createX402Server({ routes: cdpRoutes, payToConfig: { type: 'address', ...(BASE_PAY_TO ? { evm: BASE_PAY_TO } : {}), solana: payTo } }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('createX402Server timeout')), 20000)),
        ]);
        app.use(paymentMiddlewareFromHTTPServer(cdpBazaar));
        app.get('/x402/token-check', async (req, res) => {
            try { res.json(await tokenCheck(String(req.query.mint))); }
            catch (e) { res.status(400).json({ error: String(e.message).slice(0, 120) }); }
        });
        console.log(`[${new Date().toLocaleTimeString()}] [CDP_BAZAAR] \u2705 indexed route live: ${PUBLIC_URL}/x402/token-check (${BASE_PAY_TO ? 'Base + ' : ''}Solana)`);
    } else {
        console.log(`[${new Date().toLocaleTimeString()}] [CDP_BAZAAR] skipped (no CDP keys or disabled)`);
    }
} catch (e) { console.log(`[${new Date().toLocaleTimeString()}] [CDP_BAZAAR] \u26a0\ufe0f not enabled: ${String(e.message).slice(0, 160)}`); }

export { verdict, tokenCheck };
