# krc20-verifier: replay a KRC-20 token from Kaspa L1 and compare it with Kasplex

This tool rebuilds the full state of one KRC-20 token (every op, every holder balance, every locked list order)
from Kaspa base-chain (L1) data only, using the published Kasplex rules. It then compares that state, op by op and
holder by holder, with what the Kasplex indexer reports.

Kasplex data is treated as the **claim**. It is never an input to the replay. It is only compared against, and
for the period after the database dump it supplies the list of tx ids to fetch from L1.

It was built to check NACHO. Running it on NACHO gives one result: every Kasplex op matches, and there is one
L1-accepted, rules-valid mint (`80d736ba…`) that Kasplex never indexed. The write-up is in `docs/nacho-80d736ba-writeup.md`; the 144-address list is in `results/nacho-144/`.

## What it does

1. **Stream the L1 dump** (`tools/pgstream`, Go). Reads the public kaspa-db-filler PostgreSQL dump over HTTP Range
   requests (zstd + pg_dump custom format parser), so nothing needs to be stored locally. It keeps only tx inputs
   and outputs whose script bytes match `kasplex` and the tick. Passes 2 and 3 pull exact acceptance rows
   (`transactions_acceptances`) and block DAA scores (`blocks`) for those txs.
2. **Prep** (`src/pipeline/prep.ts`). Merge-joins inputs, outputs and acceptance into one compact candidate line
   per tx. The line holds the exact accepting block, blue score and DAA, the fee, the input index of the envelope,
   and the parsed params. Envelope parsing (`src/script/parse.ts`) covers the legacy parser, the post-hardfork
   parser, and the 2026Q1 bound-P2SH form.
3. **Fees** (`src/pipeline/feeInputs.ts`). The dump keeps only matching inputs, so a dump-only fee is a lower
   bound. Full input sums for multi-input txs come from api.kaspa.org.
4. **Tail** (`src/pipeline/apiTail.ts`). Ops after the dump's end are fetched from api.kaspa.org. The claim only
   says *which* tx ids to fetch. Content and acceptance come from L1.
5. **Replay** (`src/pipeline/run.ts`, rules in `src/replay/krc20.ts`). Applies deploy/mint/transfer/list/send/
   burn/chown in accepting-block order (blue score, then tx id), with the go-krc20d @a9754ffd rules: daaScore
   windows, the input-0 gate, fee minimums, the `outputs[0]` recipient rule at DAA ≤ 83,525,600, the list/send
   UTXO rules, and the parser switch at DAA 97,539,090. Writes per-op results, holders (balance, locked) and open
   orders.
6. **Claim** (`src/sources/kasplexPull.ts`, `src/pipeline/claimTsv.ts`). Pulls the Kasplex oplist for the tick
   (resumable, rate-limited) and converts it to TSV.
7. **Compare** (`src/pipeline/compare.ts`). Joins replay and claim by tx id. Reports matches, replay-reject/
   claim-accept, replay-accept/claim-reject, ops only on one side, and amount, from/to and DAA mismatches.
8. **Holders** (`tools/holder_diff.py`). Diffs replay holders against the balances implied by the claim
   (`src/pipeline/claimLedger.ts`) and Kasplex's reported top holders.
9. **Cascade** (`tools/cascade.py`). Starting from the addresses touched by replay-only ops, it walks every
   difference in opScore order and marks each one "explained" if its sender (or the seller, for a send) is already
   affected.
10. **Counterfactual cross-check** (`tools/claim_counterfactual.py`). Works without the replay code: it takes
    Kasplex's own op list, applies plain balance rules, inserts one op, and recomputes failures and holders. Send→order links come from L1 inputs
    (`tools/send_links.py`: the send input that spends `<list txid>:0`).
11. **Diagnosis harness** (`diagnosis/krc20d-45f6e14-harness`, Go). Copies the 2024 go-krc20d (45f6e14) script
    parser and fee path. It shows that a mint whose input tx is missing from the indexer's archive is dropped
    with no record and no opScore.

## Free data sources

Everything used is public and free. No accounts or API keys are needed.

- **kaspa-db-filler dump**: `https://db-dl.kaspa.org/out/kaspa-db_all_2025-12-18T16:19:00Z.pgdump.zst`
  (~407 GB, streamed, never stored). It covers L1 to DAA 306,537,872 (2025-12-18).
- **api.kaspa.org**: acceptance for the few txs missing from the dump's acceptance table, full input sums, and the
  post-dump tail. The client (`src/sources/kaspaApi.ts`) is capped at 2 req/s with a disk cache. Please keep it
  polite.
- **api.kasplex.org**: the claim (oplist, token info, op lookups). Query it sequentially, because parallel load
  produces false "op not found" answers.
- **kasplex/go-krc20d** source on GitHub: the rules (a9754ffd) and the 2024 code (45f6e14).

