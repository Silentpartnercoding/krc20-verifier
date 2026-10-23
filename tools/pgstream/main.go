// pgstream: stream a PostgreSQL custom-format dump (pg_dump -Fc, compression none) that is wrapped
// in zstd, straight from HTTPS (resumable Range reconnects) or a local file, WITHOUT storing it.
//
// It parses the archive header and TOC (archive version 1.16 / PG17), then walks the data blocks
// in TOC order and extracts only:
//   - transactions_inputs rows whose signature_script contains the Kasplex envelope marker
//     ("kasplex" = 6b6173706c6578) AND whose decoded script contains the tick (case-insensitive);
//   - transactions_outputs rows of the transactions matched above (same pass: outputs come after inputs);
//   - optional: transactions_acceptances rows for a given tx-id set (-acc-set file);
//   - optional: blocks rows for a given block-hash set (-blk-set file).
//
// Everything else is decompressed and skipped. Outputs are gzipped COPY-text lines.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"
)

const kasplexHex = "6b6173706c6578"

// ---------- resumable HTTP reader ----------

type httpReader struct {
	url     string
	off     int64
	limit   int64 // stop after this many bytes (0 = no limit)
	body    io.ReadCloser
	retries int
}

func (h *httpReader) open() error {
	req, _ := http.NewRequest("GET", h.url, nil)
	req.Header.Set("User-Agent", "krc20-verifier-pgstream/0.1 (independent KRC-20 audit)")
	end := ""
	if h.limit > 0 {
		end = fmt.Sprint(h.limit - 1)
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%s", h.off, end))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	if resp.StatusCode != 206 && !(resp.StatusCode == 200 && h.off == 0) {
		resp.Body.Close()
		return fmt.Errorf("unexpected HTTP %d", resp.StatusCode)
	}
	h.body = resp.Body
	return nil
}

func (h *httpReader) Read(p []byte) (int, error) {
	for {
		if h.limit > 0 && h.off >= h.limit {
			return 0, io.EOF
		}
		if h.body == nil {
			if err := h.open(); err != nil {
				h.retries++
				if h.retries > 50 {
					return 0, err
				}
				log.Printf("http open error at %d: %v (retry %d)", h.off, err, h.retries)
				time.Sleep(time.Duration(min(60, 1<<min(h.retries, 6))) * time.Second)
				continue
			}
		}
		n, err := h.body.Read(p)
		h.off += int64(n)
		atomic.StoreInt64(&compressedRead, h.off)
		if err == nil || (err == io.EOF && n > 0) {
			if err == io.EOF {
				h.body.Close()
				h.body = nil
			}
			return n, nil
		}
		h.body.Close()
		h.body = nil
		if err == io.EOF && (h.limit == 0 || h.off >= h.limit) {
			return n, io.EOF
		}
		log.Printf("http read error at %d: %v; reconnecting", h.off, err)
		h.retries++
		if n > 0 {
			return n, nil
		}
	}
}

type countingFile struct{ f *os.File }

func (c countingFile) Read(p []byte) (int, error) {
	n, err := c.f.Read(p)
	atomic.AddInt64(&compressedRead, int64(n))
	return n, err
}

var compressedRead, decompressedRead int64

// ---------- archive primitives ----------

type arch struct {
	r     *bufio.Reader
	intSz int
	offSz int
	buf   []byte
}

func (a *arch) byte1() byte {
	b, err := a.r.ReadByte()
	must(err)
	atomic.AddInt64(&decompressedRead, 1)
	return b
}

func (a *arch) readN(n int) []byte {
	if cap(a.buf) < n {
		a.buf = make([]byte, n)
	}
	b := a.buf[:n]
	_, err := io.ReadFull(a.r, b)
	must(err)
	atomic.AddInt64(&decompressedRead, int64(n))
	return b
}

func (a *arch) int1() int64 {
	sign := a.byte1()
	b := a.readN(a.intSz)
	var v int64
	for i := a.intSz - 1; i >= 0; i-- {
		v = v<<8 | int64(b[i])
	}
	if sign != 0 {
		v = -v
	}
	return v
}

