/**
 * Canonical KRC-20 envelope parser: a port of kasplex/go-krc20d explorer/script.go
 * at a9754ffd (2026-10-12), which contains the "script paser fix" commit ba3ab6f3 (2026-10-03).
 *
 *  - parseScriptInput            <- script.go:378-493 (current rules, DAA >= HfDaaScoreScriptParserFix)
 *  - parseScriptInputScriptSig   <- script.go:255-375
 *  - parseScriptInputLegacy      <- script.go:605-704 (pre-fork rules, DAA < 97,539,090)
 *  - parseScriptInputScriptSigLegacy <- script.go:525-602
 *  - lGetScript / nGetScript / dGetLastScriptRange / dGotoLastScriptLegacy / isFlatOptionalIf <- script.go:143-253, 495-523
 *  - isBoundP2SHRedeem           <- script.go:121-141 (applies at DAA >= HfDaaScore2026Q1 = 408,300,500)
 * Fork constants: config/load.go:20-21.
 *
 * All positions are hex-character offsets into the lower-cased hex script, exactly as in the Go code.
 */
import { blake2b256Hex, kPubToAddr, scriptHashToP2sh, hexToBytes } from "./address.js";

export const HF_DAA_SCRIPT_PARSER_FIX = 97_539_090; // config/load.go:21
export const HF_DAA_2026Q1 = 408_300_500; // config/load.go:20

type R3 = [number, number, boolean];

/** script.go:143-174: data-push length (in hex chars) at i. */
export function lGetScript(s: string, i: number): R3 {
  const iRaw = i;
  if (s.length < i + 2) return [0, iRaw, false];
  const f = s.slice(i, i + 2);
  i += 2;
  let lenD = 0;
  if (f === "4c") {
    if (s.length < i + 2) return [0, iRaw, false];
    lenD = parseInt(s.slice(i, i + 2), 16);
    i += 2;
  } else if (f === "4d") {
    if (s.length < i + 4) return [0, iRaw, false];
    lenD = parseInt(s.slice(i + 2, i + 4) + s.slice(i, i + 2), 16);
    i += 4;
  } else {
    lenD = parseInt(f, 16);
    if (!(lenD >= 0 && lenD <= 75)) return [0, iRaw, false];
  }
  if (Number.isNaN(lenD)) lenD = 0; // strconv.ParseInt error -> 0 in Go
  return [lenD * 2, i, true];
}

/** script.go:177-191: small-int opcode OP_1..OP_16 at i. */
export function nGetScript(s: string, i: number): R3 {
  const iRaw = i;
  if (s.length < i + 2) return [0, iRaw, false];
  let num = parseInt(s.slice(i, i + 2), 16);
  if (Number.isNaN(num)) num = 0;
  i += 2;
  if (num < 81 || num > 96) return [0, iRaw, false];
  return [num - 80, i, true];
}

/** script.go:229-253: locate the last push (the redeem script). Returns [opPos, dataPos, lenD, ok]. */
export function dGetLastScriptRange(s: string, i: number): [number, number, number, boolean] {
  const iRaw = i;
  for (let j = 0; j < 16; j++) {
    const iOp = i;
    const [lenD, i2, r] = lGetScript(s, i);
    i = i2;
    if (!r) return [iRaw, iRaw, 0, false];
    if (s.length < i + lenD) return [iRaw, iRaw, 0, false];
    if (s.length === i + lenD) {
      if (lenD < 94) return [iRaw, iRaw, 0, false];
      return [iOp, i, lenD, true];
    }
    i += lenD;
  }
  return [iRaw, iRaw, 0, false];
}

/** script.go:204-227 (pre-fork locator). */
export function dGotoLastScriptLegacy(s: string, i: number): [number, boolean] {
  const iRaw = i;
  for (let j = 0; j < 16; j++) {
    const [lenD, i2, r] = lGetScript(s, i);
    i = i2;
    if (!r) return [iRaw, false];
    if (s.length < i + lenD) return [iRaw, false];
    if (s.length === i + lenD) {
      if (lenD < 94) return [iRaw, false];
      return [i, true];
    }
    i += lenD;
  }
  return [iRaw, false];
}