## Reproducing the NACHO result

Requirements: Node ≥ 20, Go ≥ 1.22, Python 3, tens of GB of scratch disk, and patience. The dump stream
takes many hours. Data goes in `$NACHO_DATA` (default `./data`).

```
npm ci && npm test && npm run typecheck

# 1. L1 extract (pass 1: inputs/outputs; pass 2: acceptances; pass 3: block DAA)
(cd tools/pgstream && go build -o ../../data/bin/pgstream .)
data/bin/pgstream -url https://db-dl.kaspa.org/out/kaspa-db_all_2025-12-18T16:19:00Z.pgdump.zst \
   -total 407210601662 -out data/stream -tick nacho
#    pass 2: -acc-set <nacho txids> -stop-after transactions_acceptances
#    pass 3: -blk-set <accepting block hashes> -stop-after blocks
#    sort inputs/outputs by (tx id, index) with LC_ALL=C; join acceptances+blocks into
#    acc_by_tx.tsv.gz = txId acceptingBlock blueScore daaScore, sorted by txId

# 2. claim
TICK=NACHO OUT=data/kasplex/NACHO npm run kasplex:pull

# 3. prep (+ fee inputs + tail), sort, replay
npx tsx src/pipeline/prep.ts --inputs inputs_sorted.tsv.gz --outputs outputs_sorted.tsv.gz --acc acc_by_tx.tsv.gz --fee-inputs fee_inputs.tsv --out data/prep
npx tsx src/pipeline/apiTail.ts --mode tail --ids tail_ids.txt --out data/tail
zcat data/prep/candidates.unsorted.tsv.gz data/tail/tail_candidates.unsorted.tsv.gz | LC_ALL=C sort -k1,1 -k2,2 | gzip > cands.sorted.tsv.gz
npx tsx src/pipeline/run.ts --cands cands.sorted.tsv.gz --out data/replay/run --order txid   # see "State hashes" for --order node

# 4. compare, holders, cascade
npx tsx src/pipeline/claimTsv.ts --claim data/kasplex/NACHO --out claim.tsv.gz   # then sort by tx id / by opScore
npx tsx src/pipeline/compare.ts --results results.bytx.tsv.gz --claim claim_sorted.tsv.gz --dump-max-daa 306537872 --out data/compare
npx tsx src/pipeline/claimLedger.ts --claim claim_by_opscore.tsv.gz --out data/claimledger
python3 tools/holder_diff.py data/replay/run/holders.tsv data/claimledger/claim_ledger_holders.tsv token_NACHO.json data/holders
python3 tools/cascade.py data/compare data/holders/holder_diff.tsv <seed addrs> data/cascade.tsv

# 5. counterfactual: drop the single line for 80d736ba from cands.sorted.tsv.gz and re-run run/compare/holders
# 6. independent cross-check from the claim alone
python3 tools/send_links.py data/kasplex/NACHO/ops data/prep/inputs_sorted.tsv.gz > data/send_links.tsv
# optional: data/sendtx/ = api.kaspa.org /transactions/<id> JSON for sends missing from the dump
python3 tools/claim_counterfactual.py data/kasplex/NACHO/ops data/send_links.tsv data/sendtx --compare data/analysis/cascade.tsv
```

Expected NACHO result (Kasplex pull of 2026-10-20):

- With 80d736ba: all 10,385,075 Kasplex ops are matched. 317 differ (replay rejects, Kasplex accepts):
  260 transfers, 29 lists, 27 sends and 1 mint. 144 holders differ.
- Without 80d736ba: an exact match on ops, all 63,667 holders, balances and locked amounts.

## State hashes (`krc20-sh-v1`)

I wanted a way to compare my replay with Kasplex (or with any other KRC-20 indexer) one accepting chain
block at a time instead of diffing whole balance tables. So I borrowed the idea from Bitcoin's OPI: one
event hash per unit plus a cumulative hash chained across units. Two indexers then compare one 64-char
string per unit, and the first mismatch points at the exact chain block where they diverge. The format,
its choices and its blind spots are in [`docs/state-hashes.md`](docs/state-hashes.md).

In short:

- A unit is one accepting chain block, keyed by its exact DAA score. Only accepted ops become events.
- `unitHash = sha256("krc20-sh-v1;" + daa + "|" + event_1 + "|" + ... )` and
  `cumulative = sha256(prevCumulative + unitHash)`.
- At the end of a run I also hash the balance table (`krc20-sh-v1-balances`) and the open orders
  (`krc20-sh-v1-markets`).

Commands:

