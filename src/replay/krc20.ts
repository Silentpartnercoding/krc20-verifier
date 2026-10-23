/**
 * Independent KRC-20 state machine. A port of go-krc20d @a9754ffd (MIT, kasplex):
 *   operation/contract/KRC-20/{deploy,mint,transfer,list,send,burn,chown,issue,blacklist}.lua (init + run)
 *   explorer/script.go ParseOpDataList hook (lines 959-1030): isRecycle gate, payload gate, OpRules validation/merge
 *   operation/init.go 129-240: per-tx scripts run in order; tx accepted if any script accepted
 * Execution is sequential in (accepting DAA, intra-block tx order, script order). go-krc20d runs
 * conflicting keys serially in list order, so sequential replay is equivalent.
 * Only the arithmetic and acceptance semantics are replicated; storage/checkpoint hashing is not.
 */
import { inputAt, normTick } from "./extract.js";
import { blake2b256Hex, encodeAddress, hexToBytes, verifyAddr } from "../script/address.js";
import type { OpCandidate } from "./types.js";

export interface TokenState { tick: string; max: bigint; lim: bigint; pre: bigint; dec: number; mod: string; from: string; to: string; minted: bigint; burned: bigint; txid: string; opadd: string }
export interface BalanceState { balance: bigint; locked: bigint }
export interface MarketState { tamt: bigint; uaddr: string; uamt: string }
export interface OpResult { opScore: string; txId: string; op: string; accept: boolean; error: string; scripts: { index: number; op: string; accept: boolean; error: string; params: Record<string, string> }[] }

const AMT_MAX = 99999999999999999999999999999999n;
export const RANGE = { krcMinA: 83_441_551, krcMaxA: 83_525_600, krcMinB: 90_090_600, listSend: 97_539_090, burnChown: 110_165_000, memo: 408_300_500 };

const TICK_IGNORED = new Set(["KASPA","KASPLX","KASP","WKAS","GIGA","WBTC","WETH","USDT","USDC","FDUSD","USDD","TUSD","USDP","PYUSD","EURC","BUSD","GUSD","EURT","XAUT","TETHER"]);
const TICK_RESERVED: Record<string, string> = {
  NACHO: "kaspa:qzrsq2mfj9sf7uye3u5q7juejzlr0axk5jz9fpg4vqe76erdyvxxze84k9nk7",
  KCATS: "kaspa:qq8guq855gxkfrj2w25skwgj7cp4hy08x6a8mz70tdtmgv5p2ngwqxpj4cknc",
  KASTOR: "kaspa:qr8vt54764aaddejhjfwtsh07jcjr49v38vrw2vtmxxtle7j2uepynwy57ufg",
  KASPER: "kaspa:qppklkx2zyr2g2djg3uy2y2tsufwsqjk36pt27vt2xfu8uqm24pskk4p7tq5n",
  FUSUN: "kaspa:qzp30gu5uty8jahu9lq5vtplw2ca8m2k7p45ez3y8jf9yrm5qdxquq5nl45t5",
  KPAW: "kaspa:qpp0y685frmnlvhmnz5t6qljatumqm9zmppwnhwu9vyyl6w8nt30qjedekmdw",
  PPKAS: "kaspa:qrlx9377yje3gvj9qxvwnn697d209lshgcrvge3yzlxnvyrfyk3q583jh3cmz",
  GHOAD: "kaspa:qpkty3ymqs67t0z3g7l457l79f9k6drl55uf2qeq5tlkrpf3zwh85es0xtaj9",
  KEPE: "kaspa:qq45gur2grn80uuegg9qgewl0wg2ahz5n4qm9246laej9533f8e22x3xe6hkm",
  WORI: "kaspa:qzhgepc7mjscszkteeqhy99d3v96ftpg2wyy6r85nd0kg9m8rfmusqpp7mxkq",
  KEKE: "kaspa:qqq9m42mdcvlz8c7r9kmpqj59wkfx3nppqte8ay20m4p46x3z0lsyzz34h8uf",
  DOGK: "kaspa:qpsj64nxtlwceq4e7jvrsrkl0y6dayfyrqr49pep7pd2tq2uzvk7ks7n0qwxc",
  BTAI: "kaspa:qp0na29g4lysnaep5pmg9xkdzcn4xm4a35ha5naq79ns9mcgc3pccnf225qma",
  KASBOT: "kaspa:qrrcpdaev9augqwy8jnnp20skplyswa7ezz3m9ex3ryxw22frpzpj2xx99scq",
  SOMPS: "kaspa:qry7xqy6s7d449gqyl0dkr99x6df0q5jlj6u52p84tfv6rddxjrucnn066237",
  KREP: "kaspa:qzaclsmr5vttzlt0rz0x3shnudny8lnz5zpmjr4lp9v7aa7u7zvexh05eqwq0",
};

