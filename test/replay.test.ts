import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Krc20Replay, makeP2SH, vAmount } from "../src/replay/krc20.js";
import { extractOps } from "../src/replay/extract.js";
import { apiTxToRaw } from "../src/sources/apiTx.js";
import type { OpCandidate } from "../src/replay/types.js";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const DEPLOYER = "kaspa:qzrsq2mfj9sf7uye3u5q7juejzlr0axk5jz9fpg4vqe76erdyvxxze84k9nk7";
const A = "kaspa:qzenv0qucakl4sh504xkeya9vyj2gyghjl84tj08q0779h3hg0cfj2nzfcrvg";

function cand(daa: number, params: Record<string, string>, extra: Partial<OpCandidate> = {}): OpCandidate {
  return { txId: "aa".repeat(32), daaScore: daa, blueScore: 0, blockTime: 0, inputIndex: 0, isPayload: false, from: params.from, spkFrom: "", params: { p: "KRC-20", ...params }, fee: 200_000_000n, outputs: [], inputs: [], ...extra };
}

describe("KRC-20 replay engine (port of go-krc20d Lua contracts)", () => {
  it("replays the real NACHO deploy from L1 data: accepted, reserved deployer, fee >= 1000 KAS", () => {
    const raw = apiTxToRaw(fx("nacho-deploy"), { blueScore: 81_837_258, daaScore: 83_443_002, blockHash: "", daaExact: true });
    const ops = extractOps(raw);
    expect(ops).toHaveLength(1);
    expect(ops[0].fee! >= 100_000_000_000n).toBe(true);
    const r = new Krc20Replay();
    r.applyTx("834430020006", ops);
    expect(r.results[0]).toMatchObject({ accept: true, op: "deploy" });
    const t = r.tokens.get("NACHO")!;
    expect(t.max).toBe(28_700_000_000_000_000_000n);
    expect(t.lim).toBe(2_870_000_000_000n);
    expect(t.from).toBe(DEPLOYER);
  });

  it("rejects a NACHO deploy from anyone but the reserved address", () => {
    const r = new Krc20Replay();
    r.applyTx("1", [cand(83_443_002, { op: "deploy", tick: "NACHO", max: "100", lim: "1", from: A }, { fee: 200_000_000_000n })]);
    expect(r.results[0]).toMatchObject({ accept: false, error: "tick reserved" });
  });

  it("mint: caps at remaining supply, enforces fee and mint-finished", () => {
    const r = new Krc20Replay();
    r.applyTx("1", [cand(83_443_002, { op: "deploy", tick: "NACHO", max: "25", lim: "10", from: DEPLOYER }, { fee: 100_000_000_000n })]);
    r.applyTx("2", [cand(83_443_003, { op: "mint", tick: "nacho", from: A }, { fee: 99_999_999n })]);
    expect(r.results[1].error).toBe("fee not enough");
    for (let i = 0; i < 3; i++) r.applyTx(String(3 + i), [cand(83_443_004, { op: "mint", tick: "NACHO", from: A })]);
    expect(r.results.slice(2).map((x) => x.scripts[0].params.amt)).toEqual(["10", "10", "5"]);
    r.applyTx("9", [cand(83_443_005, { op: "mint", tick: "NACHO", from: A })]);
    expect(r.results.at(-1)!.error).toBe("mint finished");
    expect(r.holders()[0]).toMatchObject({ address: A, balance: 25n });
  });

  it("enforces the DAA activation windows (gap 83,525,601..90,090,599; list/send from 97,539,090)", () => {
    const r = new Krc20Replay();
    r.applyTx("1", [cand(83_600_000, { op: "mint", tick: "NACHO", from: A })]);
    expect(r.results[0].error).toBe("out of range");
    r.applyTx("2", [cand(95_000_000, { op: "list", tick: "NACHO", amt: "1", from: A })]);
    expect(r.results[1].error).toBe("out of range");
  });

  it("transfer: insufficient balance fails, self-transfer fails, non-canonical amt drops the op", () => {
    const r = new Krc20Replay();
    r.applyTx("1", [cand(83_443_002, { op: "deploy", tick: "NACHO", max: "100", lim: "10", from: DEPLOYER }, { fee: 100_000_000_000n })]);
    r.applyTx("2", [cand(90_100_000, { op: "mint", tick: "NACHO", from: DEPLOYER })]);
    r.applyTx("3", [cand(90_100_001, { op: "transfer", tick: "NACHO", amt: "11", to: A, from: DEPLOYER })]);
    expect(r.results.at(-1)!.error).toBe("balance insuff");
    r.applyTx("4", [cand(90_100_002, { op: "transfer", tick: "NACHO", amt: "1", to: DEPLOYER, from: DEPLOYER })]);
    expect(r.results.at(-1)!.error).toBe("address invalid");
    const n = r.results.length;
    r.applyTx("5", [cand(90_100_003, { op: "transfer", tick: "NACHO", amt: "01", to: A, from: DEPLOYER })]);
    expect(r.results.length).toBe(n); // validateAmount fails a required rule -> not recorded at all
    r.applyTx("6", [cand(90_100_004, { op: "transfer", tick: "NACHO", amt: "4", to: A, from: DEPLOYER })]);
    expect(r.holders().map((h) => [h.address, h.balance])).toEqual([[DEPLOYER, 6n], [A, 4n]]);
  });

  it("only input 0 may carry a non-recycle op", () => {
    const r = new Krc20Replay();
    r.applyTx("1", [cand(83_443_002, { op: "deploy", tick: "NACHO", max: "100", lim: "10", from: DEPLOYER }, { fee: 100_000_000_000n, inputIndex: 1 })]);
    expect(r.results).toHaveLength(0);
  });

  it("validateAmount mirrors big.Int canonical-decimal semantics", () => {
    expect(vAmount("1")[0]).toBe(true);
    expect(vAmount("0")[0]).toBe(false);
    expect(vAmount("-1")[0]).toBe(false);
    expect(vAmount("1e3")[0]).toBe(false);
    expect(vAmount("100000000000000000000000000000000")).toEqual([false, "99999999999999999999999999999999"]);
  });

  it("list's P2SH binding: the real NACHO list 0d9316b9 locks into the address makeP2SH derives", () => {
    const tx = fx("nacho-list-0d9316b9");
    const raw = apiTxToRaw(tx, { blueScore: tx.accepting_block_blue_score, daaScore: 200_000_000, blockHash: "", daaExact: false });
    const [op] = extractOps(raw);
    expect(op.params.op).toBe("list");
    expect(raw.outputs[0].address).toBe(makeP2SH(op.spkFrom, '{"p":"krc-20","op":"send","tick":"nacho"}'));
  });

  it("the real send acd42092 is extracted from input 1 as a recycle op", () => {
    const tx = fx("nacho-send-acd42092");
    const raw = apiTxToRaw(tx, { blueScore: tx.accepting_block_blue_score, daaScore: 200_000_000, blockHash: "", daaExact: false });
    const ops = extractOps(raw);
    expect(ops.map((o) => [o.inputIndex, o.params.op])).toEqual([[1, "send"]]);
    const r = new Krc20Replay();
    const p = r.prepare(ops[0]);
    expect(p && "op" in p && p.isRecycle).toBe(true);
  });
});
