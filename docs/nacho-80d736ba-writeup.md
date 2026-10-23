
# NACHO on Kasplex: an independent replay from Kaspa L1 finds one missing mint

*James Siyuan He · October 2026*

I rebuilt the full NACHO KRC-20 ledger from Kaspa base-chain (L1) data alone. Then I compared it, op by op and
holder by holder, with what the Kasplex indexer reports. The result is clean apart from one finding:

- **All 10,385,075 Kasplex-accepted NACHO ops match** an L1 transaction with the same op type, amount, sender and
  recipient. Kasplex lists nothing that L1 does not support.
- **One mint is missing from Kasplex.** Mint
  `80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795` was accepted on L1 on 2024-09-15 and passes
  every published KRC-20 rule I can find. Kasplex has no record of it ("op not found").
- **Without that one mint, the replay matches Kasplex exactly**: every op, all 63,667 holders, and every balance and
  locked amount.
- **With it, 317 Kasplex-accepted ops would fail and 144 holder balances would differ.** That includes the #2 holder
  in the 2026-10-20 snapshot and the L1 vault address `kaspa:qrf5mw2r…syxt8`.
- **The omission persisted after Kasplex's 2026-10-01 re-sync.** It is in my 2026-10-20 pull and was still "op not
  found" on 2026-10-23.

Ledger numbers are as of my Kasplex pull of 2026-10-20 (started 06:18 PDT) unless marked otherwise. Live values
are dated where given; I did not re-rank live holders. The verifier code and its
README are in this repository.

## What was checked

- **L1 source.** The public kaspa-db-filler PostgreSQL dump (`db-dl.kaspa.org`, snapshot of 2025-12-18, up to DAA
  306,537,872). I streamed it and kept every transaction whose scripts contain a `kasplex` envelope for NACHO. That
  gave 10,925,266 candidate transactions, with their exact accepting blocks and DAA scores.
- **After the dump.** The 32,921 transactions after the dump's end came from api.kaspa.org. All of them were
  L1-accepted.
- **Rules.** Kasplex's open-source indexer, kasplex/go-krc20d at a9754ffd, re-implemented in TypeScript. This
  covers both script parsers, the input-0 rule, mint windows and the cap, fee minimums, transfer/list/send, and the
  2026 P2SH binding.
- **Order.** Ops are ordered by accepting-block blue score. Inside one accepting block they are ordered by tx id.
- **Kasplex data is only compared against.** It never feeds the replay's state.
- **Comparison.** I compared every op by tx id, then every holder's balance and locked amount.

Everything used is free and public. Nothing needed an account.

## The finding

### The missing mint

| | |
|---|---|
| tx | `80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795` |
| envelope (input 0) | `… 00 63 07 "kasplex" 51 01 00 00 29 {"p":"KRC-20","op":"mint","tick":"NACHO"} 68` |
| accepted | chain block `c1d42e81…`, DAA 90,114,862, 2024-09-15 11:39:33 PDT |
| fee | 1.00096846 KAS (minimum 1 KAS) |
| minter | `kaspa:qr08qfv4veqtwvxzcw964q9tn70ne70n0gzsf5j4cgjzxtytvrdwuwk76m0ms` |
| Kasplex | `GET /v1/krc20/op/80d736ba…` → `op not found` (checked repeatedly; last on 2026-10-23 06:29 PDT) |

Why I consider it valid:

- **Mint window.** DAA 90,114,862 is inside the open window (≥ 90,090,600).
- **Fee.** It pays the 1 KAS mint fee.
- **Envelope.** The envelope is at input 0 in the standard commit-reveal form. The `51 01 00` parameter form is
  common: about 2.63 million input rows in the NACHO L1 extract use it.
- **Cap.** NACHO's cap had not been reached. The last mint Kasplex accepts is 46,686 DAA later.
- **Block neighbours.** The same chain block accepted 178 other KRC-20 envelope transactions. Kasplex has all 178,
  with contiguous opScores …0000 to …0177.