// ---- validators (explorer/script.go 1190-1330); each returns [pass, normalizedValue] ----
type V = (s: string) => [boolean, string];
const vAscii: V = (s) => (/^[\x00-\x7f]*$/.test(s) ? [true, s] : [false, ""]);
const vTick: V = (s) => { const u = s.toUpperCase(); return /^[A-Z]{4,6}$/.test(u) ? [true, u] : [false, ""]; };
const vTxId: V = (s) => { const l = s.toLowerCase(); return /^[0-9a-f]{64}$/.test(l) ? [true, l] : [false, ""]; };
const vTickTxId: V = (s) => (s.length !== 64 ? vTick(s) : vTxId(s));
const vAddr: V = (s) => { if (!vAscii(s)[0]) return [false, ""]; return verifyAddr(s) ? [true, s] : [false, ""]; };
export const vAmount: V = (s) => {
  if (s === "" || !/^[+-]?\d+$/.test(s)) return [false, "0"]; // big.Int SetString base 10 (also accepts a sign)
  const b = BigInt(s);
  if (b.toString(10) !== s || b <= 0n) return [false, "0"];
  if (b > AMT_MAX) return [false, AMT_MAX.toString()];
  return [true, s];
};
const vDec: V = (s) => { if (!/^[+-]?\d+$/.test(s)) return [false, "8"]; const n = Number.parseInt(s, 10); return String(n) === s && n >= 0 && n <= 18 ? [true, s] : [false, "8"]; };
const VALIDATORS: Record<string, V> = { tick: vTick, txid: vTxId, ticktxid: vTickTxId, addr: vAddr, amt: vAmount, dec: vDec, ascii: vAscii };

/** script.go 982-1025: merge init opParams with session params under opRules; null = op dropped entirely. */
function applyRules(init: Record<string, string | undefined>, session: Record<string, string>, rules: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(init)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(rules)) {
    const rule = v.replaceAll(" ", "").split(",");
    const required = !(rule.length > 1 && rule[1] === "o");
    let target: string | undefined = init[k] !== undefined ? init[k] : session[k];
    if (target === undefined && required) target = "_nil";
    let pass = true, ignored = false;
    if (target === "_nil") pass = false;
    else if (k === "tick" && !["tick", "txid", "ticktxid"].includes(rule[0])) pass = false;
    else if (VALIDATORS[rule[0]]) { [pass, target] = VALIDATORS[rule[0]](target ?? ""); }
    else ignored = true;
    // Go: target for a missing optional key is "" (zero value) -> validators run on "".
    if (!pass && required) return null;
    if (!ignored && target !== "" && target !== undefined) out[k] = target; else delete out[k];
  }
  out.p = session.p; out.op = session.op; out.from = session.from;
  return out;
}

/** krc20.lua makeScriptData + makeP2SH (note: the 0x4d length is written big-endian, mirrored as-is). */
export function makeP2SH(spkHex: string, data: string): string {
  const d = Buffer.from(data, "utf8");
  let push: Buffer;
  if (d.length <= 0 || d.length > 65535) push = Buffer.from([0]);
  else if (d.length <= 75) push = Buffer.concat([Buffer.from([d.length]), d]);
  else if (d.length <= 255) push = Buffer.concat([Buffer.from([0x4c, d.length]), d]);
  else push = Buffer.concat([Buffer.from([0x4d, (d.length >> 8) & 0xff, d.length & 0xff]), d]);
  const spk = /^[0-9a-fA-F]*$/.test(spkHex) && spkHex.length % 2 === 0 ? Buffer.from(spkHex, "hex") : Buffer.alloc(0);
  const s = Buffer.concat([spk, Buffer.from("006307" + "6b6173706c6578" + "00", "hex"), push, Buffer.from([0x68])]);
  return encodeAddress(8, hexToBytes(blake2b256Hex(s)));
}

const inRangeKrc = (ds: number) => !(ds < RANGE.krcMinA || (ds > RANGE.krcMaxA && ds < RANGE.krcMinB));

interface Prepared { op: string; params: Record<string, string>; feeLeast: bigint; isRecycle: boolean; index: number; cand: OpCandidate }

