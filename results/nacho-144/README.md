# NACHO: the 144 holders that differ when mint 80d736ba is counted

Checkpoint: Kasplex NACHO oplist pulled 2026-10-20 (started 06:18:44 PDT; last applied opScore 5707394580000,
DAA 570,739,458; Kasplex version 3.01.260930). Live columns: Kasplex address API, 2026-10-23 06:10:35–06:13:55 PDT.

A "delta" here is the difference between two ledgers: the L1 replay with 80d736ba, and Kasplex's ledger. It is
ledger arithmetic only. Addresses are ledger keys; nothing here says who controls them.

## File

`nacho-144-address-export-2026-10-23.csv`: 144 rows, sorted by |delta_total| descending. Amounts are integer base
units (8 decimals; 1 NACHO = 100,000,000). SHA-256
`2d68052b0b609907a079421c59494260bac7629348a24f1f4b23a08f18085daa`.

| Column | Meaning |
|---|---|
| `address` | Kaspa address |
| `kasplex_balance/locked/total` | Kasplex ledger at the checkpoint, built by applying Kasplex's own accepted-op list (63,667 holders, equal to Kasplex's reported holder count and to the replay without 80d736ba) |
| `replay_balance/locked/total` | L1 replay with 80d736ba (go-krc20d @a9754ffd rules) |
| `delta_balance/locked/total` | replay − Kasplex |
| `first_causal_txid/op/replay_result/daa` | earliest of the 317 differing ops (opScore order) that touches the address; Kasplex accepted all 317 |
| `first_causal_time_pdt`, `first_causal_time_source` | Kasplex `mtsAdd`; for 80d736ba (not in Kasplex) the api.kaspa.org block time |
| `causal_chain` | hops back to 80d736ba, `tx->address <= tx->address …` (8-hex txid prefixes; first 8 chars after `kaspa:`) |
| `in_taint_173` | address is in the 173-address set reached from the two seed addresses |
| `indep_model_match` | `tools/claim_counterfactual.py` (no shared code with the replay) gives the same balance and locked on both sides |
| `live_kasplex_*`, `live_changed_since_checkpoint` | dated live Kasplex values; additional columns, the checkpoint values are not replaced |

## Summary (checkpoint 2026-10-20)

- 144 addresses differ: 78 hold NACHO only in Kasplex's ledger, 9 only in the replay, 57 in both with different
  amounts.
- 20 deltas are positive and 124 negative; they net to 0. Total supply is 287,000,000,000 NACHO on both sides.
- Sum of |delta| = 29,029,072,627.53009412 NACHO.
- First differing op per address: 136 transfer, 6 send, 2 mint (80d736ba itself and 16054c2b).
- All 144 are in the 173-address set; the longest chain is 12 hops.
- The independent model gives the same 317 ops and the same 144 addresses, with 0 mismatches. It matches sends to
  listings from L1 inputs (the send spends output 0 of the list transaction).
- The L1 vault address `kaspa:qrf5mw2ru0av3dgfmkhvh0hets8k84wxcaqqr3jv9wdf6st44h0cxql4syxt8` is one of the 144:
  50,642,912.02520418 (Kasplex) vs 414,461,557.64215612 (replay), delta +363,818,645.61695194. Its first
  differing op is transfer `2139f556…` (2026-09-16).
- Live (2026-10-23 06:10–06:14 PDT): 7 of the 144 changed since the checkpoint.

The cause of the omission is most likely, not proven (one example); see `docs/nacho-80d736ba-writeup.md`. This list
concerns the 2024 omission only and is separate from the September 2026 incident.

## Rebuild

```
python3 tools/claim_counterfactual.py OPS_DIR send_links.tsv SENDTX_DIR --compare cascade.tsv \
  --out indep_fails.tsv --holders-out indep_holder_diff.tsv
python3 tools/affected_export.py holder_diff.tsv cascade.tsv OPS_DIR nacho-144.csv \
  --indep indep_holder_diff.tsv --live LIVE_DIR
```

`holder_diff.tsv` and `cascade.tsv` come from the replay pipeline in the main README; `LIVE_DIR` holds one
`api.kasplex.org/v1/krc20/address/<addr>/token/NACHO` response per address, fetched sequentially.
