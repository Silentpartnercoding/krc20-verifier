import { describe, it, expect } from "vitest";
import { orderUnit, NODE_ORDER_DAA } from "../src/pipeline/run.js";

const mk = (...ids: string[]) => ids.map((id) => ({ id }));
const acc = new Map([["H", new Map([["cc", 0], ["aa", 1], ["bb", 2]])]]);

describe("in-unit order", () => {
  it("uses txid sort before the node-order DAA", () => {
    const u = mk("cc", "aa", "bb");
    expect(orderUnit(u, NODE_ORDER_DAA - 1, "H", "node", acc)).toBe("txid");
    expect(u.map((x) => x.id)).toEqual(["aa", "bb", "cc"]);
  });
  it("uses node acceptance order at and after it", () => {
    const u = mk("aa", "bb", "cc");
    expect(orderUnit(u, NODE_ORDER_DAA, "H", "node", acc)).toBe("node");
    expect(u.map((x) => x.id)).toEqual(["cc", "aa", "bb"]);
  });
  it("puts txs without a position last, by txid, and falls back when the unit is unknown", () => {
    const u = mk("zz", "bb", "ab", "cc");
    orderUnit(u, NODE_ORDER_DAA, "H", "node", acc);
    expect(u.map((x) => x.id)).toEqual(["cc", "bb", "ab", "zz"]);
    const v = mk("bb", "aa");
    expect(orderUnit(v, NODE_ORDER_DAA, "X", "node", acc)).toBe("fallback");
    expect(v.map((x) => x.id)).toEqual(["aa", "bb"]);
  });
  it("txid mode ignores the file", () => {
    const u = mk("cc", "aa");
    expect(orderUnit(u, NODE_ORDER_DAA + 5, "H", "txid", acc)).toBe("txid");
    expect(u.map((x) => x.id)).toEqual(["aa", "cc"]);
  });
});
