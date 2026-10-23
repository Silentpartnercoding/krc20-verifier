package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Real NACHO deploy reveal input (tx 85359b7768ba60cde4559b6e03ef2685d27ca7be3b1fa2cda976743e17f7c3ad),
// signature_script as served by api.kaspa.org /transactions/{id}, rendered as a COPY-text row.
const deploySig = "41925fd564bd76c9eebd0b99e14e5e3d6d207e593d31196de1ce944b71a0f341e2780275a697d352f4755946f31e2346ad59fca7d04a2da6056d657fb9919795dc014c9b2087002b6991609f70998f280f4b9990be37f4d6a4845485156033ed646d230c61ac0063076b6173706c6578510100004c687b2270223a224b52432d3230222c226f70223a226465706c6f79222c227469636b223a224e4143484f222c226d6178223a223238373030303030303030303030303030303030222c226c696d223a2232383730303030303030303030222c22707265223a2230227d68"

func row(sig string) []byte {
	return []byte(`\\x85359b7768ba60cde4559b6e03ef2685d27ca7be3b1fa2cda976743e17f7c3ad	0	\\xb4398af8f6831c20df726e14799b14991a3b0046045be1acd3f6477aeea1aeae	0	\\x` + sig + `	1	1719757838224	\N	\N`)
}

func TestMatchInput(t *testing.T) {
	k, n := MatchInput(row(deploySig), []byte("nacho"))
	if !k || !n {
		t.Fatalf("deploy row: kasplex=%v nacho=%v", k, n)
	}
	k, n = MatchInput(row(deploySig), []byte("zeal"))
	if !k || n {
		t.Fatalf("other tick: kasplex=%v match=%v", k, n)
	}
	k, _ = MatchInput(row("41aa01"), []byte("nacho"))
	if k {
		t.Fatal("plain signature flagged as kasplex")
	}
	if string(field(row("00"), 6)) != "1719757838224" {
		t.Fatal("field split")
	}
}

func TestIdKeyAndSet(t *testing.T) {
	id := "85359b7768ba60cde4559b6e03ef2685d27ca7be3b1fa2cda976743e17f7c3ad"
	r := row(deploySig)
	k1, ok := idKey(byteaHex(field(r, 0)))
	if !ok {
		t.Fatal("row tx id not parsed")
	}
	k2, _ := idKey([]byte(strings.ToUpper(id)))
	if k1 != k2 {
		t.Fatal("case-insensitive key mismatch")
	}
	if _, ok := idKey([]byte("abc")); ok {
		t.Fatal("short id accepted")
	}
	f := filepath.Join(t.TempDir(), "set.txt")
	os.WriteFile(f, []byte(id+"\n\n"+strings.Repeat("0", 64)+"\n"), 0o644)
	s := loadSet(f)
	if len(s) != 2 || !hasKey(s, k1) {
		t.Fatalf("loadSet: %d keys", len(s))
	}
	other, _ := idKey(byteaHex(field(row(deploySig), 2)))
	if hasKey(s, other) {
		t.Fatal("prev outpoint hash must not match")
	}
}