export class Krc20Replay {
  tokens = new Map<string, TokenState>();
  balances = new Map<string, BalanceState>(); // key `${tick}|${addr}`
  markets = new Map<string, MarketState>(); // key `${tick}|${addr}|${txid}`
  blacklist = new Set<string>();
  results: OpResult[] = [];
  /** Number of recorded results (also counted when results are streamed instead of kept). */
  resultCount = 0;
  /**
   * Only replay ops whose (normalized) tick/ca is in this set; null = all.
   * onResult: when set, each result is handed to the callback and NOT kept in `results`
   * (a full NACHO replay has ~10M results; keeping them all does not fit in memory).
   */
  constructor(public tickFilter: Set<string> | null = new Set(["NACHO"]), private onResult?: (r: OpResult) => void) {}

  private bal(tick: string, addr: string): BalanceState | undefined { return this.balances.get(`${tick}|${addr}`); }
  private setBal(tick: string, addr: string, b: BalanceState) { this.balances.set(`${tick}|${addr}`, b); }

  /** init() of each contract + hook. Returns null when the op is dropped (not recorded by go-krc20d). */
  prepare(c: OpCandidate): Prepared | { failInit: string; c: OpCandidate } | null {
    const sp = c.params, ds = c.daaScore;
    const tickOf = () => (sp.ca !== undefined ? sp.ca : sp.tick);
    let init: Record<string, string | undefined>, rules: Record<string, string>, feeLeast = 0n, isRecycle = false;
    const fail = (e: string) => ({ failInit: e, c });
    switch (sp.op) {
      case "deploy": {
        if (!inRangeKrc(ds)) return fail("out of range");
        init = { tick: sp.tick, lim: sp.lim, to: sp.to === undefined || sp.to === "" ? sp.from : sp.to };
        if (ds >= RANGE.burnChown && sp.mod === "issue") {
          init.tick = c.txId; init.lim = "0";
          rules = { tick: "txid,r", name: "tick,r", mod: "ascii,r", lim: "amt,o", max: sp.max === "0" ? "amt,o" : "amt,r" };
        } else rules = { tick: "tick,r", max: "amt,r", lim: "amt,r" };
        Object.assign(rules, { dec: "dec,o", pre: "amt,o", to: "addr,o" });
        feeLeast = 100_000_000_000n;
        break;
      }
      case "mint": {
        if (!inRangeKrc(ds)) return fail("out of range");
        init = { to: sp.to === undefined || sp.to === "" ? sp.from : sp.to };
        rules = { tick: "tick,r", to: "addr,o" };
        feeLeast = 100_000_000n;
        break;
      }
      case "transfer": {
        if (!inRangeKrc(ds)) return fail("out of range");
        if (sp.to === "") return fail("address invalid");
        init = { tick: tickOf() };
        rules = { tick: "ticktxid,r", amt: "amt,r", to: "addr,o" };
        if (ds > RANGE.memo) { rules.memo = "ascii,o"; init.memo = (sp.memo ?? "").slice(0, 256); }
        break;
      }
      case "list": {
        if (ds < RANGE.listSend) return fail("out of range");
        const o0 = c.outputs[0];
        init = { tick: tickOf(), utxo: o0 ? `${c.txId}_${o0.address}_${o0.amount}` : "" };
        rules = { tick: "ticktxid,r", amt: "amt,r", utxo: "ascii,r" };
        break;
      }
      case "send": {
        if (ds < RANGE.listSend) return fail("out of range");
        const inp = inputAt(c.inputs, c.inputIndex);
        if (!inp) return fail("utxo invalid");
        let price = c.outputs.length > 0 ? String(c.outputs[0].amount) : "";
        let to = "";
        if (c.outputs.length > 1 && c.inputIndex === 0) to = c.outputs[1].address; else { price = "0"; to = sp.from; }
        init = { tick: tickOf(), to, utxo: `${inp.prevTxId}_${sp.from}`, price };
        rules = { tick: "ticktxid,r", to: "addr,r", utxo: "ascii,r", price: "amt,o" };
        isRecycle = true;
        break;
      }
      case "burn": {
        if (ds < RANGE.burnChown) return fail("out of range");
        init = { tick: tickOf() }; rules = { tick: "ticktxid,r", amt: "amt,r" };
        break;
      }
      case "chown": {
        if (ds < RANGE.burnChown) return fail("out of range");
        if (sp.to === "") return fail("address invalid");
        init = { tick: tickOf() }; rules = { tick: "ticktxid,r", to: "addr,o" };
        break;
      }
      case "issue": case "blacklist": {
        // Both require token mode "issue" (issue.lua / blacklist.lua). Mint-mode tokens (NACHO) always fail;
        // ported as a run-time failure. Full issue-mode semantics are out of scope for the NACHO audit.
        if (ds < RANGE.burnChown) return fail("out of range");
        init = { tick: tickOf() }; rules = { tick: "ticktxid,r" };
        break;
      }
      default:
        return null; // no such contract -> call error -> dropped
    }
    if (c.inputIndex !== 0 && !isRecycle) return null;
    if (c.isPayload && isRecycle) return null;
    const params = applyRules(init, sp, rules);
    if (!params) return null;
    return { op: sp.op, params, feeLeast, isRecycle, index: c.inputIndex, cand: c };
  }