func (a *arch) str() (string, bool) {
	n := a.int1()
	if n < 0 {
		return "", false
	}
	return string(a.readN(int(n))), true
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

type tocEntry struct {
	DumpID int64
	Desc   string
	Tag    string
	Copy   string
}

func readHeaderAndTOC(a *arch) (map[int64]tocEntry, map[string]any) {
	magic := a.readN(5)
	if string(magic) != "PGDMP" {
		log.Fatalf("bad magic %q", magic)
	}
	vmaj, vmin, vrev := a.byte1(), a.byte1(), a.byte1()
	a.intSz = int(a.byte1())
	a.offSz = int(a.byte1())
	format := a.byte1()
	if vmaj != 1 || vmin != 16 || format != 1 {
		log.Fatalf("unsupported archive %d.%d.%d format %d (parser written for 1.16 custom)", vmaj, vmin, vrev, format)
	}
	comp := a.byte1()
	if comp != 0 {
		log.Fatalf("inner compression %d not supported (expected none)", comp)
	}
	ts := make([]int64, 7)
	for i := range ts {
		ts[i] = a.int1()
	}
	db, _ := a.str()
	remote, _ := a.str()
	dumper, _ := a.str()
	n := a.int1()
	toc := map[int64]tocEntry{}
	for i := int64(0); i < n; i++ {
		id := a.int1()
		a.int1() // hadDumper
		a.str()  // table oid
		a.str()  // oid
		tag, _ := a.str()
		desc, _ := a.str()
		a.int1() // section
		a.str()  // defn
		a.str()  // dropStmt
		cp, _ := a.str()
		a.str()  // namespace
		a.str()  // tablespace
		a.str()  // tableam
		a.int1() // relkind (1.16)
		a.str()  // owner
		a.str()  // "false" (withOids)
		for {
			if _, ok := a.str(); !ok {
				break
			}
		}
		a.byte1()        // offset flag
		a.readN(a.offSz) // offset
		toc[id] = tocEntry{id, desc, tag, cp}
	}
	hdr := map[string]any{
		"archive_version": fmt.Sprintf("%d.%d.%d", vmaj, vmin, vrev),
		"dump_time":       fmt.Sprintf("%04d-%02d-%02d %02d:%02d:%02d (local)", ts[5]+1900, ts[4]+1, ts[3], ts[2], ts[1], ts[0]),
		"db":              db, "server_version": remote, "pg_dump_version": dumper, "toc_entries": n,
	}
	return toc, hdr
}

// ---------- row filters ----------

// idKey packs a 64-hex-char id (tx id or block hash) into 32 bytes. Sets of ~10M ids held as
// map[[32]byte] use well under half the memory of map[string] (no per-key heap string).
func idKey(h []byte) ([32]byte, bool) {
	var k [32]byte
	if len(h) != 64 {
		return k, false
	}
	if _, err := hex.Decode(k[:], bytes.ToLower(h)); err != nil {
		return k, false
	}
	return k, true
}

func loadSet(path string) map[[32]byte]struct{} {
	s := map[[32]byte]struct{}{}
	if path == "" {
		return s
	}
	f, err := os.Open(path)
	must(err)
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		t := strings.TrimSpace(sc.Text())
		if t == "" {
			continue
		}
		k, ok := idKey([]byte(t))
		if !ok {
			log.Fatalf("set %s: not a 64-hex id: %q", path, t)
		}
		s[k] = struct{}{}
	}
	return s
}

// field returns the i-th tab-separated field of a COPY text line.
func field(line []byte, i int) []byte {
	for k := 0; k < i; k++ {
		j := bytes.IndexByte(line, '\t')
		if j < 0 {
			return nil
		}
		line = line[j+1:]
	}
	if j := bytes.IndexByte(line, '\t'); j >= 0 {
		return line[:j]
	}
	return line
}

// byteaHex strips the COPY-text bytea prefix "\\x" and returns the hex payload.
func byteaHex(f []byte) []byte {
	if bytes.HasPrefix(f, []byte(`\\x`)) {
		return f[3:]
	}
	return f
}

// MatchInput reports (isKasplex, matchesTick) for a transactions_inputs COPY line.
// Columns: transaction_id, index, previous_outpoint_hash, previous_outpoint_index, signature_script, ...
func MatchInput(line []byte, tickLower []byte) (bool, bool) {
	ss := byteaHex(field(line, 4))
	if !bytes.Contains(ss, []byte(kasplexHex)) {
		return false, false
	}
	raw := make([]byte, hex.DecodedLen(len(ss)))
	n, err := hex.Decode(raw, ss)
	if err != nil {
		return true, false
	}
	return true, bytes.Contains(bytes.ToLower(raw[:n]), tickLower)
}

// ---------- main ----------

type stats struct {
	Rows    map[string]int64 `json:"rows_per_table"`
	Kasplex int64            `json:"kasplex_input_rows"`
	Tick    int64            `json:"tick_input_rows"`
	Acc     int64            `json:"acceptance_rows_kept"`
	Blk     int64            `json:"block_rows_kept"`
	Out     int64            `json:"output_rows_kept"`
}

