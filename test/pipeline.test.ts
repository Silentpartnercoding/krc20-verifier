import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prep } from "../src/pipeline/prep.js";
import { runReplay, RESULT_COLS } from "../src/pipeline/run.js";
import { compare } from "../src/pipeline/compare.js";
import { claimLedger } from "../src/pipeline/claimLedger.js";
import { CLAIM_COLS } from "../src/pipeline/claimTsv.js";
import { fromCompact, toCompact } from "../src/pipeline/compact.js";
import { extractOps } from "../src/replay/extract.js";
import type { RawTx } from "../src/replay/types.js";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const bx = (h: string) => `\\\\x${h}`;
const N = "\\N";
const tmp = () => mkdtempSync(join(tmpdir(), "pipe-"));
const gzLines = (p: string) => gunzipSync(readFileSync(p)).toString("utf8").split("\n").filter(Boolean);
const claimLine = (o: Record<string, string>) => CLAIM_COLS.map((k) => o[k] ?? "").join("\t");

function deployRows() {
  const t = fx("nacho-deploy");
  const ins = t.inputs.map((i: any) => [bx(t.transaction_id), i.index, bx(i.previous_outpoint_hash), i.previous_outpoint_index, bx(i.signature_script), 1, t.block_time, bx("20" + "00".repeat(32) + "ac"), i.previous_outpoint_amount].join("\t"));
  const outs = t.outputs.map((o: any) => [bx(t.transaction_id), o.index, o.amount, bx(o.script_public_key), o.script_public_key_address, t.block_time].join("\t"));
  return { t, ins, outs };
}

