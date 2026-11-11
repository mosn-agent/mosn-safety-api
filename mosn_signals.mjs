// mosn_signals.mjs — v15 trading brains, kept separate so each rule can be tested on its own.
import { PublicKey } from '@solana/web3.js';

export const SIGNAL_CONFIG = {
    // Entry: who holds the supply (real wallets only — pool/bonding-curve accounts are excluded)
    MAX_TOP1_WALLET_PCT: 10,     // one wallet holding more than this can dump on us
    MAX_TOP10_WALLETS_PCT: 35,   // ten wallets holding more than this = insider-controlled
    MIN_BUY_SELL_RATIO: 1.1,     // last 5 min: buys must outnumber sells

    // Exits (checked every 3 seconds)
    HARD_STOP_PCT: -6,           // absolute floor
    FAST_DROP_PCT: 4,            // price fell this many points within ~10 seconds → get out
    FAST_DROP_WINDOW_MS: 10_000,
    FLOW_FLIP_RATIO: 1.3,        // sellers outnumber buyers by 30%+ → momentum is gone
    FLOW_MAX_AGE_MS: 20_000,
    STALL_MINUTES: 6,            // never got going → free the slot
    STALL_MAX_PEAK_PCT: 3,
    MAX_HOLD_MINUTES: 30
};

/** DexScreener returns several pools per token — keep only the deepest one so each token is judged once. */
export function pickBestPairs(pairs) {
    const best = new Map();
    for (const p of pairs || []) {
        const m = p?.baseToken?.address;
        if (!m) continue;
        const liq = parseFloat(p.liquidity?.usd || '0');
        const cur = best.get(m);
        if (!cur || liq > parseFloat(cur.liquidity?.usd || '0')) best.set(m, p);
    }
    return [...best.values()];
}

/**
 * Share of supply held by the biggest REAL wallets.
 * Accounts owned by programs (liquidity pools, bonding curves, lockers) are off-curve and excluded.
 */
export async function holderConcentration(connection, mint) {
    const mintKey = new PublicKey(mint);
    const [largest, supply] = await Promise.all([
        connection.getTokenLargestAccounts(mintKey, 'confirmed'),
        connection.getTokenSupply(mintKey, 'confirmed')
    ]);
    const total = Number(supply.value.amount);
    if (!total) return { top1: 100, top10: 100, wallets: 0 };
    const accts = (largest.value || []).slice(0, 20);
    const infos = await connection.getMultipleParsedAccounts(accts.map(a => a.address), { commitment: 'confirmed' });
    const shares = [];
    (infos.value || []).forEach((inf, i) => {
        const owner = inf?.data?.parsed?.info?.owner;
        // v16.8 safety: if the RPC couldn't tell us who owns this account, count it as a real wallet.
        // (Before, unknown owners were skipped — a 93% whale could look "fair".)
        if (!owner) { shares.push(Number(accts[i].amount) / total * 100); return; }
        if (!PublicKey.isOnCurve(new PublicKey(owner).toBytes())) return; // program-owned (pool) — skip
        shares.push(Number(accts[i].amount) / total * 100);
    });
    shares.sort((a, b) => b - a);
    return {
        top1: shares[0] || 0,
        top10: shares.slice(0, 10).reduce((a, b) => a + b, 0),
        wallets: shares.length
    };
}

export function holderVerdict(h, cfg = SIGNAL_CONFIG) {
    if (h.top1 > cfg.MAX_TOP1_WALLET_PCT) return `One wallet holds ${h.top1.toFixed(1)}%`;
    if (h.top10 > cfg.MAX_TOP10_WALLETS_PCT) return `Top 10 wallets hold ${h.top10.toFixed(1)}%`;
    return null;
}

/**
 * Decide whether to sell NOW. pos.hist = [{t, p}] recent PnL% samples (every ~3s),
 * pos.flow = {buys5, sells5, m5, at} latest DexScreener snapshot. Returns a reason string or null.
 */