func main() {
	url := flag.String("url", "", "HTTPS URL of the .pgdump.zst")
	file := flag.String("file", "", "local .pgdump.zst instead of -url")
	limit := flag.Int64("limit", 0, "stop after this many compressed bytes (sample mode)")
	total := flag.Int64("total", 0, "total compressed size, for ETA")
	outDir := flag.String("out", "data/stream", "output directory")
	tick := flag.String("tick", "nacho", "tick to keep (case-insensitive substring of the decoded script)")
	accSet := flag.String("acc-set", "", "file of tx ids: keep transactions_acceptances rows for these")
	blkSet := flag.String("blk-set", "", "file of block hashes: keep blocks rows for these")
	stopAfter := flag.String("stop-after", "", "stop once this table's data has been fully read (for targeted later passes)")
	stopReached := false
	flag.Parse()
	must(os.MkdirAll(*outDir, 0o755))
	lf, err := os.OpenFile(filepath.Join(*outDir, "pgstream.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	must(err)
	log.SetOutput(io.MultiWriter(os.Stderr, lf))

	var src io.Reader
	if *file != "" {
		f, err := os.Open(*file)
		must(err)
		src = countingFile{f}
	} else {
		src = &httpReader{url: *url, limit: *limit}
	}
	dec, err := zstd.NewReader(bufio.NewReaderSize(src, 8<<20), zstd.WithDecoderConcurrency(4), zstd.WithDecoderMaxWindow(1<<31))
	must(err)
	defer dec.Close()
	a := &arch{r: bufio.NewReaderSize(dec, 16<<20)}

	toc, hdr := readHeaderAndTOC(a)
	hj, _ := json.MarshalIndent(hdr, "", " ")
	log.Printf("header %s", hj)

	open := func(name string) (*gzip.Writer, *os.File) {
		f, err := os.Create(filepath.Join(*outDir, name))
		must(err)
		return gzip.NewWriter(f), f
	}
	inW, inF := open("inputs_" + *tick + ".tsv.gz")
	accW, accF := open("acceptances.tsv.gz")
	blkW, blkF := open("blocks.tsv.gz")
	outW, outF := open("outputs_" + *tick + ".tsv.gz")
	tickTx := map[[32]byte]struct{}{} // tx ids whose inputs matched; transactions_outputs follows transactions_inputs in TOC order
	accIDs, blkIDs := loadSet(*accSet), loadSet(*blkSet)
	tickLower := []byte(strings.ToLower(*tick))

	st := stats{Rows: map[string]int64{}}
	cur := ""
	// The progress goroutine must never touch st/cur directly (st.Rows is a map: concurrent
	// read+write is a fatal runtime error). The hot loop publishes a snapshot instead.
	type snapshot struct {
		cur                          string
		rows, kas, tk, out, acc, blk int64
	}
	var snapMu sync.Mutex
	var snap snapshot
	publish := func() {
		snapMu.Lock()
		snap = snapshot{cur, st.Rows[cur], st.Kasplex, st.Tick, st.Out, st.Acc, st.Blk}
		snapMu.Unlock()
	}
	start := time.Now()
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(15 * time.Second)
		for {
			select {
			case <-done:
				return
			case <-t.C:
				c := atomic.LoadInt64(&compressedRead)
				el := time.Since(start).Seconds()
				rate := float64(c) / el
				eta := "?"
				if *total > 0 && rate > 0 {
					eta = (time.Duration(float64(*total-c)/rate) * time.Second).String()
				}
				snapMu.Lock()
				sn := snap
				snapMu.Unlock()
				log.Printf("progress compressed=%.2fGB decompressed=%.2fGB rate=%.1fMB/s table=%s rows=%d kasplex=%d tick=%d out=%d acc=%d blk=%d eta=%s",
					float64(c)/1e9, float64(atomic.LoadInt64(&decompressedRead))/1e9, rate/1e6, sn.cur, sn.rows, sn.kas, sn.tk, sn.out, sn.acc, sn.blk, eta)
			}
		}
	}()

	var carry []byte
	finish := func() {
		close(done)
		for _, w := range []*gzip.Writer{inW, accW, blkW, outW} {
			must(w.Close())
		}
		for _, f := range []*os.File{inF, accF, blkF, outF} {
			must(f.Close())
		}
		st2, _ := json.MarshalIndent(map[string]any{"header": hdr, "stats": st, "compressed_bytes": atomic.LoadInt64(&compressedRead),
			"decompressed_bytes": atomic.LoadInt64(&decompressedRead), "elapsed_s": time.Since(start).Seconds(), "complete": cur == "<end>"}, "", " ")
		must(os.WriteFile(filepath.Join(*outDir, "stats.json"), st2, 0o644))
		log.Printf("finished: %s", st2)
	}
	defer func() {
		if r := recover(); r != nil {
			log.Printf("stopped: %v", r)
			finish()
			os.Exit(2)
		}
	}()

	for {
		bt, err := a.r.ReadByte()
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			if *limit > 0 {
				log.Printf("sample limit reached inside table %s", cur)
			} else {
				cur = "<end>"
			}
			break
		}
		must(err)
		atomic.AddInt64(&decompressedRead, 1)
		if bt != 1 {
			log.Fatalf("unexpected block type %d (only BLK_DATA supported)", bt)
		}
		id := a.int1()
		e, ok := toc[id]
		if !ok {
			log.Fatalf("data block for unknown dumpId %d", id)
		}
		if *stopAfter != "" && stopReached {
			log.Printf("stop-after %s reached; ending before %s", *stopAfter, e.Tag)
			cur = "<stopped>"
			break
		}
		cur = e.Tag
		publish()
		log.Printf("table data start: %s (dumpId %d)", cur, id)
		carry = carry[:0]
		for {
			n, cerr := safeInt(a)
			if cerr != nil {
				panic(cerr)
			}
			if n == 0 {
				break
			}
			chunk, rerr := safeRead(a, int(n))
			if rerr != nil {
				panic(rerr)
			}
			// Split into complete lines (rows may span chunks).
			data := chunk
			if len(carry) > 0 {
				carry = append(carry, chunk...)
				data = carry
			}
			for {
				j := bytes.IndexByte(data, '\n')
				if j < 0 {
					break
				}
				line := data[:j]
				data = data[j+1:]
				st.Rows[cur]++
				if st.Rows[cur]&0xFFFFF == 0 {
					publish()
				}
				switch cur {
				case "transactions_inputs":
					if isK, isT := MatchInput(line, tickLower); isK {
						st.Kasplex++
						if isT {
							st.Tick++
							if k, ok := idKey(byteaHex(field(line, 0))); ok {
								tickTx[k] = struct{}{}
							} else {
								log.Fatalf("bad transaction_id in inputs row: %.80q", line)
							}
							inW.Write(line)
							inW.Write([]byte{'\n'})
						}
					}
				case "transactions_outputs":
					if k, ok := idKey(byteaHex(field(line, 0))); ok && hasKey(tickTx, k) {
						st.Out++
						outW.Write(line)
						outW.Write([]byte{'\n'})
					}
				case "transactions_acceptances":
					if len(accIDs) > 0 {
						if k, ok := idKey(byteaHex(field(line, 0))); ok && hasKey(accIDs, k) {
							st.Acc++
							accW.Write(line)
							accW.Write([]byte{'\n'})
						}
					}
				case "blocks":
					if len(blkIDs) > 0 {
						if k, ok := idKey(byteaHex(field(line, 0))); ok && hasKey(blkIDs, k) {
							st.Blk++
							blkW.Write(line)
							blkW.Write([]byte{'\n'})
						}
					}
				}
			}
			carry = append(carry[:0], data...)
		}
		log.Printf("table data end: %s rows=%d", cur, st.Rows[cur])
		publish()
		if cur == *stopAfter {
			stopReached = true
		}
	}
	finish()
}

func hasKey(m map[[32]byte]struct{}, k [32]byte) bool {
	_, ok := m[k]
	return ok
}

func safeInt(a *arch) (v int64, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	sign, e := a.r.ReadByte()
	if e != nil {
		return 0, e
	}
	b := make([]byte, a.intSz)
	if _, e := io.ReadFull(a.r, b); e != nil {
		return 0, e
	}
	atomic.AddInt64(&decompressedRead, int64(1+a.intSz))
	v = int64(binary.LittleEndian.Uint32(b))
	if sign != 0 {
		v = -v
	}
	return v, nil
}

func safeRead(a *arch, n int) ([]byte, error) {
	if cap(a.buf) < n {
		a.buf = make([]byte, n)
	}
	b := a.buf[:n]
	if _, err := io.ReadFull(a.r, b); err != nil {
		return nil, err
	}
	atomic.AddInt64(&decompressedRead, int64(n))
	return b, nil
}