  /** Execute all candidates of one transaction (same opScore). */
  applyTx(opScore: string, cands: OpCandidate[]) {
    const env = cands.filter((c) => !c.isPayload), pay = cands.filter((c) => c.isPayload);
    let prepared = env.map((c) => this.prepare(c)).filter((x): x is NonNullable<typeof x> => x !== null);
    const envRecycle = prepared.some((p) => "op" in p && p.isRecycle);
    if (pay.length && !envRecycle) {
      const pp = pay.map((c) => this.prepare(c)).filter((x): x is NonNullable<typeof x> => x !== null);
      if (pp.length) prepared = pp; // script.go 1074-1094: payload op replaces envelope ops
    }
    if (!prepared.length) return;
    const want = (p: (typeof prepared)[number]) => {
      if (!this.tickFilter) return true;
      const t = "op" in p ? p.params.tick : normTick(p.c.params.ca ?? p.c.params.tick);
      return t !== undefined && this.tickFilter.has(t);
    };
    if (!prepared.some(want)) return;
    const res: OpResult = { opScore, txId: cands[0].txId, op: "", accept: false, error: "", scripts: [] };
    for (const p of prepared) {
      if ("failInit" in p) { res.scripts.push({ index: p.c.inputIndex, op: p.c.params.op, accept: false, error: p.failInit, params: p.c.params }); continue; }
      const err = this.run(p, opScore);
      res.scripts.push({ index: p.index, op: p.op, accept: err === "", error: err, params: p.params });
    }
    const firstAcc = res.scripts.findIndex((s) => s.accept);
    res.accept = firstAcc >= 0;
    res.error = res.accept ? "" : (res.scripts.find((s) => s.error)?.error ?? "");
    res.op = res.scripts[Math.max(firstAcc, 0)].op;
    this.resultCount++;
    if (this.onResult) this.onResult(res); else this.results.push(res);
  }