- **The 179th.** 80d736ba is the only transaction in that block that Kasplex lacks. Its tx id sorts in the middle of
  the block, and every opScore after that point is shifted down by one. So it was never counted. It was not stored
  and then deleted.

There is also a check that uses Kasplex's own data:

- The mint's output 0 was spent by tx `54cb496d…`. Output 0 of `54cb496d…` funded the reveal
  `e02d3e8c8fc858478d2270cfb58c25957c74429589b34b66bf92e23d136c01b8`. That reveal is another NACHO mint by the same
  minter, at DAA 90,129,302.
- Kasplex accepted `e02d3e8c…` with a full 1 KAS fee recorded (feeRev 100000000).
- I recomputed all four transaction ids (commit, 80d736ba, 54cb496d, e02d3e8c) from their contents.
- So Kasplex's own index depends on a transaction that spends 80d736ba's output.

### What it changes: the cascade

KRC-20 transfers are all-or-nothing: a transfer of more than the sender holds fails. That is why one missing mint
spreads:

1. **The cap fills one mint earlier.** NACHO's cap is 10,000,000 mints of 28,700 NACHO. Counting 80d736ba fills the
   cap one mint sooner.
2. **The last mint fails.** The last mint Kasplex accepts is
   `16054c2b649741533e9e7b9b45c5001ea5c4e24fabd8b28662ad405a1f50e29c`, at DAA 90,161,548. It becomes "mint
   finished". Its minter, `kaspa:qryuv3pt…`, is now 28,700 NACHO short.
3. **That minter's whole-balance transfer fails.** It later sends its whole Kasplex balance (185,947,300 NACHO) in
   transfer `8c952388…`. Under the rules that transfer fails, because the sender is one mint short.
4. **The chain repeats.** The tokens stay put, and the next holder's whole-balance transfer fails in turn:
   `qplktwz…` → `qp2herg…` → `kaspa:qrf3rcpv…cdjrdl7y`.
5. **It reaches the #2 holder.** The last failure in that chain is transfer `e1f78706…` of 13,051,979,581.18 NACHO
   to `kaspa:qpwztwfam65p88zpw44m6ht6ghpvx8k3qszcwghkgvwe644kzp0g2p8jvych2`, the #2 NACHO holder in the 2026-10-20 snapshot.
   That address's later transfers and listings then fail too, along with whatever its recipients did next.

End state with the mint counted, compared with Kasplex (2026-10-20 pull):