export function smartExitReason(pos, pnlPct, now = Date.now(), cfg = SIGNAL_CONFIG) {
    const holdMin = (now - pos.entryTime) / 60000;
    const peak = pos.peakPnl ?? 0;

    if (pnlPct <= cfg.HARD_STOP_PCT) return `SL ${pnlPct.toFixed(1)}%`;

    // 1. Sharp drop in the last ~10 seconds
    const hist = pos.hist || [];
    const ref = hist.find(h => now - h.t <= cfg.FAST_DROP_WINDOW_MS);
    if (ref && ref.p - pnlPct >= cfg.FAST_DROP_PCT) {
        return `FAST_DROP ${pnlPct.toFixed(1)}% (was ${ref.p.toFixed(1)}% ${Math.round((now - ref.t) / 1000)}s ago)`;
    }

    // 2. Sellers taking over
    const f = pos.flow;
    if (f && now - f.at <= cfg.FLOW_MAX_AGE_MS && f.buys5 > 0) {
        const sellingHard = f.sells5 > f.buys5 * cfg.FLOW_FLIP_RATIO;
        if (sellingHard && pnlPct > 1) return `SELLERS_TAKING_OVER (locking +${pnlPct.toFixed(1)}%)`;
        if (sellingHard && pnlPct < -2) return `SELLERS_TAKING_OVER ${pnlPct.toFixed(1)}%`;
    }

    // 3. Never took off
    if (holdMin >= cfg.STALL_MINUTES && peak < cfg.STALL_MAX_PEAK_PCT) return `STALLED ${pnlPct.toFixed(1)}% after ${Math.round(holdMin)}m`;

    // 4. Don't marry a meme coin
    if (holdMin >= cfg.MAX_HOLD_MINUTES) return `MAX_HOLD ${pnlPct.toFixed(1)}%`;

    return null;
}

/** Turn MOSN's own recorded trades into plain evidence the AI must take into account. */
export function tradeEvidence(trades, minN = 3) {
    const t = (trades || []).filter(x => typeof x.pnlPct === 'number' && x.entryM5Change != null).slice(-60);
    if (t.length < minN) return '';
    const line = (label, arr) => {
        if (arr.length < minN) return null;
        const w = arr.filter(x => x.outcome === 'WIN').length;
        const avg = arr.reduce((a, x) => a + x.pnlPct, 0) / arr.length;
        return `- ${label}: ${arr.length} trades, ${Math.round(100 * w / arr.length)}% won, avg ${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`;
    };
    const ratio = x => (x.entryBuys || 0) / Math.max(1, x.entrySells || 0);
    const rows = [
        line('Entered after 5m gain under 10%', t.filter(x => x.entryM5Change < 10)),
        line('Entered after 5m gain 10-25%', t.filter(x => x.entryM5Change >= 10 && x.entryM5Change <= 25)),
        line('Entered after 5m gain over 25%', t.filter(x => x.entryM5Change > 25)),
        line('Buys/sells ratio under 1.3', t.filter(x => x.entryBuys != null && ratio(x) < 1.3)),
        line('Buys/sells ratio 1.3+', t.filter(x => x.entryBuys != null && ratio(x) >= 1.3)),
        line('Top-10 wallets under 20%', t.filter(x => x.entryTop10Pct != null && x.entryTop10Pct < 20)),
        line('Top-10 wallets 20%+', t.filter(x => x.entryTop10Pct != null && x.entryTop10Pct >= 20))
    ].filter(Boolean);
    // v16.3: the current rules (holder check era) get their own section, so old September habits don't drown them out
    const recent = t.filter(x => x.entryTop10Pct != null);
    const recentRows = recent.length >= minN ? [
        line('CURRENT RULES — all trades', recent),
        line('CURRENT RULES — 5m gain under 10%', recent.filter(x => x.entryM5Change < 10)),
        line('CURRENT RULES — 5m gain 10-25%', recent.filter(x => x.entryM5Change >= 10 && x.entryM5Change <= 25)),
        line('CURRENT RULES — 5m gain over 25%', recent.filter(x => x.entryM5Change > 25))
    ].filter(Boolean) : [];
    const all = [...recentRows, ...rows];
    return all.length ? `Evidence from MOSN's own last ${t.length} trades (CURRENT RULES rows matter most; the rest include older, looser rules):\n${all.join('\n')}` : '';
}