/** script.go:495-523 */
export function isFlatOptionalIf(script: string, i: number): boolean {
  if (i < 0 || script.length - i < 6 || script.slice(i, i + 4) !== "0063") return false;
  i += 4;
  while (i < script.length) {
    if (i + 2 > script.length) return false;
    const op = script.slice(i, i + 2);
    if (op === "63" || op === "64" || op === "67") return false;
    if (op === "68") return i + 2 === script.length;
    const [lenD, next, ok] = lGetScript(script, i);
    if (ok) {
      if (next + lenD > script.length) return false;
      i = next + lenD;
      continue;
    }
    i += 2;
  }
  return false;
}

/** misc/address.go:14-44 */
function kPubListToScriptHashMultisig(m: number, kPubList: string[], n: number): [string, string] {
  if (kPubList.length < 1 || kPubList.length !== n) return ["", ""];
  let ecdsa = false;
  let k = (m + 80).toString(16);
  for (const kp of kPubList) {
    if (kp.length === 64) k += "20";
    else if (kp.length === 66) { k += "21"; ecdsa = true; }
    else return ["", ""];
    k += kp;
  }
  k += (n + 80).toString(16);
  k += ecdsa ? "a9" : "ae";
  return [blake2b256Hex(hexToBytes(k)), k];
}

type SigResult = { kPub: string; scriptSig: string; multisig: boolean; n: number; ok: boolean };
const fail = (multisig: boolean, n: number): SigResult => ({ kPub: "", scriptSig: "", multisig, n, ok: false });

/** script.go:255-375 (current). */
export function parseScriptInputScriptSig(script: string): SigResult {
  script = script.toLowerCase();
  const lenScript = script.length;
  if (lenScript === 0) return fail(false, 0);
  let [nUnlockEnd, n, , r] = dGetLastScriptRange(script, 0);
  if (!r || nUnlockEnd < 0) return fail(false, n);
  const unlockSigList: number[] = [];
  let nUnlock = 0;
  while (nUnlock < nUnlockEnd) {
    let lenDUnlock: number;
    [lenDUnlock, nUnlock, r] = lGetScript(script, nUnlock);
    if (!r || nUnlock + lenDUnlock > nUnlockEnd) return fail(false, n);
    unlockSigList.push(lenDUnlock);
    nUnlock += lenDUnlock;
  }
  if (nUnlock !== nUnlockEnd) return fail(false, n);
  let multisig = false;
  let kPub = "", scriptSig = "";
  let mm: number;
  [mm, n, r] = nGetScript(script, n);
  if (r) {
    if (mm > 0 && mm < 16) multisig = true;
    else return fail(multisig, n);
  }
  if (!multisig) {
    let lenD: number;
    [lenD, n, r] = lGetScript(script, n);
    if (!r) return fail(multisig, n);
    let fSig = "";
    if (lenScript > n + lenD + 2) fSig = script.slice(n + lenD, n + lenD + 2);
    if (lenD === 64 && fSig === "ac") { kPub = script.slice(n, n + 64); n += 66; scriptSig = "20" + kPub + fSig; }
    else if (lenD === 66 && fSig === "ab") { kPub = script.slice(n, n + 66); n += 68; scriptSig = "21" + kPub + fSig; }
    else return fail(multisig, n);
    if (unlockSigList.length !== 1 || unlockSigList[0] === 0) return fail(multisig, n);
  } else {
    const kPubList: string[] = [];
    let kPubLen = 0;
    let nn = 0;
    for (let j = 0; j < 16; j++) {
      let lenD: number;
      [lenD, n, r] = lGetScript(script, n);
      if (!r) {
        [nn, n, r] = nGetScript(script, n);
        if (!r || kPubList.length !== nn || nn < mm || nn <= 0 || nn > 15) return fail(multisig, n);
        break;
      }
      if (lenD === 64 || lenD === 66) {
        if (lenScript < n + lenD) return fail(multisig, n);
        if (kPubLen === 0) kPubLen = lenD;
        else if (kPubLen !== lenD) return fail(multisig, n);
        kPubList.push(script.slice(n, n + lenD));
        n += lenD;
      } else return fail(multisig, n);
    }
    if (lenScript < n + 2) return fail(multisig, n);
    const flag = script.slice(n, n + 2);
    n += 2;
    if (flag !== "a9" && flag !== "ae") return fail(multisig, n);
    if ((flag === "a9" && kPubLen !== 66) || (flag === "ae" && kPubLen !== 64)) return fail(multisig, n);
    [kPub, scriptSig] = kPubListToScriptHashMultisig(mm, kPubList, nn);
    if (kPub === "" || scriptSig === "") return fail(multisig, n);
    if (unlockSigList.length !== mm) return fail(multisig, n);
    if (unlockSigList.some((x) => x === 0)) return fail(multisig, n);
  }
  return { kPub, scriptSig, multisig, n, ok: true };
}

