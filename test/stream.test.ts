import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStreamTxs, copyField } from "../src/sources/streamLoad.js";
import { acceptanceFromStream } from "../src/replay/acceptance.js";
import { extractOps } from "../src/replay/extract.js";
import { Krc20Replay } from "../src/replay/krc20.js";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const bx = (h: string) => `\\\\x${h}`; // COPY text form of a bytea: \\x<hex>
const N = "\\N";

describe("pgstream COPY loader -> replay", () => {
  it("unescapes COPY text fields", () => {
    expect(copyField("\\N")).toBeNull();
    expect(copyField("\\\\x00ff")).toBe("\\x00ff");
    expect(copyField("a\\tb")).toBe("a\tb");
  });

  it("rebuilds the NACHO deploy from dump-format rows and replays it with dump acceptance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pgs-"));
    const t = fx("nacho-deploy");
    const blk = fx("nacho-deploy-accepting-block");
    const ins = t.inputs.map((i: any) => [bx(t.transaction_id), i.index, bx(i.previous_outpoint_hash), i.previous_outpoint_index, bx(i.signature_script), 1, t.block_time, N, i.previous_outpoint_amount].join("\t"));
    const outs = t.outputs.map((o: any) => [bx(t.transaction_id), o.index, o.amount, bx(o.script_public_key), o.script_public_key_address, t.block_time].join("\t"));
    writeFileSync(join(dir, "inputs_nacho.tsv.gz"), gzipSync(ins.join("\n") + "\n"));
    writeFileSync(join(dir, "outputs_nacho.tsv.gz"), gzipSync(outs.join("\n") + "\n"));
    writeFileSync(join(dir, "acceptances.tsv.gz"), gzipSync([bx(t.transaction_id), bx(t.accepting_block_hash)].join("\t") + "\n"));
    const h = blk.header;
    const blockRow = [bx(t.accepting_block_hash), N, N, N, N, h.bits, h.blueScore, N, h.daaScore, N, N, N, h.timestamp, N, h.version];
    writeFileSync(join(dir, "blocks.tsv.gz"), gzipSync(blockRow.join("\t") + "\n"));

    const shells = await loadStreamTxs(dir);
    const acc = await acceptanceFromStream(dir);
    expect(acc.get(t.transaction_id)).toMatchObject({ blueScore: 81_837_258, daaScore: 83_443_002, daaExact: true });
    const s = shells.get(t.transaction_id)!;
    const ops = extractOps({ ...s, accept: acc.get(t.transaction_id)! });
    const r = new Krc20Replay();
    r.applyTx("834430020000", ops);
    expect(r.results[0]).toMatchObject({ accept: true, op: "deploy" });
  });
});
