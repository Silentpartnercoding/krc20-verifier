package main
import (
    "fmt"
    "os"
    "strconv"
    "strings"
    "encoding/hex"
    "encoding/json"
    "kasplex-executor/misc"
)
var eRuntime = struct{ testnet bool }{false}
var _ = strconv.Itoa
type DataScriptType struct {
    P string `json:"p"`
    Op string `json:"op"`
    From string `json:"from,omitempty"`
    To string `json:"to,omitempty"`
    Tick string `json:"tick,omitempty"`
    Max string `json:"max,omitempty"`
    Lim string `json:"lim,omitempty"`
    Pre string `json:"pre,omitempty"`
    Dec string `json:"dec,omitempty"`
    Amt string `json:"amt,omitempty"`
}
func parseScriptInput(script string) (bool, []string) {
    script = strings.ToLower(script)
    lenScript := len(script)
    if (lenScript <= 138) {
        return false, nil
    }
    // Get the next data length and position.
    _lGet := func(s string, i int) (int64, int, bool) {
        iRaw := i
        lenS := len(s)
        if lenS < (i + 2) {
            return 0, iRaw, false
        }
        f := s[i:i+2]
        i += 2
        lenD := int64(0)
        if f == "4c" {
            if lenS < (i + 2) {
                return 0, iRaw, false
            }
            f := s[i:i+2]
            i += 2
            lenD, _ = strconv.ParseInt(f, 16, 32)
        } else if f == "4d" {
            if lenS < (i + 4) {
                return 0, iRaw, false
            }
            f := s[i+2:i+4] + s[i:i+2]
            i += 4
            lenD, _ = strconv.ParseInt(f, 16, 32)
        } else {
            lenD, _ = strconv.ParseInt(f, 16, 32)
            if (lenD <0 || lenD > 75) {
                return 0, iRaw, false
            }
        }
        lenD *= 2
        return lenD, i, true
    }
    
    // Get the push number and position.
    _nGet := func(s string, i int) (int64, int, bool) {
        iRaw := i
        lenS := len(s)
        if lenS < (i + 2) {
            return 0, iRaw, false
        }
        f := s[i:i+2]
        i += 2
        num, _ := strconv.ParseInt(f, 16, 32)
        if (num < 81 || num > 96) {
            return 0, iRaw, false
        }
        num -= 80
        return num, i, true
    }
    
    // Get the last data position.
    _dGotoLast := func(s string, i int) (int, bool) {
        iRaw := i
        lenS := len(s)
        lenD := int64(0)
        r := true
        for j := 0; j < 16; j ++ {
            lenD, i, r = _lGet(s, i)
            if !r {
                return iRaw, false
            }
            if lenS < (i + int(lenD)) {
                return iRaw, false
            } else if lenS == (i + int(lenD)) {
                if lenD < 94 {
                    return iRaw, false
                }
                return i, true
            } else {
                i += int(lenD)
            }
        }
        return iRaw, false
    }
    
    // Skip to the redeem script.
    r := true
    n := 0
    flag := ""
    n, r = _dGotoLast(script, n)
    if !r {
        return false, nil
    }
    
    // Get the public key or multisig script hash
    multisig := false
    mm := int64(0)
    nn := int64(0)
    kPub := ""
    lenD := int64(0)
    mm, n, r = _nGet(script, n)
    if r {
        if (mm > 0 && mm < 16) {
            multisig = true
        } else {
            return false, nil
        }
    }
    if !multisig {
        lenD, n, r = _lGet(script, n)
        if !r {
            return false, nil
        }
        fSig := ""
        if lenScript > (n + int(lenD) + 2) {
            fSig = script[n+int(lenD):n+int(lenD)+2]
        }
        if (lenD == 64 && fSig == "ac") {
            kPub = script[n:n+64]
            n += 66
        } else if (lenD == 66 && fSig == "ab") {
            kPub = script[n:n+66]
            n += 68
        } else {
            return false, nil
        }
    } else {
        var kPubList []string
        for j := 0; j < 16; j ++ {
            lenD, n, r = _lGet(script, n)
            if !r {
                nn, n, r = _nGet(script, n)
                if (!r || len(kPubList) != int(nn)) {
                    return false, nil
                }
                kPub = misc.ConvKPubListToScriptHashMultisig(mm, kPubList, nn)
                break
            }
            if (lenD == 64 || lenD == 66) {
                kPubList = append(kPubList, script[n:n+int(lenD)])
                n += int(lenD)
            } else {
                return false, nil
            }
        }
        if lenScript < (n + 2) {
            return false, nil
        }
        flag = script[n:n+2]
        n += 2
        if (flag != "a9" && flag != "ae") {
            return false, nil
        }
    }
    if kPub == "" {
        return false, nil
    }
    // Check the protocol header.
    if lenScript < (n + 22) {
        return false, nil
    }
    flag = script[n:n+6]
    n += 6
    if flag != "006307" {
        return false, nil
    }
    flag = script[n:n+14]
    n += 14
    decoded, _ := hex.DecodeString(flag)
    header := strings.ToUpper(string(decoded[:]))
    if header != "KASPLEX" {
        return false, nil
    }
    
    // Get the next param data and position.
    _pGet := func(s string, i int) (string, int, bool) {
        iRaw := i
        lenS := len(s)
        lenP := int64(0)
        lenP, i, r = _lGet(s, i)
        if (!r || lenS < (i + int(lenP))) {
            return "", iRaw, false
        }
        if lenP == 0 {
            return "", i, true
        }
        decoded, _ = hex.DecodeString(s[i:i+int(lenP)])
        p := string(decoded[:])
        i += int(lenP)
        return p, i, true
    }
    
    // Get the param and json data.
    p0 := ""
    p1 := ""
    p2 := ""
    r = true
    for j := 0; j < 2; j ++ {
        if lenScript < (n + 2) {
            return false, nil
        }
        flag = script[n:n+2]
        n += 2
        if flag == "00" {
            p0, n, r = _pGet(script, n)
        } else if flag == "68" {
            break
        } else {
            if flag == "51" {
                p1 = "p1"
            } else if flag == "53" {
                p1 = "p3"
            } else if flag == "55" {
                p1 = "p5"
            } else if flag == "57" {
                p1 = "p7"
            } else if flag == "59" {
                p1 = "p9"
            } else if flag == "5b" {
                p1 = "p11"
            } else if flag == "5d" {
                p1 = "p13"
            } else if flag == "5f" {
                p1 = "p15"
            } else {
                return false, nil
            }
            p2, n, r = _pGet(script, n)
        }
        if !r {
            return false, nil
        }
    }
    if p0 == "" {
        return false, nil
    }
    
    // Get the from address.
    from := ""
    if multisig {
        from = misc.ConvKPubToP2sh(kPub, eRuntime.testnet)
    } else {
        from = misc.ConvKPubToAddr(kPub, eRuntime.testnet)
    }
    return true, []string{from, p0, p1, p2}
}