describe("streaming pipeline (prep -> run -> compare)", () => {
  it("replays the NACHO deploy from dump-format rows with exact L1 acceptance and compares it to a claim", async () => {
    const dir = tmp();
    const { t, ins, outs } = deployRows();
    writeFileSync(join(dir, "in.gz"), gzipSync(ins.join("\n") + "\n"));
    writeFileSync(join(dir, "out.gz"), gzipSync(outs.join("\n") + "\n"));
    writeFileSync(join(dir, "acc.gz"), gzipSync(`${t.transaction_id}\t${t.accepting_block_hash}\t81837258\t83443002\n`));
    const ps = await prep(join(dir, "in.gz"), join(dir, "out.gz"), join(dir, "acc.gz"), join(dir, "prep"));
    expect(ps).toMatchObject({ txs: 1, accepted: 1, unaccepted: 0, withOps: 1, maxDaa: 83443002, minDaa: 83443002, maxBlue: 81837258 });
    expect(ps.opsByOp).toEqual({ deploy: 1 });
    const cand = gzLines(join(dir, "prep", "candidates.unsorted.tsv.gz"));
    expect(cand).toHaveLength(1);
    expect(cand[0].startsWith("000081837258\t" + t.transaction_id + "\t")).toBe(true);
    writeFileSync(join(dir, "cand.gz"), gzipSync(cand.join("\n") + "\n"));
    const rs = await runReplay(join(dir, "cand.gz"), join(dir, "run"));
    expect(rs.byOpAccept).toEqual({ "deploy|accept": 1 });
    expect(rs.token).toMatchObject({ max: "28700000000000000000", lim: "2870000000000", minted: "0" });
    const res = gzLines(join(dir, "run", "results.tsv.gz"));
    expect(res).toHaveLength(1);
    const r = Object.fromEntries(RESULT_COLS.map((k, i) => [k, res[0].split("\t")[i]]));
    expect(r).toMatchObject({ txId: t.transaction_id, opScore: "834430020000", daa: "83443002", blue: "81837258", op: "deploy", accept: "1", tiedBlock: "0" });

    // claim: deploy (matched, same DAA) + one op only in the claim after the dump window + one inside it
    const claim = [
      claimLine({ hashRev: "00".repeat(32), opScore: "900000000001", op: "mint", opAccept: "1", amt: "5" }),
      claimLine({ hashRev: t.transaction_id, opScore: "834430020006", op: "deploy", opAccept: "1" }),
      claimLine({ hashRev: "ff".repeat(32), opScore: "9000000000000", op: "transfer", opAccept: "1", amt: "1" }),
    ].sort();
    writeFileSync(join(dir, "claim.gz"), gzipSync(claim.join("\n") + "\n"));
    const cs = await compare(join(dir, "run", "results.tsv.gz"), join(dir, "claim.gz"), 100_000_000, join(dir, "cmp"));
    expect(cs).toMatchObject({ matched: 1, bothAccept: 1, onlyInClaim: 2, onlyInReplay: 0, daaMismatch: 0, amountMismatch: 0, replayRejectClaimAccept: 0 });
    expect(cs.onlyInClaimByWindowOp).toEqual({ "insideDump|mint|opAccept=1": 1, "afterDump|transfer|opAccept=1": 1 });
  });

  it("counts unaccepted txs and refuses unsorted inputs", async () => {
    const dir = tmp();
    const { ins, outs } = deployRows();
    writeFileSync(join(dir, "in.gz"), gzipSync(ins.join("\n") + "\n"));
    writeFileSync(join(dir, "out.gz"), gzipSync(outs.join("\n") + "\n"));
    writeFileSync(join(dir, "acc.gz"), gzipSync(""));
    const ps = await prep(join(dir, "in.gz"), join(dir, "out.gz"), join(dir, "acc.gz"), join(dir, "p"));
    expect(ps).toMatchObject({ txs: 1, accepted: 0, unaccepted: 1, withOps: 0 });
    const b = ["\\\\x" + "bb".repeat(32), 0, "\\\\x00", 0, "\\\\x00", 1, 0, N, 1].join("\t");
    const a = ["\\\\x" + "aa".repeat(32), 0, "\\\\x00", 0, "\\\\x00", 1, 0, N, 1].join("\t");
    writeFileSync(join(dir, "bad.gz"), gzipSync(b + "\n" + a + "\n"));
    await expect(prep(join(dir, "bad.gz"), join(dir, "out.gz"), join(dir, "acc.gz"), join(dir, "q"))).rejects.toThrow(/not (strictly grouped\/)?sorted/);
    writeFileSync(join(dir, "badout.gz"), gzipSync([b.replace("bb".repeat(32), "11".repeat(32)), b.replace("bb".repeat(32), "00".repeat(32)), ...outs].join("\n") + "\n"));
    await expect(prep(join(dir, "in.gz"), join(dir, "badout.gz"), join(dir, "acc.gz"), join(dir, "r"))).rejects.toThrow(/not sorted/);
  });

  it("compact round-trip keeps what the engine reads", () => {
    const { t } = deployRows();
    const tx: RawTx = {
      txId: t.transaction_id, blockTime: t.block_time, payload: null,
      accept: { blockHash: t.accepting_block_hash, blueScore: 81837258, daaScore: 83443002, daaExact: true },
      inputs: t.inputs.map((i: any) => ({ index: i.index, prevTxId: i.previous_outpoint_hash, prevIndex: i.previous_outpoint_index, sig: i.signature_script, prevSpk: null, prevAmount: BigInt(i.previous_outpoint_amount) })),
      outputs: t.outputs.map((o: any) => ({ index: o.index, amount: BigInt(o.amount), spk: o.script_public_key, address: o.script_public_key_address })),
    };
    const ops = extractOps(tx);
    const back = fromCompact(JSON.parse(JSON.stringify(toCompact(tx, ops))));
    expect(back).toHaveLength(ops.length);
    for (let i = 0; i < ops.length; i++) {
      expect(back[i]).toMatchObject({ txId: ops[i].txId, daaScore: 83443002, blueScore: 81837258, inputIndex: ops[i].inputIndex, from: ops[i].from, spkFrom: ops[i].spkFrom, params: ops[i].params, fee: ops[i].fee, isPayload: ops[i].isPayload });
      expect(back[i].outputs.map((o) => [o.amount, o.address])).toEqual(ops[i].outputs.slice(0, 2).map((o) => [o.amount, o.address]));
      expect(back[i].inputs[ops[i].inputIndex].prevTxId).toBe(ops[i].inputs[ops[i].inputIndex].prevTxId);
    }
  });

  it("compare flags reject-vs-accept, amount and from/to mismatches", async () => {
    const dir = tmp();
    const id = (c: string) => c.repeat(64);
    const res = (o: Record<string, string>) => RESULT_COLS.map((k) => o[k] ?? "").join("\t");
    const R = [
      res({ txId: id("1"), opScore: "10000", daa: "1", op: "mint", accept: "0", error: "fee not enough", tiedBlock: "1" }),
      res({ txId: id("2"), opScore: "20000", daa: "2", op: "transfer", accept: "1", amt: "7", from: "a", to: "b" }),
      res({ txId: id("3"), opScore: "30000", daa: "3", op: "transfer", accept: "1", amt: "9", from: "a", to: "c" }),
      res({ txId: id("4"), opScore: "40000", daa: "4", op: "mint", accept: "1" }),
    ];
    const C = [
      claimLine({ hashRev: id("1"), opScore: "10003", op: "mint", opAccept: "1", feeRev: "100000000" }),
      claimLine({ hashRev: id("2"), opScore: "20000", op: "transfer", opAccept: "1", amt: "8", from: "a", to: "b" }),
      claimLine({ hashRev: id("3"), opScore: "50000", op: "transfer", opAccept: "1", amt: "9", from: "a", to: "d" }),
    ];
    writeFileSync(join(dir, "r.gz"), gzipSync(R.join("\n") + "\n"));
    writeFileSync(join(dir, "c.gz"), gzipSync(C.join("\n") + "\n"));
    const s = await compare(join(dir, "r.gz"), join(dir, "c.gz"), 10, join(dir, "o"));
    expect(s).toMatchObject({ matched: 3, replayRejectClaimAccept: 1, tiedBlockAmongRejects: 1, bothAccept: 2, amountMismatch: 1, fromToMismatch: 1, daaMismatch: 1, onlyInReplay: 1, onlyInClaim: 0 });
    expect(s.rejectVsClaimAcceptByOpError).toEqual({ "mint|fee not enough": 1 });
  });
});