```
# replay side: one row per unit (daa nEvents unitHash cumulative chainBlock), plus balance/market hashes in run_summary.json
npx tsx src/pipeline/run.ts --cands cands.sorted.tsv.gz --out data/replay/run \
   --order node --accept-order accept_order.tsv --state-hashes data/replay/run/units.tsv.gz

# claim side: the same chain computed from Kasplex's own op records (claim data, not ground truth)
python3 tools/kasplex_claim_sorted.py data/kasplex/NACHO/ops claim_sorted.tsv.gz
npx tsx src/pipeline/claimHashes.ts --claim claim_sorted.tsv.gz --out data/claim_units.tsv.gz \
   --deploy data/kasplex/NACHO/token.json --holders data/claimledger/claim_ledger_holders.tsv

# first diverging unit (it shows where two inputs agree, not whether either is right)
npx tsx src/pipeline/hashCompare.ts --a data/replay/run/units.tsv.gz --b data/claim_units.tsv.gz --out hash_compare.json

# Kasplex's own per-op checkpoint, recomputed offline (only before DAA 408,300,500)
SEND_ORDERS=send_orders.tsv python3 tools/kasplex_checkpoint_links.py claim_sorted.tsv.gz \
   data/kasplex/NACHO/token.json data/replay/run/units.tsv.gz data/checkpoints
```

In-unit order. Kasplex sorts a chain block's ops by txid below DAA 110,165,000 and keeps the node's
accepted-transaction order from there on (go-krc20d @ a9754ff, `sequencer/archive.go`). `--order node`
(the default) does the same. It needs an accept-order file (`chainBlock daa txid position`). I build it
from api.kaspa.org's `/virtual-chain` endpoint: `tools/vchain_fetch.py` fetches the pages (resumable, one
request at a time, cached by page in `done.txt`) and `tools/vchain_order.py` turns them into the accept-order
file. That endpoint is not a reliable source of acceptance order. For the 74 NACHO order-gap units its list
is in ascending txid order in 73 cases, and checking against block headers (since KIP-15 a chain block's
`acceptedIdMerkleRoot` commits to its accepted txids in acceptance order) showed Kasplex's order is the
node's acceptance order in every unit that could be checked (11 of 74), while the `/virtual-chain` order
matched none of them. As far as it can be checked, the gaps come from this input, not from Kasplex. The block endpoint is not
enough either: its `transactionIds` list comes back sorted by txid.
`--order txid` sorts by txid everywhere, which is the order the
results above were produced with. Units with more than one op that are missing from the accept-order
file fall back to txid order and are counted in
`orderFallbackUnits`.

`send_orders.tsv` (`txid  inputIndex  prevTxId`) tells the checkpoint script which list order each send
consumed. `send.lua` keys the order by the previous tx id of input `op.index`, and Kasplex's op records
don't carry it, so it has to come from L1.

Exact DAA. The API tail only has exact DAA scores near rule boundaries, and everything else is
interpolated. An interpolated DAA can put an op in the wrong unit. `src/pipeline/tailDaa.ts` fetches
the header of every tail accepting block (cached, resumable, rate-limited), and then
`apiTail.ts --mode tail --exact-daa --offline` rebuilds the tail with exact DAAs from that cache.

Tests: `test/stateHash.test.ts` checks the hasher against vectors I computed independently with Python
`hashlib`, and `test/order.test.ts` covers the order split.

## Caveats

- **Tie-break.** Inside one accepting block, Kasplex orders ops by tx id below DAA 110,165,000 (its KIP-15
  adjustment) and by the node's VSPC `acceptedTransactionIds` order from there on, which Kasplex
  [confirmed](https://github.com/kasplex/go-krc20d/issues/1#issuecomment-6410749352). `--order node` (the default)
  applies that split, but it takes the post-110,165,000 order from an accept-order file, and the only builder here
  (`tools/vchain_order.py`) reads api.kaspa.org `/virtual-chain`, which lists txids in ascending order. A faithful
  replay needs that file built from a node's acceptance order. Units missing from the file fall back to tx-id order
  and are counted in `orderFallbackUnits`.
- **Rules version.** The rules are the current open-source go-krc20d @a9754ffd, which is not necessarily the binary
  Kasplex ran at every point in history.
- **Omissions after the dump cannot be seen.** For the post-dump tail, the tx id list comes from Kasplex. An op that
  is valid on L1 but missing from Kasplex after 2025-12-18 would be invisible without a full L1 scan.
- **Byte-filter blind spot.** The dump stream keeps scripts whose bytes match `kasplex` plus the tick. An envelope
  that encodes the tick in a form the filter doesn't match would be missed by both the replay and this check.
- **One token.** Only NACHO has been checked. The same omission mechanism could affect other tokens. They have not
  been scanned.
- **Third-party L1 API.** Some acceptance, fee and tail data comes from api.kaspa.org.

## License

MIT (see LICENSE). Portions come from kasplex/go-krc20d (MIT); see NOTICE.md.
