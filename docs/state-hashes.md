# KRC-20 chained state hashes (`krc20-sh-v1`)

Status: draft. Implementation in `src/hash/stateHash.ts`.

Labels used below: **[V]** I verified it myself (reproduced, or read the code at a pinned commit);
**[S]** sourced from a named document I did not re-derive; **[U]** unverified; **[I]** my inference.

## 1. Why

Two KRC-20 indexers that disagree today can only find out by diffing whole balance tables. Bitcoin's
OPI (Open Protocol Indexer) solved the same problem for BRC-20 with a per-block event hash plus a
cumulative hash chained across blocks: two indexers compare one 64-char string per block and the first
mismatch pins the exact block where they diverged [S: bestinslot-xyz/OPI README, HEAD 6c58fc8, read
2026-10-23]. I want the same for KRC-20, so that my independent replay and the Kasplex indexer (or any
other indexer) can be compared unit-by-unit instead of table-by-table.

What OPI specifies, as far as the README says [S]:

- `EVENT_SEPARATOR = '|'`; event fields joined by `;`; trailing separator removed.
- `block_event_hash = sha256_hex(block_event_string)`.
- `cumulative_event_hash = sha256_hex(last_cumulative_event_hash + block_event_hash)`; for the first
  block the previous value is empty.
- Hashes are produced for every block, including blocks with no events (sha256 of the empty string).
- Its API also exposes a "hash of all current balances"; the README does not pin that format [S].

## 2. The unit

**Unit = one accepting chain block, identified by its accepting DAA score.**

Justification:

1. KRC-20 ops take effect when the transaction is *accepted* by a selected-parent-chain block, not
   when it is included in a block. The accepting chain block is the natural analogue of an OPI block
   [V: go-krc20d `opData.Block["hash"]` in the checkpoint header is the accepting chain block; I
   reproduced a Kasplex checkpoint with it, §6.2].
2. Kasplex's public `opScore` is `daa*10000 + index`, where `daa` is the DAA score of the accepting
   chain block (`ChainBlockHeader.DaaScore` from `GetVirtualChainFromBlockV2`) and `index` counts
   that block's accepted KRC-20 ops in the order the node returns them [V: go-krc20d
   `sequencer/kaspad.go` L135-223 and `explorer/script.go` L1121-1132 @ a9754ff]. So the claim side
   can be grouped into the same units from Kasplex's own data without any extra API field. In
   practice, the DAA must be the accepting chain block's exact header DAA; an interpolated DAA puts an op in the
   wrong unit (choice 8).
3. On the chain path, DAA is strictly increasing per chain block. My implementation does not assume
   this silently: `StateHasher.add` throws if one DAA ever maps to two different chain blocks, so each
   full run re-checks it [V: no full NACHO run has thrown].

Ordering:

- Units are in strictly increasing accepting DAA (enforced; out-of-order input throws).
- Events inside a unit are in execution order, i.e. Kasplex's opScore index: txid order for accepting
  DAA < 110,165,000 and the node's accepted-transaction order from there on [V: go-krc20d
  `sequencer/archive.go` L355/L461 @ a9754ff]. My replay reproduces that by default (`--order node`,
  with an accept-order file); `--order txid` keeps the old txid-only order (choice 7).
- Only accepted ops become events. Rejected ops are not hashed.

Difference from OPI (deliberate): the chain is **sparse**. A unit is emitted only if it has at least
one accepted op for the tick being hashed. OPI hashes every block. With ~1 chain block per second
and long quiet periods per tick, emitting every chain block would multiply output by orders of
magnitude for no comparison value. Because the DAA is inside the unit string (§4), an event that
moves to a different unit still changes both hashes. Choice 1 below gives the reasoning.

Scope: one tick per chain (v1 runs on NACHO). A global all-ticks chain is an obvious extension; the
format already includes the tick in every event.

## 3. Canonical event strings