describe("claimLedger", () => {
  it("applies accepted claim ops and keeps list amounts locked until send", async () => {
    const dir = tmp();
    const C = [
      claimLine({ hashRev: "d", opScore: "1", op: "deploy", opAccept: "1" }),
      claimLine({ hashRev: "m1", opScore: "2", op: "mint", opAccept: "1", amt: "100", to: "A" }),
      claimLine({ hashRev: "t1", opScore: "3", op: "transfer", opAccept: "1", amt: "30", from: "A", to: "B" }),
      claimLine({ hashRev: "l1", opScore: "4", op: "list", opAccept: "1", amt: "20", from: "A" }),
      claimLine({ hashRev: "l2", opScore: "5", op: "list", opAccept: "1", amt: "10", from: "B" }),
      claimLine({ hashRev: "s1", opScore: "6", op: "send", opAccept: "1", amt: "20", from: "A", to: "C" }),
      claimLine({ hashRev: "x", opScore: "7", op: "transfer", opAccept: "0", amt: "999", from: "A", to: "B" }),
    ];
    writeFileSync(join(dir, "c.gz"), gzipSync(C.join("\n") + "\n"));
    const s = await claimLedger(join(dir, "c.gz"), join(dir, "o"));
    expect(s).toMatchObject({ ops: 7, applied: 6, minted: "100", negativeEvents: 0, holders: 3, lockedHolders: 1, sumBalance: "90", sumLocked: "10", sumBalancePlusLocked: "100" });
    const h = readFileSync(join(dir, "o", "claim_ledger_holders.tsv"), "utf8").trim().split("\n").sort();
    expect(h).toEqual(["A\t50\t0", "B\t20\t10", "C\t20\t0"]);
    writeFileSync(join(dir, "bad.gz"), gzipSync([C[2], C[1]].join("\n") + "\n"));
    await expect(claimLedger(join(dir, "bad.gz"), join(dir, "o2"))).rejects.toThrow(/not sorted/);
  });
});