  /** run() of each contract. Returns "" on success or the error string. */
  private run(p: Prepared, opScore: string): string {
    const sp = p.params, c = p.cand;
    const tok = this.tokens.get(sp.tick);
    const feeCheck = (): string => {
      if (c.fee === null || c.fee === 0n) return "fee unknown";
      return c.fee < p.feeLeast ? "fee not enough" : "";
    };
    switch (p.op) {
      case "deploy": {
        if (tok) return "tick existed";
        if (TICK_IGNORED.has(sp.tick)) return "tick ignored";
        if (TICK_RESERVED[sp.tick] !== undefined && TICK_RESERVED[sp.tick] !== sp.from) return "tick reserved";
        const f = feeCheck(); if (f) return f;
        const pre = sp.pre !== undefined && sp.pre !== "0";
        if (pre && sp.to === undefined) return "address invalid";
        const max = BigInt(sp.max ?? "0");
        const t: TokenState = { tick: sp.tick, max, lim: BigInt(sp.lim ?? "0"), pre: BigInt(sp.pre ?? "0"), dec: Number(sp.dec ?? "8"), mod: sp.mod ?? "", from: sp.from, to: sp.to ?? "", minted: 0n, burned: 0n, txid: c.txId, opadd: opScore };
        if (pre) {
          let minted = BigInt(sp.pre);
          if (sp.max !== "0" && minted > max) minted = max;
          t.minted = minted;
          this.setBal(sp.tick, sp.to, { balance: minted, locked: 0n });
        }
        this.tokens.set(sp.tick, t);
        return "";
      }
      case "mint": {
        if (!tok) return "tick not found";
        if (tok.mod !== "" && tok.mod !== "mint") return "mode invalid";
        const f = feeCheck(); if (f) return f;
        if (sp.to === undefined) return "address invalid";
        const left = tok.max - tok.minted;
        if (left <= 0n) return "mint finished";
        const amt = tok.lim > left ? left : tok.lim;
        tok.minted += amt;
        const b = this.bal(sp.tick, sp.to) ?? { balance: 0n, locked: 0n };
        b.balance += amt;
        this.setBal(sp.tick, sp.to, b);
        sp.amt = amt.toString();
        return "";
      }
      case "transfer": {
        if (!tok) return "tick not found";
        if (this.blacklist.has(`${sp.tick}|${sp.from}`)) return "blacklist";
        if (sp.to === undefined || sp.from === sp.to) return "address invalid";
        const bf = this.bal(sp.tick, sp.from);
        if (!bf) return "balance insuff";
        const amt = BigInt(sp.amt);
        if (amt > bf.balance) return "balance insuff";
        const bt = this.bal(sp.tick, sp.to) ?? { balance: 0n, locked: 0n };
        bf.balance -= amt; bt.balance += amt;
        this.setBal(sp.tick, sp.to, bt);
        return "";
      }
      case "list": {
        if (!tok) return "tick not found";
        if (this.blacklist.has(`${sp.tick}|${sp.from}`)) return "blacklist";
        const bf = this.bal(sp.tick, sp.from);
        if (!bf) return "balance insuff";
        const amt = BigInt(sp.amt);
        if (amt > bf.balance) return "balance insuff";
        const m = /^([^_]+)_([^_]+)_([^_]+)/.exec(sp.utxo ?? "");
        const [uTxId, uAddr, uAmt] = m ? [m[1], m[2], m[3]] : ["", "", ""];
        const tl = sp.tick.toLowerCase();
        const a1 = makeP2SH(c.spkFrom, `{"p":"krc-20","op":"send","tick":"${tl}"}`);
        const a2 = makeP2SH(c.spkFrom, `{"p":"krc-20","op":"send","ca":"${tl}"}`);
        if (uAddr !== a1 && uAddr !== a2) return "address invalid";
        bf.balance -= amt; bf.locked += amt;
        this.markets.set(`${sp.tick}|${sp.from}|${uTxId}`, { tamt: amt, uaddr: uAddr, uamt: uAmt });
        return "";
      }
      case "send": {
        if (!tok) return "tick not found";
        const m = /^([^_]+)_([^_]+)/.exec(sp.utxo ?? "");
        const uTxId = m ? m[1] : "";
        const mk = `${sp.tick}|${sp.from}|${uTxId}`;
        const mkt = this.markets.get(mk);
        const bf = this.bal(sp.tick, sp.from);
        if (!mkt) return "order not found";
        if (!bf) return "order abnormal";
        if (mkt.tamt > bf.locked) return "order abnormal";
        bf.locked -= mkt.tamt;
        let bt = this.bal(sp.tick, sp.to);
        if (!bt) { bt = { balance: 0n, locked: 0n }; this.setBal(sp.tick, sp.to, bt); }
        bt.balance += mkt.tamt; // same object as bf when to == from (cancel)
        this.markets.delete(mk);
        sp.amt = mkt.tamt.toString();
        return "";
      }
      case "burn": {
        if (!tok) return "tick not found";
        if (sp.from !== tok.to) return "no ownership";
        const bf = this.bal(sp.tick, sp.from);
        if (!bf) return "balance insuff";
        const amt = BigInt(sp.amt);
        if (amt > bf.balance) return "balance insuff";
        bf.balance -= amt; tok.burned += amt;
        return "";
      }
      case "chown": {
        if (!tok) return "tick not found";
        if (sp.from !== tok.to) return "no ownership";
        if (sp.to === undefined) return "address invalid";
        tok.to = sp.to;
        return "";
      }
      case "issue": case "blacklist": {
        if (!tok) return "tick not found";
        if (tok.mod !== "issue") return "mode invalid";
        return "not implemented (issue mode)";
      }
    }
    return "unknown op";
  }

  holders(tick = "NACHO") {
    const out: { address: string; balance: bigint; locked: bigint }[] = [];
    for (const [k, v] of this.balances) {
      const [t, a] = k.split("|");
      if (t === tick && (v.balance !== 0n || v.locked !== 0n)) out.push({ address: a, ...v });
    }
    return out.sort((x, y) => (y.balance + y.locked > x.balance + x.locked ? 1 : -1));
  }
}
