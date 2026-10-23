# Third-party notice

`src/script/parse.ts`, `src/script/address.ts`, `src/replay/extract.ts` and `src/replay/krc20.ts` port logic
from **kasplex/go-krc20d** at commit a9754ffd. Line citations are in the source comments. That project is
MIT-licensed.

`diagnosis/krc20d-45f6e14-harness/` contains a verbatim copy of `parseScriptInput`, `ValidateTick` and
`misc/address.go`, and a line-by-line re-typing of the mint validate and fee logic, from **kasplex/go-krc20d** at
commit 45f6e14 (2024-09-10). Same license:

```
MIT License

Copyright (c) 2024 Kasplex

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