/** script.go:525-602 (legacy). */
export function parseScriptInputScriptSigLegacy(script: string): SigResult {
  script = script.toLowerCase();
  const lenScript = script.length;
  if (lenScript === 0) return fail(false, 0);
  let [n, r] = dGotoLastScriptLegacy(script, 0);
  if (!r) return fail(false, n);
  let multisig = false;
  let kPub = "", scriptSig = "";
  let mm: number;
  [mm, n, r] = nGetScript(script, n);
  if (r) {
    if (mm > 0 && mm < 16) multisig = true;
    else return fail(multisig, n);
  }
  if (!multisig) {
    let lenD: number;
    [lenD, n, r] = lGetScript(script, n);
    if (!r) return fail(multisig, n);
    let fSig = "";
    if (lenScript > n + lenD + 2) fSig = script.slice(n + lenD, n + lenD + 2);
    if (lenD === 64 && fSig === "ac") { kPub = script.slice(n, n + 64); n += 66; scriptSig = "20" + kPub + fSig; }
    else if (lenD === 66 && fSig === "ab") { kPub = script.slice(n, n + 66); n += 68; scriptSig = "21" + kPub + fSig; }
    else return fail(multisig, n);
  } else {
    const kPubList: string[] = [];
    for (let j = 0; j < 16; j++) {
      let lenD: number;
      [lenD, n, r] = lGetScript(script, n);
      if (!r) {
        let nn: number;
        [nn, n, r] = nGetScript(script, n);
        if (!r || kPubList.length !== nn) return fail(multisig, n);
        [kPub, scriptSig] = kPubListToScriptHashMultisig(mm, kPubList, nn);
        break;
      }
      if (lenD === 64 || lenD === 66) { kPubList.push(script.slice(n, n + lenD)); n += lenD; }
      else return fail(multisig, n);
    }
    if (lenScript < n + 2) return fail(multisig, n);
    const flag = script.slice(n, n + 2);
    n += 2;
    if (flag !== "a9" && flag !== "ae") return fail(multisig, n);
  }
  return { kPub, scriptSig, multisig, n, ok: true };
}

export interface Envelope { from: string; json: string; p1: string; p2: string; scriptSig: string }

function hexToLatin(h: string): string {
  // Go: hex.DecodeString then string(bytes); invalid hex -> partial/empty. JSON parse later decides.
  return Buffer.from(h, "hex").toString("utf8");
}

