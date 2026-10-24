import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { StateHasher, eventString, unitString, balanceStateHash, marketStateHash, sha256Hex, unitRow, UNIT_COLS, type Krc20Event, type UnitHash } from "../src/hash/stateHash.js";
import { compareHashes } from "../src/pipeline/hashCompare.js";
import { eventFromClaimRow } from "../src/pipeline/claimHashes.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/state-hashes/events.json", import.meta.url), "utf8")) as
  { units: { daa: number; chainBlock: string; events: Krc20Event[] }[] };

// Expected values computed independently with Python hashlib (see docs/state-hashes.md, "Test vectors").
const EXPECT = [
  ["100", "163220006113b623e9d9a488a467dba32d5fa125fb512824d0f54bb0893dbbe6", "471bf40e2c69a43ee32c4c7396211e5b2e86579b675b1cf44b085c90bbe9aa0d"],
  ["105", "0de5b0cd87aeb3a9636ed6a3ef40e2ce0eb0b0516ef64ff9aa498229a66ce4ae", "1369a495cb727aa1718fc44d4144d55e35d06a3fa61f7e38466feaad9a4f1f61"],
  ["107", "710c9d09823070c6b5959b243f8ecc39bf1654f013108fd488c8d11e3120d2f4", "aeaf301dc62a6fc612238bdc9a26fecc20d2a19e5fbb6aa1e93e59667b7816c0"],
];

function hashAll(drop?: string): UnitHash[] {
  const out: UnitHash[] = [];
  const h = new StateHasher((u) => out.push(u));
  for (const u of fx.units) for (const e of u.events) if (e.txId !== drop) h.add(u.daa, u.chainBlock, e);
  h.flush();
  return out;
}

describe("krc20-sh-v1 event strings", () => {
  it("canonicalises each op type", () => {
    const [u1, u2, u3] = fx.units;
    expect(eventString(u1.events[0])).toBe("deploy;t1;kaspa:qa;ABC;1000;100;0;8;kaspa:qa;");
    expect(eventString(u1.events[1])).toBe("mint;t2;kaspa:qa;ABC;100");
    expect(eventString(u2.events[1])).toBe("transfer;t4;kaspa:qa;kaspa:qb;ABC;40");
    expect(eventString(u3.events[0])).toBe("list;t5;kaspa:qb;ABC;50;t5_kaspa:pq_100000");
    expect(eventString(u3.events[1])).toBe("send;t6;kaspa:qb;kaspa:qa;ABC;50");
    expect(eventString({ op: "burn", txId: "t7", tick: "abc", from: "kaspa:qa", amt: "1" })).toBe("burn;t7;kaspa:qa;ABC;1");
    expect(eventString({ op: "chown", txId: "t8", tick: "abc", from: "kaspa:qa", to: "kaspa:qb" })).toBe("chown;t8;kaspa:qa;kaspa:qb;ABC");
    expect(unitString(100, ["a", "b"])).toBe("krc20-sh-v1;100|a|b");
  });
  it("rejects separators inside fields and unknown ops", () => {
    expect(() => eventString({ op: "mint", txId: "t|x", tick: "ABC", to: "a", amt: "1" })).toThrow(/separator/);
    expect(() => eventString({ op: "issue", txId: "t", tick: "ABC" })).toThrow(/no canonical/);
  });
});

describe("krc20-sh-v1 chaining", () => {
  it("matches independently computed vectors", () => {
    expect(hashAll().map((u) => [u.daa, u.unitHash, u.cumulative])).toEqual(EXPECT);
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("counterfactual (one event removed) diverges exactly at that event's unit", () => {
    const a = hashAll(), b = hashAll("t4");
    expect(b[0].cumulative).toBe(a[0].cumulative);
    expect(b[1].unitHash).toBe("ce18d457170fbdf088b676e70075926fcc1964c7f777c96c3ba61925de7b0dc2");
    expect(b[1].cumulative).not.toBe(a[1].cumulative);
    expect(b[2].unitHash).toBe(a[2].unitHash); // later unit content same, chain stays diverged
    expect(b[2].cumulative).not.toBe(a[2].cumulative);
  });
  it("moving an event to another unit changes the hash (DAA header)", () => {
    const out: UnitHash[] = [];
    const h = new StateHasher((u) => out.push(u));
    h.add(101, "", fx.units[0].events[0]); h.add(101, "", fx.units[0].events[1]); h.flush();
    expect(out[0].unitHash).not.toBe(EXPECT[0][1]);
  });
  it("enforces strictly increasing units and one chain block per DAA", () => {
    const h = new StateHasher(() => {});
    h.add(5, "x", fx.units[0].events[1]);
    expect(() => h.add(5, "y", fx.units[0].events[1])).toThrow(/two chain blocks/);
    h.flush();
    expect(() => h.add(4, "", fx.units[0].events[1])).toThrow(/out of order/);
  });
});

describe("state hashes", () => {
  it("balance hash is order-independent and skips zero holders", () => {
    const hs = [{ address: "kaspa:qb", balance: 90n, locked: 0n }, { address: "kaspa:qa", balance: 110n, locked: 0n }, { address: "kaspa:qz", balance: 0n, locked: 0n }];
    const r = balanceStateHash("abc", hs);
    expect(r).toEqual({ hash: "79bf5a0086a3d0ee56fdf7dc64d02ad82f8def3caad6a3fea30933c760ccf0a7", n: 2 });
    expect(balanceStateHash("ABC", [...hs].reverse()).hash).toBe(r.hash);
    expect(marketStateHash("ABC", []).n).toBe(0);
  });
});

describe("claim rows and compare", () => {
  it("maps a Kasplex claim row to the unit DAA and event", () => {
    const r = eventFromClaimRow(["834430180000", "t2", "mint", "ABC", "100", "kaspa:qa", "kaspa:qa", "", "cp", "1", ""]);
    expect(r.daa).toBe("83443018");
    expect(r.accepted).toBe(true);
    expect(eventString(r.e)).toBe("mint;t2;kaspa:qa;ABC;100");
  });
  it("reports the first diverging unit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-"));
    const write = (n: string, us: UnitHash[]) => { const p = join(dir, n); writeFileSync(p, gzipSync([UNIT_COLS.join("\t"), ...us.map(unitRow)].join("\n") + "\n")); return p; };
    const r = await compareHashes(write("a.tsv.gz", hashAll()), write("b.tsv.gz", hashAll("t4")), 2);
    expect(r.identical).toBe(false);
    expect((r.firstDivergence as { daa: string }).daa).toBe("105");
    expect(r.bothSameUnitHash).toBe(2);
    const same = await compareHashes(write("c.tsv.gz", hashAll()), write("d.tsv.gz", hashAll()));
    expect(same.identical).toBe(true);
  });
});
