# go-krc20d 45f6e14 mint/fee harness

This harness reproduces how the 2024 Kasplex executor code (go-krc20d commit 45f6e14, 2024-09-10, the last commit
before 2024-09-15) treats a single KRC-20 reveal tx.

```
go build -o oldharness .
./oldharness <input0 signature script hex> <accepting DAA> <amountIn | -1 if input tx missing> <amountOut> <outputs[0] address>
```

It prints either `ACCEPT-path`, a stored rejection (for example "fee not enough"), or
`DROP fee: amountIn=0 <= amountOut=…`. The DROP case is the `ParseOpDataList` fee path. When the input tx is not in
the indexer's archive, it adds 0 to amountIn, sets Fee = 0, and `continue`s, so the op is never stored and never
gets an opScore.

- `c1d42e81_oldcode_results.json`: results for all 179 envelope txs accepted by chain block c1d42e81 (DAA
  90,114,862), with inputs present (A) and absent (B). With inputs present, it reproduces all 178 Kasplex records.
  80d736ba is ACCEPT-path, and becomes DROP if its input is absent.
- `old_commit_ops_kasplex.txt`: the 45 ops whose commit tx is older than blue 81,838,000, and what Kasplex returns
  for each.
- `oldscen.py`, `showold.py`: helpers that build those tables. They fetch from api.kaspa.org one tx at a time.
