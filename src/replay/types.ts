/** Normalized raw transaction, built from independent L1 data (dump stream or api.kaspa.org). */
export interface RawInput { index: number; prevTxId: string; prevIndex: number; sig: string; prevAmount: bigint | null; prevSpk: string | null }
export interface RawOutput { index: number; amount: bigint; spk: string; address: string }
export interface Acceptance { blueScore: number; daaScore: number; blockHash: string; daaExact: boolean }
export interface RawTx { txId: string; blockTime: number; inputs: RawInput[]; outputs: RawOutput[]; payload: string | null; accept: Acceptance }

/** One KRC-20 operation candidate extracted from a tx (pre-init). */
export interface OpCandidate {
  txId: string;
  daaScore: number;
  blueScore: number;
  blockTime: number;
  inputIndex: number;
  isPayload: boolean;
  from: string;
  spkFrom: string; // scriptSig of input 0 ("20"+kPub+"ac" etc.), used by list's P2SH binding check
  params: Record<string, string>; // decoded JSON, string values only (non-string forced keys -> op ignored)
  fee: bigint | null; // sum(prev amounts) - sum(outputs); null if unknown
  outputs: RawOutput[];
  inputs: RawInput[];
}