Fields joined by `;`. Ticks upper-case. Amounts are integer strings in base units (no decimals,
no leading zeros except `0`). Addresses as full `kaspa:` bech32 strings. Any field containing `;`,
`|`, tab or newline makes the implementation throw rather than produce an ambiguous string.

| op | event string |
|---|---|
| deploy | `deploy;<txid>;<from>;<TICK>;<max>;<lim>;<pre or 0>;<dec or 8>;<to>;<mod>` |
| mint | `mint;<txid>;<to>;<TICK>;<amt>` |
| transfer | `transfer;<txid>;<from>;<to>;<TICK>;<amt>` |
| list | `list;<txid>;<from>;<TICK>;<amt>;<utxo>` where `utxo = <listTxid>_<uaddr>_<uamt>` |
| send | `send;<txid>;<from>;<to>;<TICK>;<amt>` (`amt` = token amount delivered) |
| burn | `burn;<txid>;<from>;<TICK>;<amt>` |
| chown | `chown;<txid>;<from>;<to>;<TICK>` |

Notes:

- `mint.amt` is the amount actually credited (the lim, or the remainder on the last mint).
- `list.utxo` uses exactly the format Kasplex returns in its op records [V: field `utxo` in my cached
  NACHO oplist pages], so both sides produce the same string.
- `send` omits the order id. Kasplex's op records for `send` carry `from`, `to`, `amt` and `price` but
  no reference to the list op it filled [V: cached oplist records]. Including the order id would make
  the claim side impossible to build from public data (choice 2).
- Any op type outside the table throws. v1 deliberately fails loudly on anything new (e.g. issue/
  blacklist ops in mod=issue tokens) rather than hashing it in an unspecified way.

## 4. Unit string, separator, chaining

```
unitString  = "krc20-sh-v1;" + daa + "|" + event_1 + "|" + ... + "|" + event_n
unitHash    = sha256_hex(utf8(unitString))
cumulative  = sha256_hex(utf8(prevCumulative + unitHash))     # prevCumulative = "" for the first unit
```

- Separator between events: `|` (as OPI). Between fields: `;` (as OPI). No trailing separator.
- The version tag and the DAA head the unit string, so (a) a format change can never collide with
  v1 and (b) the same events in a different unit hash differently.