func ValidateTick(tick *string) (bool) {
    *tick = strings.ToUpper(*tick)
    lenTick := len(*tick)
    if (lenTick < 4 || lenTick > 6) {
        return false
    }
    for i := 0; i < lenTick; i++ {
        if ((*tick)[i] < 65 || (*tick)[i] > 90) {
            return false
        }
    }
    return true
}


// Harness: args = sigScript daaScore amountIn(found? -1 = input tx missing) amountOut out0addr
func main() {
    script := os.Args[1]
    daa, _ := strconv.ParseUint(os.Args[2], 10, 64)
    amountInArg, _ := strconv.ParseInt(os.Args[3], 10, 64)
    amountOut, _ := strconv.ParseUint(os.Args[4], 10, 64)
    out0 := os.Args[5]
    isOp, info := parseScriptInput(script)
    if !isOp || info[0] == "" { fmt.Println("DROP parseScriptInput=false"); return }
    decoded := DataScriptType{}
    if err := json.Unmarshal([]byte(info[1]), &decoded); err != nil { fmt.Println("DROP json"); return }
    decoded.From = info[0]
    if (!eRuntime.testnet && daa <= 83525600) { decoded.To = out0 }
    // ValidateP / ValidateOp (registered: KRC-20 ; deploy mint transfer)
    decoded.P = strings.ToUpper(decoded.P); decoded.Op = strings.ToLower(decoded.Op)
    if decoded.P != "KRC-20" || (decoded.Op != "mint" && decoded.Op != "deploy" && decoded.Op != "transfer") { fmt.Println("DROP P/Op"); return }
    // OpMethodMint.Validate (verbatim logic)
    if decoded.Op == "mint" {
        if (decoded.From == "" || decoded.P != "KRC-20" || !ValidateTick(&decoded.Tick)) { fmt.Println("DROP mint.Validate"); return }
        decoded.Amt = ""
        if decoded.To == "" { decoded.To = decoded.From }
    }
    feeLeast := uint64(100000000)
    // ParseOpDataList fee block (verbatim logic): missing input tx contributes 0
    amountIn := uint64(0)
    if amountInArg >= 0 { amountIn = uint64(amountInArg) }
    if amountIn <= amountOut { fmt.Printf("DROP fee: amountIn=%d <= amountOut=%d -> Fee=0 and 'continue' (op never appended, never stored)\n", amountIn, amountOut); return }
    fee := amountIn - amountOut
    verdict := "ACCEPT-path (Do: tick exists & fee>=least -> mint)"
    if fee < feeLeast { verdict = "stored as reject: fee not enough" }
    fmt.Printf("OP from=%s to=%s tick=%s fee=%d -> %s\n", decoded.From, decoded.To, decoded.Tick, fee, verdict)
    _ = hex.EncodeToString; _ = misc.ConvKPubToAddr
}
