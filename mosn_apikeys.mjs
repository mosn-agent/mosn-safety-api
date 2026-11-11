// mosn_apikeys.mjs — PREPAID API KEYS paid in SOL (no x402 wallet needed). People buy a pack in @MOSNSafeSwapBot with /api,
// get a private key, and use it with the normal API: header  x-mosn-key: <key>   (or ?key=<key>).
// Two processes share this safely: the BOT only appends to api_key_grants.jsonl; the API owns api_keys.json.
// Keys are stored only as SHA-256 hashes — a leaked file can't be used as keys.
import fs from 'fs';
import crypto from 'crypto';

export const PACKS = [
    { id: 'starter', sol: 0.05, credits: 2_000, label: '2,000 checks' },
    { id: 'pro', sol: 0.4, credits: 20_000, label: '20,000 checks' }
];
export const COST = { '/token-check': 1, '/holders': 1, '/new-pools': 2, '/alpha': 10, '/dataset': 50 };
const GRANTS = './api_key_grants.jsonl', STORE = './api_keys.json';
export const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');
export const newKey = () => 'mosn_' + crypto.randomBytes(18).toString('hex');
export function packFor(lamports) { return [...PACKS].sort((a, b) => b.sol - a.sol).find(p => lamports >= Math.round(p.sol * 1e9 * 0.99)) || null; }

// ---- BOT side (append-only) ----
export function grantCredits(uid, credits, { rotate = false } = {}) {
    const cur = currentHash(uid);
    let key = null, hash = cur;
    if (!hash || rotate) { key = newKey(); hash = hashKey(key); }
    fs.appendFileSync(GRANTS, JSON.stringify({ id: crypto.randomUUID(), uid, hash, oldHash: rotate ? cur : null, credits, at: Date.now() }) + '\n');
    return { key, carried: !!cur && !rotate };   // key is null when the user's existing key just got topped up
}
/** The user's current key hash = the newest grant for them (grants file is the source of truth for ownership). */
function currentHash(uid) {
    let h = null;
    try { for (const l of fs.readFileSync(GRANTS, 'utf8').split('\n')) { if (!l) continue; const g = JSON.parse(l); if (g.uid === uid) h = g.hash; } } catch (_) { }
    return h;
}
export function readStore() { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return { keys: {}, applied: [] }; } }
export function creditsOf(uid) {
    const s = readStore(), h = currentHash(uid); if (!h) return null;
    let c = s.keys[h]?.credits ?? 0;
    try { const applied = new Set(s.applied || []); for (const l of fs.readFileSync(GRANTS, 'utf8').split('\n')) { if (!l) continue; const g = JSON.parse(l); if (g.uid === uid && !applied.has(g.id)) c += g.credits + (g.oldHash && s.keys[g.oldHash] ? s.keys[g.oldHash].credits : 0); } } catch (_) { }
    return c;
}

// ---- API side (owner of api_keys.json) ----
let store = null, dirty = false;
function ingest() {
    store ||= readStore(); store.applied ||= [];
    const applied = new Set(store.applied);
    try {
        for (const l of fs.readFileSync(GRANTS, 'utf8').split('\n')) {
            if (!l) continue; let g; try { g = JSON.parse(l); } catch { continue; }
            if (applied.has(g.id)) continue;
            let carry = 0;
            if (g.oldHash && g.oldHash !== g.hash && store.keys[g.oldHash]) { carry = store.keys[g.oldHash].credits; delete store.keys[g.oldHash]; }
            const k = store.keys[g.hash] ||= { uid: g.uid, credits: 0, created: g.at, used: 0 };
            k.credits += g.credits + carry; applied.add(g.id); store.applied.push(g.id); dirty = true;
        }
    } catch (_) { }
    store.applied = store.applied.slice(-5000);
}
export function startKeyStore() {
    ingest();
    setInterval(() => { ingest(); if (dirty) { fs.writeFileSync(STORE, JSON.stringify(store), { mode: 0o600 }); dirty = false; } }, 5000);
}
/** Returns { ok, left } or { ok:false, why }. */
export function spend(key, cost) {
    ingest();
    const k = store.keys[hashKey(key)];
    if (!k) return { ok: false, why: 'unknown key' };
    if (k.credits < cost) return { ok: false, why: `out of credits (${k.credits} left, this call needs ${cost})` };
    k.credits -= cost; k.used = (k.used || 0) + cost; dirty = true;
    return { ok: true, left: k.credits };
}