describe("apiTxToRaw input formats", () => {
  it("reads the spent output from resolve_previous_outpoints=full (previous_outpoint_resolved) and =light", async () => {
    const { apiTxToRaw } = await import("../src/sources/apiTx.js");
    const acc = { blockHash: "00", blueScore: 1, daaScore: 1 } as any;
    const base = { transaction_id: "ab", block_time: 1, payload: null, outputs: [] };
    const full = apiTxToRaw({ ...base, inputs: [{ index: 0, previous_outpoint_hash: "cd", previous_outpoint_index: "0", signature_script: "00",
      previous_outpoint_resolved: { amount: 100003874, script_public_key: "aa20" + "11".repeat(32) + "87" } }] }, acc);
    expect(full.inputs[0].prevAmount).toBe(100003874n);
    expect(full.inputs[0].prevSpk).toBe("aa20" + "11".repeat(32) + "87");
    const light = apiTxToRaw({ ...base, inputs: [{ index: 0, previous_outpoint_hash: "cd", previous_outpoint_index: "0", signature_script: "00", previous_outpoint_amount: "5" }] }, acc);
    expect(light.inputs[0].prevAmount).toBe(5n);
    expect(light.inputs[0].prevSpk).toBeNull();
  });
});

describe("prep: dump gaps", () => {
  it("derives NULL output addresses from the script and takes the fee from --fee-inputs when given", async () => {
    const dir = tmp();
    const { t, ins, outs } = deployRows();
    // NULL script_public_key_address (as in the real dump for many rows)
    const outsNull = outs.map((l: string) => { const f = l.split("\t"); f[4] = N; return f.join("\t"); });
    writeFileSync(join(dir, "in.gz"), gzipSync(ins.join("\n") + "\n"));
    writeFileSync(join(dir, "out.gz"), gzipSync(outsNull.join("\n") + "\n"));
    writeFileSync(join(dir, "acc.gz"), gzipSync(`${t.transaction_id}\t${t.accepting_block_hash}\t81837258\t83443002\n`));
    const outSum = t.outputs.reduce((a: bigint, o: any) => a + BigInt(o.amount), 0n);
    writeFileSync(join(dir, "fee.tsv"), `${t.transaction_id}\t9\t${outSum + 123n}\t${outSum}\t1\n`);
    const ps = await prep(join(dir, "in.gz"), join(dir, "out.gz"), join(dir, "acc.gz"), join(dir, "prep"), join(dir, "fee.tsv"));
    expect(ps).toMatchObject({ outputAddrDerived: t.outputs.length, outputAddrUnresolved: 0, feeFromApi: 1, txsWithInputsMissingInDump: 1 });
    const c = JSON.parse(gzLines(join(dir, "prep", "candidates.unsorted.tsv.gz"))[0].split("\t").slice(2).join("\t"));
    expect(c.o[0][1]).toBe(t.outputs[0].script_public_key_address);
    expect(c.fee).toBe("123");
  });
  it("keeps the real input index when the dump omits earlier inputs (envelope at input 1 is not input 0)", async () => {
    const dir = tmp();
    const { t, ins, outs } = deployRows();
    const shifted = ins.map((l: string) => { const f = l.split("\t"); f[1] = String(Number(f[1]) + 1); return f.join("\t"); });
    writeFileSync(join(dir, "in.gz"), gzipSync(shifted.join("\n") + "\n"));
    writeFileSync(join(dir, "out.gz"), gzipSync(outs.join("\n") + "\n"));
    writeFileSync(join(dir, "acc.gz"), gzipSync(`${t.transaction_id}\t${t.accepting_block_hash}\t81837258\t83443002\n`));
    await prep(join(dir, "in.gz"), join(dir, "out.gz"), join(dir, "acc.gz"), join(dir, "prep"));
    const c = JSON.parse(gzLines(join(dir, "prep", "candidates.unsorted.tsv.gz"))[0].split("\t").slice(2).join("\t"));
    expect(c.c[0].i).toBe(1);
    expect(c.c[0].spk).toBe("");
    expect(c.c[0].prev).toBe(t.inputs[0].previous_outpoint_hash);
  });
});