function parseEnvelopeBody(script: string, sig: SigResult, current: boolean): Envelope | null {
  const lenScript = script.length;
  let n = sig.n;
  if (lenScript < n + 22) return null;
  if (script.slice(n, n + 6) !== "006307") return null;
  n += 6;
  const header = Buffer.from(script.slice(n, n + 14), "hex").toString("latin1").toUpperCase();
  n += 14;
  if (header !== "KASPLEX") return null;
  const pGet = (i: number): [string, number, boolean] => {
    const iRaw = i;
    const [lenP, i2, r] = lGetScript(script, i);
    if (!r || lenScript < i2 + lenP) return ["", iRaw, false];
    if (lenP === 0) return ["", i2, true];
    return [hexToLatin(script.slice(i2, i2 + lenP)), i2 + lenP, true];
  };
  const pFlags: Record<string, string> = { "51": "p1", "53": "p3", "55": "p5", "57": "p7", "59": "p9", "5b": "p11", "5d": "p13", "5f": "p15" };
  let p0 = "", p1 = "", p2 = "";
  let reachedEndIf = false;
  for (let j = 0; j < 2; j++) {
    if (lenScript < n + 2) return null;
    const flag = script.slice(n, n + 2);
    if (current && flag === "68") { n += 2; reachedEndIf = true; break; }
    n += 2;
    let r = true;
    if (flag === "00") [p0, n, r] = pGet(n);
    else if (!current && flag === "68") break;
    else {
      if (!(flag in pFlags)) return null;
      p1 = pFlags[flag];
      [p2, n, r] = pGet(n);
    }
    if (!r) return null;
  }
  if (current) {
    if (!reachedEndIf) {
      if (lenScript < n + 2 || script.slice(n, n + 2) !== "68") return null;
      n += 2;
      reachedEndIf = true;
    }
    if (p0 === "" || !reachedEndIf) return null;
    if (n < lenScript && !isFlatOptionalIf(script, n)) return null;
  } else if (p0 === "") return null;
  const from = sig.multisig ? scriptHashToP2sh(sig.kPub) : kPubToAddr(sig.kPub);
  return { from, json: p0, p1, p2, scriptSig: sig.scriptSig };
}

/** script.go:378-493 */
export function parseScriptInput(script: string): Envelope | null {
  script = script.toLowerCase();
  if (script.length <= 138) return null;
  const sig = parseScriptInputScriptSig(script);
  if (!sig.ok || sig.kPub === "") return null;
  return parseEnvelopeBody(script, sig, true);
}

/** script.go:605-704 */
export function parseScriptInputLegacy(script: string): Envelope | null {
  script = script.toLowerCase();
  if (script.length <= 138) return null;
  const sig = parseScriptInputScriptSigLegacy(script);
  if (!sig.ok || sig.kPub === "") return null;
  return parseEnvelopeBody(script, sig, false);
}

/** script.go:121-141 */
export function isBoundP2SHRedeem(signatureScript: string, spkHex: string | null, spkVersion = 0): boolean {
  if (!spkHex || spkVersion !== 0) return false;
  const s = spkHex.toLowerCase();
  if (s.length !== 70 || s.slice(0, 4) !== "aa20" || s.slice(68, 70) !== "87") return false;
  const script = signatureScript.toLowerCase();
  const [, n, lenD, r] = dGetLastScriptRange(script, 0);
  if (!r || n < 0 || n + lenD > script.length) return false;
  return s.slice(4, 68) === blake2b256Hex(hexToBytes(script.slice(n, n + lenD)));
}

/** Dispatch by accepting-block DAA score, as parseOpData does (script.go:842-857). */
export function parseForDaa(signatureScript: string, daaScore: number, prevSpkHex: string | null): Envelope | null {
  if (daaScore >= HF_DAA_SCRIPT_PARSER_FIX) {
    if (daaScore >= HF_DAA_2026Q1 && !isBoundP2SHRedeem(signatureScript, prevSpkHex)) return null;
    return parseScriptInput(signatureScript);
  }
  return parseScriptInputLegacy(signatureScript);
}