- Hash: SHA-256, lower-case hex, as OPI. (Kasplex's native checkpoint uses BLAKE2b-256; §6.2.)

Output row per unit (TSV, gzip): `daa  nEvents  unitHash  cumulative  chainBlock`. `chainBlock` is
informational and **not** hashed, because Kasplex does not publish it per op (§6).

## 5. Balance-state hash

At the end of a run (or at any unit boundary):

```
line(h)  = TICK + ";" + address + ";" + balance + ";" + locked
balances = sha256_hex("krc20-sh-v1-balances|" + join("|", sort_bytewise(line(h) for h with balance+locked > 0)))
```

Open orders get a separate hash: lines `TICK;from;listTxid;tamt`, sorted, prefix
`krc20-sh-v1-markets|`. Holders with zero balance and zero locked are excluded, because indexers differ
in whether they keep empty rows and that difference is not a state difference.

## 6. Comparing with Kasplex

I treat Kasplex data as the claim, not as ground truth. Two levels are available.

### 6.1 Level 1: `krc20-sh-v1` over Kasplex's op records

Kasplex does not publish `krc20-sh-v1` hashes. I compute them from its public op records:
`GET /v1/krc20/oplist?tick=…` pages (fields used: `opScore`, `hashRev` (txid), `op`, `tick`, `amt`,
`from`, `to`, `utxo`, `opAccept`, `max`, `lim`, `pre`, `dec`, `mod`) [V: routes in go-krc20d
`api/init.go` L110-121 @ a9754ff; fields in my cached pages]. The deploy record is not in the per-tick
oplist pages; it comes from `GET /v1/krc20/token/<tick>` (my cached `deploy.json`) [V].
`src/pipeline/claimHashes.ts` groups by `opScore/10000` and hashes with the same code as the
replay. `src/pipeline/hashCompare.ts` merge-joins two unit files on DAA and reports the first
divergence.

### 6.2 Level 2: Kasplex's own per-op checkpoint

Every Kasplex op record carries a `checkpoint` [V: `storage/type.go` L18, `api/v1op.go` L36]. In
go-krc20d @ a9754ffd976254263d8e5bdc9ce166691c0dabb5 (`operation/init.go` ~L280-300) [V]:

```
cpHeader   = blake2b256_hex(opScore + "," + txid + "," + acceptingBlockHash + "," + p + "," + op)
if daa < 408300500:                        # config.HfDaaScore2026Q1, config/load.go L20
    checkpoint = blake2b256_hex(prevCheckpoint + cpHeader + blake2b256_hex(join(";", StAfter)))
else:
    checkpoint = blake2b256_hex(prevCheckpoint + cpHeader + StCommitment)   # MuHash over all state
```

- The chain is global across all ticks and covers only accepted ops.
- `StAfter` is the list of state rows touched by the op, after the op, in a fixed order
  (`sttoken_<tick>,…`, `stbalance_<addr>_<tick>,…`, `stmarket_<tick>_<addr>_<txid>,…`).
- I reproduced op 834430180001's checkpoint `315b27e4…ddbc` exactly, offline, from the previous op's
  checkpoint, the accepting block hash and two rebuilt state rows [V].

Consequences:

- A recomputed checkpoint that matches pins Kasplex's post-op state rows *and* its accepting block
  hash for that op, which is much stronger than Level 1.
- `prevCheckpoint` is the previous accepted op of *any* tick. If the previous NACHO op is not the
  immediately preceding opScore, a mismatch is inconclusive (another tick's op sits in between).
  Only "adjacent" mismatches are meaningful.
- After DAA 408,300,500 the checkpoint commits to a MuHash of the full Kasplex state. I cannot
  recompute that from one tick's data, so Level 2 stops there.

Script: `tools/kasplex_checkpoint_links.py`.

## 7. Versioning

- The version string `krc20-sh-v1` is inside every unit string and the balance/market prefixes.
- Any change to event fields, ordering, unit definition, separator, hash function or density bumps
  the version. Unit files from different versions must never be compared.
- Adding a new op type is a version bump (v1 throws on unknown ops by design).

## 8. Test vectors

`test/fixtures/state-hashes/events.json` (3 units, 6 events, synthetic). Expected values
were computed independently with Python `hashlib`, not with the TypeScript code:

| unit (daa) | unitHash | cumulative |
|---|---|---|
| 100 | `163220006113b623…` | `471bf40e2c69a43e…` |
| 105 | `0de5b0cd87aeb3a9…` | `1369a495cb727aa1…` |
| 107 | `710c9d09823070c6…` | `aeaf301dc62a6fc6…` |

Full values are in `test/stateHash.test.ts`, along with a counterfactual case (one event
dropped from unit 105) and the balance hash.

## 9. Design choices in v1

Each choice says what v1 does, why, and how it relates to OPI. None of them blocks the code:
every alternative below is either already a flag or a version bump.

- **1. Dense vs sparse: sparse (default).** OPI hashes every Bitcoin block, about 144 a day. Kaspa
  has at least one chain block a second (§2), so a dense chain would be at least ~86k units a day,
  almost all of them empty for any one tick [I], and would require the full chain-block list from a node or from Kasplex's
  `/v1/archive/vspc`, which Kasplex has permanently disabled (an S3 export of archive backups is planned). Because the DAA is inside every unit string,
  a sparse chain still changes when an event moves between units, which is the property OPI's density
  buys. Divergence from OPI: deliberate. A dense mode would be `krc20-sh-v1-dense`, not a flag on v1.
- **2. send order id: not in v1 events.** Kasplex op records do not carry it, so including it would make
  the claim side unbuildable from Kasplex's op records alone. It is derivable from L1:
  `send.lua` keys the order by `txInputs[op.index].prevTxId` [V: go-krc20d @ a9754ff], and my checkpoint
  checker takes it from L1 for every send (§6.2). I keep v1 as is; a v2 may add
  `<orderTxid>` (from L1) as a sixth `send` field. The Level 2 checkpoint already pins the consumed
  order, because the market row is in `StAfter`.
- **3. Per-tick vs global: per-tick chain (default), global as a later variant.** OPI's chain is global
  over all BRC-20 events, but OPI is a full indexer. A per-tick verifier only needs one tick's L1
  candidates, which is what makes independent checks cheap. The format already carries the tick in
  every event, so a global chain (`krc20-sh-v1-global`) is the same code over all ticks.
- **4. Rejected ops: not hashed.** Same as OPI. Rejections differ between indexers for reasons that are
  not state differences (e.g. which malformed payloads are even parsed); hashing them would make
  comparisons fail for non-state reasons.
- **5. Post-HF: Level 1 only past DAA 408,300,500.** Past the HF the native checkpoint commits to a
  MuHash of every tick's state, which a per-tick verifier cannot rebuild. Reports label those ops "not
  checkable at Level 2" rather than counting them as matches or mismatches.
- **6. mod=issue: still out of scope; v1 throws.** NACHO is `mod=""` [V: deploy.json], so nothing I run
  is affected. Adding issue/blacklist events is a version bump.
- **7. In-unit order: node acceptance order (default), txid order kept as `--order txid`.** OPI commits
  to execution order, and so does Kasplex: go-krc20d sorts by txid only below DAA 110,165,000 and uses
  the node's accepted-transaction order from there on (`sequencer/archive.go` L355, L461 @ a9754ff)
  [V]. The verifier implements exactly that split (`src/pipeline/run.ts`, `NODE_ORDER_DAA`).
  Kasplex maintainer 5bb55b confirmed on 2026-10-26 that for DAA ≥ 110,165,000 the canonical in-block
  order is the node's VSPC `acceptedTransactionIds` order
  ([go-krc20d#1](https://github.com/kasplex/go-krc20d/issues/1#issuecomment-6410749352)); `/v1/archive/vspc`
  is permanently retired, and Kasplex plans an S3 export of archive backups instead.
  I take an approximation of the node order from api.kaspa.org `/virtual-chain`
  (`tools/vchain_fetch.py`, `tools/vchain_order.py`). That list is not acceptance order: for 73 of the
  74 NACHO order-gap units it is in ascending txid order. Rebuilding from mergesets alone does not work
  either: the block endpoint returns `transactionIds` sorted by txid [V: checked against block responses].
  Checked against block headers (since KIP-15 `acceptedIdMerkleRoot` commits to accepted txids in
  acceptance order), Kasplex's order equals the node's acceptance order in all 11 units that could be
  checked (8 by exact header match, 3 by mergeset order) and the `/virtual-chain` order matched none [V].
  The other 63 cannot be checked from headers (post-Toccata headers carry the KIP-21 `seq_commit`, or the
  unit is too large to search) and need an archival node or Kasplex's archive data [I]. So, as far as
  it can be checked, the gaps are an input defect on the verifier side, not a Kasplex difference. The
  74 units are listed in `test/fixtures/order_gap_units_74.tsv` (DAA, chain block, both orders, Kasplex opScores;
  checked by `test/orderGapData.test.ts`).
- **8. Exact DAA: required.** A unit key must be the accepting chain block's own DAA score. Interpolated
  DAAs are a replay-input defect, not a format choice. The comparison reports units whose DAA came from
  interpolation separately, and `src/pipeline/apiTail.ts --exact-daa` replaces them with header lookups.

## 10. Blind spots

- The hash only proves two indexers agree. It says nothing about whether either applied the protocol
  correctly; both could share a bug.
- My replay depends on its candidate set (which txs were considered). An op missing from both sides
  is invisible to the comparison.
- `chainBlock` is not hashed, so Level 1 does not catch two indexers that agree on events but disagree
  on which chain block accepted them (Level 2 does, pre-HF).
- `send` without an order id (choice 2).
