import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// test/fixtures/order_gap_units_74.tsv: the NACHO units where the /virtual-chain order and Kasplex's order differ.
const yn = (b: boolean) => (b ? "yes" : "no");

describe("order-gap data file", () => {
  const lines = readFileSync(new URL("./fixtures/order_gap_units_74.tsv", import.meta.url), "utf8").trimEnd().split("\n");
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.split("\t").map((v, i) => [header[i], v])));

  it("has 74 units sorted by DAA", () => {
    expect(header).toEqual(["daa_score", "chain_block_hash", "n_txs", "txids_virtual_chain_order", "txids_kasplex_order",
      "kasplex_op_scores", "virtual_chain_is_txid_ascending", "kasplex_is_reverse"]);
    expect(rows).toHaveLength(74);
    const daas = rows.map((r) => Number(r.daa_score));
    expect(daas).toEqual([...daas].sort((a, b) => a - b));
  });

  it("each row is internally consistent", () => {
    for (const r of rows) {
      const vc = r.txids_virtual_chain_order.split(","), kx = r.txids_kasplex_order.split(","), sc = r.kasplex_op_scores.split(",");
      expect(vc.length).toBe(Number(r.n_txs));
      expect([...kx].sort()).toEqual([...vc].sort());
      expect(kx).not.toEqual(vc);
      for (const s of sc) expect(BigInt(s) / 10000n).toBe(BigInt(r.daa_score));
      expect(r.virtual_chain_is_txid_ascending).toBe(yn(vc.every((t, i) => i === 0 || vc[i - 1] < t)));
      expect(r.kasplex_is_reverse).toBe(yn(kx.join() === [...vc].reverse().join()));
    }
    expect(rows.filter((r) => r.virtual_chain_is_txid_ascending === "yes")).toHaveLength(73);
    expect(rows.filter((r) => r.kasplex_is_reverse === "yes")).toHaveLength(72);
  });
});