| | Replay (with 80d736ba) | Kasplex |
|---|---|---|
| ops accepted | 10,384,759 | 10,385,075 |
| ops Kasplex accepts that fail in the replay | 317 (260 transfers, 29 lists, 27 sends, 1 mint) | – |
| ops accepted only in the replay | 1 (80d736ba) | – |
| holders | 63,598 | 63,667 |
| holders that differ | 144 (78 only on Kasplex, 9 only in the replay, 57 both with different amounts) | |
| `qpwztwfa…` (#2 at 10-20) | 66,566.52 NACHO | 9,758,529,404.98 NACHO |
| `qrf3rcpv…` | 12,539,800,962.58 NACHO | 0 |
| total supply (balance + locked) | 287,000,000,000 NACHO | 287,000,000,000 NACHO |

Total supply is the same either way. The difference is who holds it.

A taint walk explains every one of the 317 ops. It starts from the two addresses touched by 80d736ba and 16054c2b
and walks forward in order. Each failing op is sent by an address that the cascade had already reached, and all 144
differing holders are in the resulting 173-address set. I also re-derived the cascade a second way. A separate
script, which shares no code with the replay, applies the mint to Kasplex's own op list. It matches each send to
the listing it fills from L1 inputs (the send spends output 0 of the list transaction). It gets the same 317
failing ops (the identical set), the same 144 differing holders and the same balances for the addresses above.
Without the mint it reproduces Kasplex with zero failures.

Removing only 80d736ba from the replay inputs gives an exact match on everything. **The missing mint is the entire
difference.**

**The L1 vault address is one of the 144.** `kaspa:qrf5mw2ru0av3dgfmkhvh0hets8k84wxcaqqr3jv9wdf6st44h0cxql4syxt8`
holds 50,642,912.02520418 NACHO in Kasplex's ledger at the 2026-10-20 pull and 414,461,557.64215612 in the replay
with 80d736ba, a difference of 363,818,645.61695194 NACHO. The first op in its chain is transfer `2139f556…`
(2026-09-16), which traces back to the 2024 mint. This is a 2024-omission effect only. It is separate from the
September 2026 incident and says nothing about it. Kasplex's live balance for the address was 0 on 2026-10-23.
The full list of 144 addresses, with both balances and the causal chain for each, is in `results/nacho-144/`.

On 2026-10-23 (06:29 PDT), Kasplex's live API still had no record of 80d736ba. The `qpwztwfa…` address held
948,495,200,866,760,162 base units (≈ 9.48 billion NACHO) on 2026-10-23 (06:10–06:14 PDT); I did not re-rank live
holders. Kasplex re-synced its service around 2026-10-01 after the September 2026 incident (version 3.01.260930).
My 2026-10-20 pull was taken after that, so the omission persisted through that re-sync.

## Most likely cause (not proven, one example)

**Most likely:** the mint's input transaction was missing from the archive that Kasplex's indexer used for fee
lookups. As a result, the 2024 indexer code dropped the mint silently.

**The input is unusually old.**
- The mint spends a P2SH commit, `736761d911bec9636af6d33fd0ee2856111a578b8b9fe3bb7c5c20e21437b1c9`, accepted on
  2024-06-29 at DAA 83,345,800. That is 78 days before the reveal.
- I checked every NACHO op whose envelope is at input 0 and whose commit is that old. It is the only one whose
  commit is older than DAA 83,408,001, and it is the only one missing.
- All 39 such ops with commits between DAA 83,408,001 and about 83.44M are present in Kasplex, with fees that show
  the input amount was known.
- That brackets an archive start between 2024-06-29 04:30 and 21:48 PDT. This is just before the start of the indexer's first
  operating window, DAA 83,441,551.

**The 2024 code drops exactly this case.**
- In go-krc20d at commit 45f6e14 (2024-09-10, the last commit before this block), `ParseOpDataList` sums input
  amounts from the indexer's own transaction archive. If an input transaction is not in the archive, it adds 0.
- The mint then looks like it pays no fee, and the code sets `Fee = 0` and `continue`s.
- The op is never stored and never gets an opScore. That is exactly what we see: "op not found" and no gap.
- A harness with those functions copied from 45f6e14 reproduces all 178 Kasplex records in that block. It accepts
  80d736ba when the input is present and drops it when the input is absent.
- A later commit, 79c424e (2026-03-01), reads the input amount from the node before falling back to the archive.
  But nodes are pruned, so that cannot help with 2024 transactions, and the op is still missing today.

**Why this is not proven.**
- There is only one example. No second "old commit → missing op" case exists to test against.
- I cannot see Kasplex's archive or which binary they ran in September 2024.
- Only Kasplex can confirm or rule out this explanation.

## What is ruled out

- **An invalid op.** The script, envelope, tick, mint window, fee and cap all pass the 2024 code and the current
  code. No documented mint rule rejects it.
- **Indexed, then deleted or rejected.** There is no record at all and no opScore gap. A rejection would be stored
  with an error, for example "fee not enough", not as "not found".
- **A skipped block or batch.** The other 178 ops in that chain block are present, and so is every other
  valid KRC-20 op in the 19 blocks around it.
- **L1 problems.** The commit output is spent once, both blocks are chain blocks, and the accepting block has no red
  merges. Kasplex's own index depends on a spend of this mint's output.
- **A reorg.** A rollback re-processes the whole block, so it cannot single out one transaction.
- **Ordering or bugs in my replay.** Only 6 of the 317 differences sit in blocks with tied ordering, and all 6 are
  downstream of the cascade. Removing the single mint yields an exact match, which leaves no room for other errors
  in the replay.
- **The September 2026 rollback.** The omission is present in data pulled after Kasplex's re-sync, and live on
  2026-10-23.

## Limitations

- **Tie-break.** Inside one accepting block I order ops by tx id. Kasplex's opScores in the affected block fit
  that order, but the node's own acceptance order is not in the public dump.
- **Rules version.** The replay uses current go-krc20d (a9754ffd). For this mint, I also checked the 2024 code
  (45f6e14) and the documented rules.
- **Omissions after 2025-12-18 cannot be seen.** For the period after the dump, I verified every op Kasplex lists,
  but the list of tx ids came from Kasplex. A valid op Kasplex never indexed in that period would be invisible here.
- **Byte-filter blind spot.** The L1 stream keeps scripts whose bytes contain `kasplex` and the tick. An envelope
  encoded in a form the filter doesn't match would be missed by my replay as well as by this comparison.
- **Other tokens not scanned.** If the cause is an archive start in late June 2024, any KRC-20 reveal whose commit
  predates that boundary could be affected. Only NACHO was checked.
- **One example.** The cause above rests on a single case.

## Why it matters

- **Migration snapshots.** KRC-20 tokens are expected to migrate to KCC-20, and a migration starts from a snapshot of
  who holds what. If the snapshot is the indexer's state, an omission like this one becomes permanent in the new
  token. Here that means 144 addresses, including the #2 holder at 10-20 and the L1 vault address.
- **Holders and exchanges.** Holders and exchanges reconcile against Kasplex balances. For NACHO the indexer is
  internally consistent and every op it shows is real. The question is whether every valid op is there.
- **Checking snapshots.** A snapshot can be checked against L1 independently, for free. The tool here does that.

## Questions for Kasplex

1. Is commit transaction `736761d911bec9636af6d33fd0ee2856111a578b8b9fe3bb7c5c20e21437b1c9` in your node or
   transaction archive? When does that archive begin?
2. Should mint `80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795` be indexed? If not, which rule
   rejects it?
3. If it should be, how would the 317 downstream ops be handled, especially before any KCC-20 snapshot?
4. Have other tokens' reveals with commits from before late June 2024 been checked for the same case?

## How to reproduce

The verifier is in this repository (TypeScript, Go and Python, MIT). Its README covers the data sources and the full
pipeline. In short:

1. Stream the 2025-12-18 kaspa-db-filler dump with `tools/pgstream` (no local copy needed).
2. Prep, sort and replay with `src/pipeline/{prep,run}.ts`, and fetch the post-dump tail from api.kaspa.org.
3. Pull Kasplex's NACHO oplist, then run `compare.ts`, `tools/holder_diff.py` and `tools/cascade.py`.
4. Drop the single 80d736ba line and re-run to get the exact match.
5. To check the cascade without the replay, run `tools/claim_counterfactual.py` on Kasplex's own oplist.
6. To check the 2024 code path, run `diagnosis/krc20d-45f6e14-harness`.

Quick checks that need no setup:

```
curl https://api.kasplex.org/v1/krc20/op/80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795   # op not found
curl "https://api.kaspa.org/transactions/80d736ba74376ea909ff4e2ae849b7e6178bffd1f3ac71345876c12acbed4795?inputs=true&outputs=true"   # is_accepted: true
curl https://api.kasplex.org/v1/krc20/op/e02d3e8c8fc858478d2270cfb58c25957c74429589b34b66bf92e23d136c01b8   # accepted; its funding tx spends 80d736ba:0
curl https://api.kasplex.org/v1/archive/oplist/9011486   # 178 ops at DAA 90114862; 80d736ba absent
```

Please query api.kasplex.org one request at a time, because under parallel load it can return a false "op not
found". Keep api.kaspa.org under 2 requests per second.
