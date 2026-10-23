/**
 * Kaspa address encoding (bech32 variant with 40-bit checksum, prefix "kaspa").
 * Mirrors go-krc20d misc/address.go EncodeBech32/DecodeBech32/ConvKPubToAddr/ConvKPubToP2sh/VerifyAddr
 * (kasplex/go-krc20d @ a9754ffd, misc/address.go:46-260).
 */
import { blake2b256Hex } from "./blake2b.js";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const v of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(v);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

function prefixData(prefix: string): number[] {
  return [...prefix].map((ch) => ch.charCodeAt(0) & 31).concat([0]);
}

function convertBits(data: Uint8Array | number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

export function encodeAddress(version: number, payload: Uint8Array, prefix = "kaspa"): string {
  const data = convertBits(Uint8Array.from([version, ...payload]), 8, 5, true)!;
  const pm = polymod([...prefixData(prefix), ...data, 0, 0, 0, 0, 0, 0, 0, 0]);
  const cs: number[] = [];
  for (let i = 0; i < 8; i++) cs.push(Number((pm >> BigInt(5 * (7 - i))) & 31n));
  return `${prefix}:${[...data, ...cs].map((d) => CHARSET[d]).join("")}`;
}

export function decodeAddress(addr: string, prefix = "kaspa"): { version: number; payload: Uint8Array } | null {
  if (!addr.startsWith(prefix + ":")) return null;
  const body = addr.slice(prefix.length + 1);
  const vals: number[] = [];
  for (const ch of body) {
    const i = CHARSET.indexOf(ch);
    if (i < 0) return null;
    vals.push(i);
  }
  if (vals.length < 9) return null;
  if (polymod([...prefixData(prefix), ...vals]) !== 0n) return null;
  const bytes = convertBits(vals.slice(0, -8), 5, 8, false);
  if (!bytes || bytes.length < 1) return null;
  return { version: bytes[0], payload: Uint8Array.from(bytes.slice(1)) };
}

export const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
export { blake2b256Hex };

/** go-krc20d ConvKPubToAddr: 64-hex Schnorr key -> version 0, 66-hex ECDSA key -> version 1. */
export function kPubToAddr(kPubHex: string): string {
  if (kPubHex.length === 64) return encodeAddress(0, hexToBytes(kPubHex));
  if (kPubHex.length === 66) return encodeAddress(1, hexToBytes(kPubHex));
  return "";
}

/** go-krc20d ConvKPubToP2sh: 64-hex script hash -> version 8. */
export function scriptHashToP2sh(hashHex: string): string {
  return hashHex.length === 64 ? encodeAddress(8, hexToBytes(hashHex)) : "";
}

/** go-krc20d VerifyAddr: decodes and re-encodes; only versions 0, 1 (with matching lengths) and 8 round-trip. */
export function verifyAddr(addr: string): boolean {
  const d = decodeAddress(addr);
  if (!d || d.payload.length < 32) return false;
  const hexKey = Buffer.from(d.payload).toString("hex");
  const again = d.version === 8 ? scriptHashToP2sh(hexKey) : d.version === 0 || d.version === 1 ? (d.version === 0 ? (hexKey.length === 64 ? kPubToAddr(hexKey) : "") : (hexKey.length === 66 ? kPubToAddr(hexKey) : "")) : "";
  return again === addr;
}

/** Address of an output script public key (version 0 only): P2PK Schnorr, P2PK ECDSA, P2SH. */
export function spkToAddr(spkHex: string): string {
  const s = spkHex.toLowerCase();
  if (s.length === 68 && s.startsWith("20") && s.endsWith("ac")) return kPubToAddr(s.slice(2, 66));
  if (s.length === 70 && s.startsWith("21") && s.endsWith("ab")) return kPubToAddr(s.slice(2, 68));
  if (s.length === 70 && s.startsWith("aa20") && s.endsWith("87")) return scriptHashToP2sh(s.slice(4, 68));
  return "";
}
