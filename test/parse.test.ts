import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScriptInput, parseScriptInputLegacy, parseForDaa, HF_DAA_SCRIPT_PARSER_FIX } from "../src/script/parse.js";
import { decodeAddress, encodeAddress, verifyAddr, spkToAddr } from "../src/script/address.js";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
const NACHO_DEPLOYER = "kaspa:qzrsq2mfj9sf7uye3u5q7juejzlr0axk5jz9fpg4vqe76erdyvxxze84k9nk7"; // go-krc20d deploy.lua tickReserved.NACHO

describe("address (go-krc20d misc/address.go)", () => {
  it("round-trips the reserved NACHO deployer address", () => {
    const d = decodeAddress(NACHO_DEPLOYER)!;
    expect(d.version).toBe(0);
    expect(encodeAddress(d.version, d.payload)).toBe(NACHO_DEPLOYER);
    expect(verifyAddr(NACHO_DEPLOYER)).toBe(true);
    expect(verifyAddr(NACHO_DEPLOYER.slice(0, -1) + "q")).toBe(false);
  });
  it("derives output addresses from spk the same way api.kaspa.org reports them", () => {
    const tx = fx("nacho-transfer-1410b950");
    for (const o of tx.outputs) expect(spkToAddr(o.script_public_key)).toBe(o.script_public_key_address);
  });
});

describe("canonical envelope parser (go-krc20d explorer/script.go @a9754ffd)", () => {
  it("parses the NACHO deploy (legacy era, accepting DAA 83,443,002) with the reserved deployer as from", () => {
    const tx = fx("nacho-deploy");
    const env = parseForDaa(tx.inputs[0].signature_script, 83_443_002, null)!;
    expect(env).not.toBeNull();
    expect(env.from).toBe(NACHO_DEPLOYER);
    expect(JSON.parse(env.json)).toMatchObject({ p: "KRC-20", op: "deploy", tick: "NACHO", max: "28700000000000000000", lim: "2870000000000" });
  });

  it("parses a real NACHO transfer under the legacy rules (b23fc278, blue score 88,495,017)", () => {
    const tx = fx("nacho-transfer-b23fc278");
    const env = parseScriptInputLegacy(tx.inputs[0].signature_script)!;
    expect(JSON.parse(env.json)).toMatchObject({ op: "transfer" });
    expect(JSON.parse(env.json).tick.toUpperCase()).toBe("NACHO");
  });

  it("parses a real NACHO transfer under the current rules (1410b950, blue score 198,295,402)", () => {
    const tx = fx("nacho-transfer-1410b950");
    const env = parseScriptInput(tx.inputs[0].signature_script)!;
    expect(env).not.toBeNull();
    const j = JSON.parse(env.json);
    expect(j.op).toBe("transfer");
    expect(j.tick.toUpperCase()).toBe("NACHO");
    expect(env.from.startsWith("kaspa:")).toBe(true);
  });

  it("parses the send op from a non-zero input index (acd42092, isRecycle path)", () => {
    const tx = fx("nacho-send-acd42092");
    const envs = tx.inputs.map((i: any) => parseScriptInput(i.signature_script));
    expect(envs[0]).toBeNull(); // plain P2PK spend
    expect(JSON.parse(envs[1].json)).toMatchObject({ op: "send" });
  });

  it("REJECTS the forged Sept-20 transfer d599f956 (empty signature push + trailing OP_NOT) under current rules", () => {
    const sig = fx("forged-transfer-d599f956").inputs[0].signature_script as string;
    expect(sig.startsWith("004c")).toBe(true); // OP_0 (empty signature) then the redeem push
    expect(sig.endsWith("6891")).toBe(true); // OP_ENDIF, OP_NOT
    expect(parseScriptInput(sig)).toBeNull();
    expect(parseForDaa(sig, HF_DAA_SCRIPT_PARSER_FIX + 1, null)).toBeNull();
  });

  it("documents why the fix was needed: the legacy rules accept the forged envelope", () => {
    const sig = fx("forged-transfer-d599f956").inputs[0].signature_script as string;
    const env = parseScriptInputLegacy(sig);
    expect(env).not.toBeNull();
    expect(JSON.parse(env!.json).op).toBe("transfer");
  });
});
