package main

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	Version            = "4.0.0"
	EthPIP             = 0x0800
	EthPAll            = 0x0003
	IPPROTOTCP         = 6
	FIN                = 0x01
	SYN                = 0x02
	RST                = 0x04
	PSH                = 0x08
	ACK                = 0x10
	BufferSize         = 1 << 20
	FailoverThreshold  = 3
	FailoverWindow     = 30.0
	MaxConcurrentConns = 32768
	DataLogInterval    = 262144
	TCPReadBuffer      = 4 << 20
	TCPWriteBuffer     = 4 << 20
)

var bufPool = sync.Pool{
	New: func() interface{} {
		buf := make([]byte, BufferSize)
		return &buf
	},
}

var colorEnabled bool

func init() {
	runtime.GOMAXPROCS(runtime.NumCPU())
	if os.Getenv("NO_COLOR") != "" {
		colorEnabled = false
		return
	}
	if os.Getenv("FORCE_COLOR") != "" {
		colorEnabled = true
		return
	}
	fi, err := os.Stdout.Stat()
	if err == nil && (fi.Mode()&os.ModeCharDevice) != 0 {
		colorEnabled = true
	}
}

type colorizer struct{}

func (c colorizer) code(code, text string) string {
	if colorEnabled {
		return "\033[" + code + "m" + text + "\033[0m"
	}
	return text
}

var clr = colorizer{}

func green(t string) string   { return clr.code("92", t) }
func red(t string) string     { return clr.code("91", t) }
func yellow(t string) string  { return clr.code("93", t) }
func cyan(t string) string    { return clr.code("96", t) }
func blue(t string) string    { return clr.code("94", t) }
func magenta(t string) string { return clr.code("95", t) }
func bold(t string) string    { return clr.code("1", t) }
func dim(t string) string     { return clr.code("2", t) }

const (
	EvConnOpen       = "CONN_OPEN"
	EvConnClose      = "CONN_CLOSE"
	EvConnError      = "CONN_ERROR"
	EvTLSParsed      = "TLS_PARSED"
	EvTLSUnknown     = "TLS_UNKNOWN"
	EvFragStart      = "FRAG_START"
	EvFragPiece      = "FRAG_PIECE"
	EvFragDone       = "FRAG_DONE"
	EvFakeSNISend    = "FAKE_SNI_SEND"
	EvFakeSNITTL     = "FAKE_SNI_TTL"
	EvFakeSNIInject  = "FAKE_SNI_INJECT"
	EvRealHelloSend  = "REAL_HELLO_SEND"
	EvServerResponse = "SERVER_RESPONSE"
	EvDPIBlocked     = "DPI_BLOCKED"
	EvDPIBypassOK    = "DPI_BYPASS_OK"
	EvDataC2S        = "DATA_C2S"
	EvDataS2C        = "DATA_S2C"
)

type PacketEvent struct {
	Event     string
	ConnID    string
	Timestamp time.Time
	Data      map[string]interface{}
}

type ConnState struct {
	ConnID        string
	ClientAddr    string
	ServerAddr    string
	RealSNI       string
	FakeSNI       string
	Method        string
	FragCount     int
	FragSizes     []int
	BytesC2S      int64
	BytesS2C      int64
	Status        string
	StartTime     time.Time
	EndTime       time.Time
	ServerReplied bool
}

func fmtBytes(n int64) string {
	switch {
	case n < 1024:
		return fmt.Sprintf("%dB", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1fKB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.2fMB", float64(n)/1024/1024)
	}
}

func drawFragmentBar(sizes []int) {
	if len(sizes) == 0 {
		return
	}
	total := 0
	for _, s := range sizes {
		total += s
	}
	if total == 0 {
		return
	}
	barWidth := 50
	bar := ""
	labels := []string{}
	colors := []func(string) string{cyan, yellow, magenta, blue, green}
	for i, s := range sizes {
		w := s * barWidth / total
		if w < 1 {
			w = 1
		}
		cf := colors[i%len(colors)]
		bar += cf(strings.Repeat("█", w))
		labels = append(labels, fmt.Sprintf("%s=%dB", cf(fmt.Sprintf("%d", i+1)), s))
	}
	fmt.Printf("  %s%s  %s\n", dim("TLS:"), bar, strings.Join(labels, " "))
}

type MonitorState struct {
	conns     map[string]*ConnState
	connOrder []string
	maxConns  int
}

func newMonitorState(maxConns int) *MonitorState {
	return &MonitorState{
		conns:    make(map[string]*ConnState, maxConns),
		maxConns: maxConns,
	}
}

func (s *MonitorState) addConn(cid string, cs *ConnState) {
	s.conns[cid] = cs
	s.connOrder = append(s.connOrder, cid)
	for len(s.connOrder) > s.maxConns {
		oldest := s.connOrder[0]
		s.connOrder = s.connOrder[1:]
		delete(s.conns, oldest)
	}
}

type MonitorCounters struct {
	totalConns   int64
	totalBlocked int64
	totalOK      int64
	totalC2S     int64
	totalS2C     int64
}

func (c *MonitorCounters) addConn()    { atomic.AddInt64(&c.totalConns, 1) }
func (c *MonitorCounters) addOK()     { atomic.AddInt64(&c.totalOK, 1) }
func (c *MonitorCounters) addBlocked() { atomic.AddInt64(&c.totalBlocked, 1) }
func (c *MonitorCounters) addC2S(n int64) { atomic.AddInt64(&c.totalC2S, n) }
func (c *MonitorCounters) addS2C(n int64) { atomic.AddInt64(&c.totalS2C, n) }

type PacketMonitor struct {
	mu       sync.RWMutex
	state    *MonitorState
	counters MonitorCounters
	quiet    bool
	start    time.Time
}

func NewPacketMonitor(maxConns int, quiet bool) *PacketMonitor {
	return &PacketMonitor{
		state: newMonitorState(maxConns),
		quiet: quiet,
		start: time.Now(),
	}
}

func (m *PacketMonitor) Emit(ev PacketEvent) {
	m.mu.Lock()
	m.apply(ev)
	m.mu.Unlock()
	if !m.quiet {
		m.printEvent(ev)
	}
}

func (m *PacketMonitor) apply(ev PacketEvent) {
	cid := ev.ConnID
	cs := m.state.conns[cid]

	switch ev.Event {
	case EvConnOpen:
		m.counters.addConn()
		cs = &ConnState{
			ConnID:     cid,
			ClientAddr: strVal(ev.Data, "client"),
			ServerAddr: strVal(ev.Data, "server"),
			FakeSNI:    strVal(ev.Data, "fake_sni"),
			Method:     strVal(ev.Data, "method"),
			Status:     "connecting",
			StartTime:  time.Now(),
		}
		m.state.addConn(cid, cs)
		return
	}

	if cs == nil {
		return
	}

	switch ev.Event {
	case EvTLSParsed:
		cs.RealSNI = strVal(ev.Data, "sni")
	case EvFragStart:
		if v, ok := ev.Data["count"]; ok {
			cs.FragCount = toInt(v)
		}
		if v, ok := ev.Data["sizes"]; ok {
			cs.FragSizes = toIntSlice(v)
		}
	case EvServerResponse:
		cs.ServerReplied = true
		cs.Status = "active"
		m.counters.addOK()
	case EvDPIBlocked:
		cs.Status = "blocked"
		m.counters.addBlocked()
	case EvDPIBypassOK:
		cs.Status = "active"
	case EvDataC2S:
		n := int64(toInt(ev.Data["bytes"]))
		atomic.AddInt64(&cs.BytesC2S, n)
		m.counters.addC2S(n)
	case EvDataS2C:
		n := int64(toInt(ev.Data["bytes"]))
		atomic.AddInt64(&cs.BytesS2C, n)
		m.counters.addS2C(n)
	case EvConnClose:
		cs.Status = "closed"
		cs.EndTime = time.Now()
	case EvConnError:
		cs.Status = "error"
		cs.EndTime = time.Now()
	}
}

func (m *PacketMonitor) printEvent(ev PacketEvent) {
	cid := ev.ConnID
	if len(cid) > 8 {
		cid = cid[:8]
	}
	ts := time.Now().Format("15:04:05")

	m.mu.RLock()
	cs := m.state.conns[ev.ConnID]
	m.mu.RUnlock()

	tag := func(label string, cf func(string) string) string {
		return cf("[" + label + "]")
	}

	switch ev.Event {
	case EvConnOpen:
		fmt.Printf("%s %s  %s │ %s → %s │ method=%s\n",
			dim(ts), tag("NEW CONN", cyan), bold(cid),
			strVal(ev.Data, "client"), strVal(ev.Data, "server"),
			yellow(strVal(ev.Data, "method")))
	case EvTLSParsed:
		fmt.Printf("%s %s  %s │ real SNI=%s │ size=%dB\n",
			dim(ts), tag("TLS HELLO", blue), bold(cid),
			cyan(strVal(ev.Data, "sni")), toInt(ev.Data["size"]))
	case EvTLSUnknown:
		fmt.Printf("%s %s  %s │ %dB (not TLS ClientHello)\n",
			dim(ts), dim("[RAW DATA ]"), bold(cid), toInt(ev.Data["size"]))
	case EvFragStart:
		count := toInt(ev.Data["count"])
		sizes := toIntSlice(ev.Data["sizes"])
		strat := strVal(ev.Data, "strategy")
		parts := []string{}
		for _, s := range sizes {
			parts = append(parts, fmt.Sprintf("%dB", s))
		}
		fmt.Printf("%s %s  %s │ strategy=%s │ %d pieces: %s\n",
			dim(ts), tag("FRAGMENT ", yellow), bold(cid),
			yellow(strat), count, strings.Join(parts, " + "))
		drawFragmentBar(sizes)
	case EvFragPiece:
		idx := toInt(ev.Data["index"]) + 1
		total := toInt(ev.Data["total"])
		size := toInt(ev.Data["size"])
		delay := toFloat(ev.Data["delay"])
		delayStr := ""
		if delay > 0 {
			delayStr = fmt.Sprintf(" delay=%.0fms", delay*1000)
		}
		sent := ""
		if b, ok := ev.Data["sent"].(bool); ok && b {
			sent = green("✓ sent")
		} else {
			sent = red("✗ failed")
		}
		fmt.Printf("%s %s  %s │ %dB %s%s\n",
			dim(ts), tag(fmt.Sprintf("PKT %d/%d", idx, total), magenta),
			bold(cid), size, sent, dim(delayStr))
	case EvFakeSNISend:
		fmt.Printf("%s %s  %s │ fake=%s │ method=%s\n",
			dim(ts), tag("FAKE SNI ", magenta), bold(cid),
			yellow(strVal(ev.Data, "sni")), strVal(ev.Data, "method"))
	case EvFakeSNITTL:
		fmt.Printf("%s %s  %s │ fake SNI with TTL=%s │ dies before server %s\n",
			dim(ts), tag("TTL TRICK", magenta), bold(cid),
			yellow(fmt.Sprintf("%v", ev.Data["ttl"])),
			dim("(DPI sees it, server drops it)"))
	case EvFakeSNIInject:
		fmt.Printf("%s %s  %s │ out-of-window seq=%s │ server drops fake, DPI fooled\n",
			dim(ts), tag("RAW INJECT", magenta), bold(cid),
			yellow(fmt.Sprintf("%v", ev.Data["seq"])))
	case EvRealHelloSend:
		fmt.Printf("%s %s  %s │ %dB → server\n",
			dim(ts), tag("REAL HELLO", blue), bold(cid), toInt(ev.Data["size"]))
	case EvServerResponse:
		fmt.Printf("%s %s  %s │ %s │ %dB │ %s\n",
			dim(ts), tag("SVR RESP ", green), bold(cid),
			green("✓ SERVER REPLIED"), toInt(ev.Data["size"]),
			green("SNI SPOOF ACTIVE ✓"))
	case EvDPIBlocked:
		reason := strVal(ev.Data, "reason")
		if reason == "" {
			reason = "no response"
		}
		fmt.Printf("%s %s  %s │ %s │ %s\n",
			dim(ts), tag("BLOCKED  ", red), bold(cid),
			red("✗ DPI BLOCKED"), reason)
	case EvDPIBypassOK:
		fmt.Printf("%s %s  %s │ %s\n",
			dim(ts), tag("BYPASS OK", green), bold(cid),
			green("✓ SNI spoof confirmed — bypass active"))
	case EvDataC2S:
		n := int64(toInt(ev.Data["bytes"]))
		if n > 0 {
			fmt.Printf("%s %s  %s │ %s\n",
				dim(ts), dim("[→ C→S   ]"), bold(cid), fmtBytes(n))
		}
	case EvDataS2C:
		n := int64(toInt(ev.Data["bytes"]))
		if n > 0 {
			fmt.Printf("%s %s  %s │ %s\n",
				dim(ts), dim("[← S→C   ]"), bold(cid), green(fmtBytes(n)))
		}
	case EvConnClose:
		dur := ""
		if cs != nil {
			d := time.Since(cs.StartTime)
			dur = fmt.Sprintf(" │ duration=%.1fs │ ↑%s ↓%s",
				d.Seconds(), fmtBytes(cs.BytesC2S), fmtBytes(cs.BytesS2C))
			if cs.ServerReplied {
				dur += " │ " + green("SNI spoof: OK")
			} else {
				dur += " │ " + red("SNI spoof: no response")
			}
		}
		fmt.Printf("%s %s  %s%s\n",
			dim(ts), dim("[CLOSED  ]"), bold(cid), dim(dur))
	case EvConnError:
		fmt.Printf("%s %s  %s │ %s\n",
			dim(ts), tag("ERROR    ", red), bold(cid),
			red(strVal(ev.Data, "error")))
	}
}

func (m *PacketMonitor) PrintStats() {
	uptime := time.Since(m.start).Seconds()
	m.mu.RLock()
	active := 0
	for _, c := range m.state.conns {
		if c.Status == "connecting" || c.Status == "active" {
			active++
		}
	}
	m.mu.RUnlock()

	ok := atomic.LoadInt64(&m.counters.totalOK)
	blocked := atomic.LoadInt64(&m.counters.totalBlocked)
	total := ok + blocked
	spoofRate := 0
	if total > 0 {
		spoofRate = int(ok * 100 / total)
	}

	fmt.Printf("\n%s\n", bold(strings.Repeat("═", 66)))
	fmt.Printf("  %s  v%s  │  uptime=%.0fs  │  CPUs=%d\n",
		bold("Session Stats"), Version, uptime, runtime.NumCPU())
	fmt.Printf("%s\n", strings.Repeat("─", 66))
	fmt.Printf("  %-20s total=%-6s  active=%-6s  blocked=%-6s  ok=%s\n",
		"connections",
		cyan(fmt.Sprintf("%d", atomic.LoadInt64(&m.counters.totalConns))),
		green(fmt.Sprintf("%d", active)),
		red(fmt.Sprintf("%d", blocked)),
		green(fmt.Sprintf("%d", ok)))
	fmt.Printf("  %-20s %s success rate\n", "SNI spoof", green(fmt.Sprintf("%d%%", spoofRate)))
	fmt.Printf("  %-20s ↑%s  ↓%s\n", "traffic",
		fmtBytes(atomic.LoadInt64(&m.counters.totalC2S)),
		fmtBytes(atomic.LoadInt64(&m.counters.totalS2C)))
	fmt.Printf("%s\n", bold(strings.Repeat("═", 66)))
}

var (
	globalMonitor *PacketMonitor
	monitorMu     sync.Mutex
)

func GetMonitor() *PacketMonitor {
	monitorMu.Lock()
	defer monitorMu.Unlock()
	return globalMonitor
}

func InitMonitor(quiet bool) *PacketMonitor {
	monitorMu.Lock()
	defer monitorMu.Unlock()
	globalMonitor = NewPacketMonitor(50, quiet)
	return globalMonitor
}

var (
	cipherSuites, _ = hex.DecodeString(
		"0024" +
			"1302" + "1303" + "1301" + "c02c" + "c030" + "c02b" + "c02f" +
			"cca9" + "cca8" + "c024" + "c028" + "c023" + "c027" +
			"009f" + "009e" + "006b" + "0067" + "00ff")
	supportedGroups, _ = hex.DecodeString(
		"000a" + "0016" + "0014" +
			"001d" + "0017" + "001e" + "0019" + "0018" +
			"0100" + "0101" + "0102" + "0103" + "0104")
	signatureAlgorithms, _ = hex.DecodeString(
		"000d" + "002a" + "0028" +
			"0403" + "0503" + "0603" + "0807" + "0808" + "0809" + "080a" + "080b" +
			"0804" + "0805" + "0806" + "0401" + "0501" + "0601" +
			"0303" + "0301" + "0302" + "0402" + "0502" + "0602")
	ecPointFormats, _       = hex.DecodeString("000b" + "0004" + "0300" + "0102")
	sessionTicket, _        = hex.DecodeString("0023" + "0000")
	alpn, _                 = hex.DecodeString("0010" + "000e" + "000c" + "0268" + "3208" + "6874" + "7470" + "2f31" + "2e31")
	encryptThenMAC, _       = hex.DecodeString("0016" + "0000")
	extendedMasterSecret, _ = hex.DecodeString("0017" + "0000")
	supportedVersions, _    = hex.DecodeString("002b" + "0005" + "04" + "0304" + "0303")
	pskKeyExchange, _       = hex.DecodeString("002d" + "0002" + "0101")
)

type TLSExtensionBuilder struct{}

func (TLSExtensionBuilder) buildSNI(sni string) []byte {
	sniBytes := []byte(sni)
	entry := make([]byte, 3+len(sniBytes))
	entry[0] = 0
	binary.BigEndian.PutUint16(entry[1:], uint16(len(sniBytes)))
	copy(entry[3:], sniBytes)
	nameList := make([]byte, 2+len(entry))
	binary.BigEndian.PutUint16(nameList, uint16(len(entry)))
	copy(nameList[2:], entry)
	result := make([]byte, 4+len(nameList))
	binary.BigEndian.PutUint16(result, 0x0000)
	binary.BigEndian.PutUint16(result[2:], uint16(len(nameList)))
	copy(result[4:], nameList)
	return result
}

func (TLSExtensionBuilder) buildKeyShare(publicKey []byte) []byte {
	if publicKey == nil {
		publicKey = make([]byte, 32)
		rand.Read(publicKey)
	}
	entry := make([]byte, 4+len(publicKey))
	binary.BigEndian.PutUint16(entry, 0x001D)
	binary.BigEndian.PutUint16(entry[2:], 32)
	copy(entry[4:], publicKey)
	data := make([]byte, 2+len(entry))
	binary.BigEndian.PutUint16(data, uint16(len(entry)))
	copy(data[2:], entry)
	result := make([]byte, 4+len(data))
	binary.BigEndian.PutUint16(result, 0x0033)
	binary.BigEndian.PutUint16(result[2:], uint16(len(data)))
	copy(result[4:], data)
	return result
}

func (TLSExtensionBuilder) buildPadding(targetLength, currentLength int) []byte {
	paddingNeeded := targetLength - currentLength - 4
	if paddingNeeded < 0 {
		return nil
	}
	result := make([]byte, 4+paddingNeeded)
	binary.BigEndian.PutUint16(result, 0x0015)
	binary.BigEndian.PutUint16(result[2:], uint16(paddingNeeded))
	return result
}

type ClientHelloBuilder struct {
	ext TLSExtensionBuilder
}

func (b ClientHelloBuilder) BuildSNIExtension(sni string) []byte {
	return b.ext.buildSNI(sni)
}

func (b ClientHelloBuilder) BuildKeyShareExtension(publicKey []byte) []byte {
	return b.ext.buildKeyShare(publicKey)
}

func (b ClientHelloBuilder) BuildPaddingExtension(targetLength, currentLength int) []byte {
	return b.ext.buildPadding(targetLength, currentLength)
}

func (b ClientHelloBuilder) BuildClientHello(sni string, sessionID, randomBytes, keyShare []byte, targetSize int) []byte {
	if sessionID == nil {
		sessionID = make([]byte, 32)
		rand.Read(sessionID)
	}
	if randomBytes == nil {
		randomBytes = make([]byte, 32)
		rand.Read(randomBytes)
	}
	if targetSize == 0 {
		targetSize = 517
	}

	clientVersion := []byte{0x03, 0x03}
	sessionIDField := append([]byte{byte(len(sessionID))}, sessionID...)
	compression := []byte{0x01, 0x00}
	sniExt := b.BuildSNIExtension(sni)
	keyShareExt := b.BuildKeyShareExtension(keyShare)

	extensions := concat(sniExt, ecPointFormats, supportedGroups,
		sessionTicket, alpn, encryptThenMAC,
		extendedMasterSecret, signatureAlgorithms,
		supportedVersions, pskKeyExchange, keyShareExt)

	handshakeBodyNoPad := concat(clientVersion, randomBytes, sessionIDField, cipherSuites, compression)
	totalSoFar := 4 + len(handshakeBodyNoPad) + 2 + len(extensions)
	recordSoFar := 5 + totalSoFar
	paddingExt := b.BuildPaddingExtension(targetSize, recordSoFar)
	if paddingExt != nil {
		extensions = concat(extensions, paddingExt)
	}

	extWithLen := make([]byte, 2+len(extensions))
	binary.BigEndian.PutUint16(extWithLen, uint16(len(extensions)))
	copy(extWithLen[2:], extensions)

	handshakeBody := concat(handshakeBodyNoPad, extWithLen)

	hsLen := len(handshakeBody)
	handshake := make([]byte, 4+hsLen)
	handshake[0] = 0x01
	handshake[1] = byte(hsLen >> 16)
	handshake[2] = byte(hsLen >> 8)
	handshake[3] = byte(hsLen)
	copy(handshake[4:], handshakeBody)

	record := make([]byte, 5+len(handshake))
	record[0] = 0x16
	record[1] = 0x03
	record[2] = 0x01
	binary.BigEndian.PutUint16(record[3:], uint16(len(handshake)))
	copy(record[5:], handshake)
	return record
}

func (b ClientHelloBuilder) ParseClientHello(data []byte) map[string]interface{} {
	result := make(map[string]interface{})
	if len(data) < 5 {
		return result
	}
	contentType := data[0]
	tlsVersion := binary.BigEndian.Uint16(data[1:3])
	result["content_type"] = contentType
	result["tls_version"] = fmt.Sprintf("0x%04x", tlsVersion)
	if contentType != 0x16 {
		return result
	}
	pos := 5
	if pos+4 > len(data) {
		return result
	}
	hsType := data[pos]
	hsLen := int(data[pos+1])<<16 | int(data[pos+2])<<8 | int(data[pos+3])
	pos += 4
	if hsType != 0x01 || hsLen == 0 {
		return result
	}
	result["handshake_type"] = "ClientHello"
	pos += 2
	if pos+32 > len(data) {
		return result
	}
	result["random"] = hex.EncodeToString(data[pos : pos+32])
	pos += 32
	if pos >= len(data) {
		return result
	}
	sessLen := int(data[pos])
	pos += 1 + sessLen
	if pos+2 > len(data) {
		return result
	}
	csLen := int(binary.BigEndian.Uint16(data[pos:]))
	pos += 2 + csLen
	if pos >= len(data) {
		return result
	}
	compLen := int(data[pos])
	pos += 1 + compLen
	if pos+2 > len(data) {
		return result
	}
	extLen := int(binary.BigEndian.Uint16(data[pos:]))
	pos += 2
	extEnd := pos + extLen
	for pos+4 <= extEnd && pos+4 <= len(data) {
		extType := binary.BigEndian.Uint16(data[pos:])
		extDataLen := int(binary.BigEndian.Uint16(data[pos+2:]))
		if pos+4+extDataLen > len(data) {
			break
		}
		extData := data[pos+4 : pos+4+extDataLen]
		pos += 4 + extDataLen
		if extType == 0x0000 && len(extData) >= 5 {
			nameLen := int(binary.BigEndian.Uint16(extData[3:5]))
			if 5+nameLen <= len(extData) {
				result["sni"] = string(extData[5 : 5+nameLen])
			}
		}
	}
	return result
}

type FragmentEngine struct{}

func (FragmentEngine) Fragment(data []byte, strategy string) [][]byte {
	if strategy == "none" || len(data) < 10 {
		return [][]byte{data}
	}
	switch strategy {
	case "sni_split":
		return FragmentEngine{}.atSNI(data)
	case "half":
		mid := len(data) / 2
		return [][]byte{data[:mid], data[mid:]}
	case "multi":
		return FragmentEngine{}.multi(data, 24)
	case "tls_record_frag":
		return FragmentEngine{}.tlsRecord(data)
	}
	return [][]byte{data}
}

func (FragmentEngine) findSNIOffset(data []byte) (int, int) {
	for pos := 0; pos < len(data)-10; pos++ {
		if data[pos] == 0x00 && data[pos+1] == 0x00 {
			if pos+9 >= len(data) {
				continue
			}
			extLen := int(binary.BigEndian.Uint16(data[pos+2:]))
			if extLen <= 4 || extLen >= 256 {
				continue
			}
			if pos+4+extLen > len(data) {
				continue
			}
			_ = int(binary.BigEndian.Uint16(data[pos+4:]))
			nameType := data[pos+6]
			nameLen := int(binary.BigEndian.Uint16(data[pos+7:]))
			if nameType == 0 && nameLen > 0 && nameLen < 256 {
				sniStart := pos + 9
				if sniStart+nameLen > len(data) {
					continue
				}
				sniData := data[sniStart : sniStart+nameLen]
				allPrintable := true
				for _, b := range sniData {
					if b < 0x20 || b >= 0x7F {
						allPrintable = false
						break
					}
				}
				if allPrintable {
					return sniStart, nameLen
				}
			}
		}
	}
	return -1, 0
}

func (e FragmentEngine) atSNI(data []byte) [][]byte {
	sniOffset, sniLen := e.findSNIOffset(data)
	if sniOffset < 0 {
		mid := len(data) / 2
		return [][]byte{data[:mid], data[mid:]}
	}
	splitPoint := sniOffset + sniLen/2
	return [][]byte{data[:splitPoint], data[splitPoint:]}
}

func (FragmentEngine) multi(data []byte, chunkSize int) [][]byte {
	var result [][]byte
	for i := 0; i < len(data); i += chunkSize {
		end := i + chunkSize
		if end > len(data) {
			end = len(data)
		}
		result = append(result, data[i:end])
	}
	return result
}

func (FragmentEngine) tlsRecord(data []byte) [][]byte {
	if len(data) < 6 || data[0] != 0x16 {
		return [][]byte{data}
	}
	recordVersion := data[1:3]
	handshakeData := data[5:]
	mid := len(handshakeData) / 2
	part1 := handshakeData[:mid]
	part2 := handshakeData[mid:]
	record1 := make([]byte, 5+len(part1))
	record1[0] = 0x16
	copy(record1[1:], recordVersion)
	binary.BigEndian.PutUint16(record1[3:], uint16(len(part1)))
	copy(record1[5:], part1)
	record2 := make([]byte, 5+len(part2))
	record2[0] = 0x16
	copy(record2[1:], recordVersion)
	binary.BigEndian.PutUint16(record2[3:], uint16(len(part2)))
	copy(record2[5:], part2)
	return [][]byte{record1, record2}
}

func fragmentClientHello(data []byte, strategy string) [][]byte {
	return FragmentEngine{}.Fragment(data, strategy)
}

type BypassStrategy interface {
	Name() string
	Apply(clientConn, serverConn net.Conn, fakeSNI string, firstData []byte) bool
}

type FragmentBypass struct {
	strategy      string
	fragmentDelay float64
	tcpNoDelay    bool
	engine        FragmentEngine
}

func NewFragmentBypass(strategy string, fragmentDelay float64, tcpNoDelay bool) *FragmentBypass {
	return &FragmentBypass{
		strategy:      strategy,
		fragmentDelay: fragmentDelay,
		tcpNoDelay:    tcpNoDelay,
	}
}

func (f *FragmentBypass) Name() string { return "fragment" }

func (f *FragmentBypass) Apply(clientConn, serverConn net.Conn, fakeSNI string, firstData []byte) bool {
	tc, ok := serverConn.(*net.TCPConn)
	if ok && f.tcpNoDelay {
		tc.SetNoDelay(true)
	}
	fragments := f.engine.Fragment(firstData, f.strategy)
	for i, frag := range fragments {
		_, err := serverConn.Write(frag)
		if err != nil {
			return false
		}
		if i < len(fragments)-1 && f.fragmentDelay > 0 {
			time.Sleep(time.Duration(f.fragmentDelay * float64(time.Second)))
		}
	}
	if ok && f.tcpNoDelay {
		tc.SetNoDelay(false)
	}
	return true
}

type FakeSNIBypass struct {
	method           string
	useTTLTrick      bool
	fragmentReal     bool
	fragmentStrategy string
	engine           FragmentEngine
	builder          ClientHelloBuilder
}

func NewFakeSNIBypass(method string, useTTLTrick, fragmentReal bool, fragmentStrategy string) *FakeSNIBypass {
	return &FakeSNIBypass{
		method:           method,
		useTTLTrick:      useTTLTrick,
		fragmentReal:     fragmentReal,
		fragmentStrategy: fragmentStrategy,
	}
}

func (f *FakeSNIBypass) Name() string { return "fake_sni" }

func (f *FakeSNIBypass) Apply(clientConn, serverConn net.Conn, fakeSNI string, firstData []byte) bool {
	if f.useTTLTrick {
		return f.ttlTrickAndFragment(serverConn, fakeSNI, firstData)
	}
	return f.fragmentFallback(serverConn, firstData)
}

func (f *FakeSNIBypass) sendFakeHello(remoteAddr, fakeSNI string) {
	fakeHello := f.builder.BuildClientHello(fakeSNI, nil, nil, nil, 517)
	for i := 0; i < 3; i++ {
		probe, err := net.DialTimeout("tcp", remoteAddr, 300*time.Millisecond)
		if err == nil {
			probe.Write(fakeHello)
			probe.Close()
			break
		}
	}
}

func (f *FakeSNIBypass) ttlTrickAndFragment(serverConn net.Conn, fakeSNI string, firstData []byte) bool {
	tc, ok := serverConn.(*net.TCPConn)
	if ok {
		tc.SetNoDelay(true)
	}
	f.sendFakeHello(serverConn.RemoteAddr().String(), fakeSNI)
	time.Sleep(50 * time.Millisecond)
	fragments := f.engine.Fragment(firstData, "sni_split")
	for i, frag := range fragments {
		_, err := serverConn.Write(frag)
		if err != nil {
			return false
		}
		if i < len(fragments)-1 {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if ok {
		tc.SetNoDelay(false)
	}
	return true
}

func (f *FakeSNIBypass) fragmentFallback(serverConn net.Conn, firstData []byte) bool {
	tc, ok := serverConn.(*net.TCPConn)
	if ok {
		tc.SetNoDelay(true)
	}
	fragments := f.engine.Fragment(firstData, "sni_split")
	for i, frag := range fragments {
		_, err := serverConn.Write(frag)
		if err != nil {
			return false
		}
		if i < len(fragments)-1 {
			time.Sleep(100 * time.Millisecond)
		}
	}
	if ok {
		tc.SetNoDelay(false)
	}
	return true
}

type CombinedBypass struct {
	fragmentStrategy string
	useTTLTrick      bool
	fragmentDelay    float64
	fakeFirst        bool
	engine           FragmentEngine
	builder          ClientHelloBuilder
}

func NewCombinedBypass(fragmentStrategy string, useTTLTrick bool, fragmentDelay float64, fakeFirst bool) *CombinedBypass {
	return &CombinedBypass{
		fragmentStrategy: fragmentStrategy,
		useTTLTrick:      useTTLTrick,
		fragmentDelay:    fragmentDelay,
		fakeFirst:        fakeFirst,
	}
}

func (cb *CombinedBypass) Name() string { return "combined" }

func (cb *CombinedBypass) Apply(clientConn, serverConn net.Conn, fakeSNI string, firstData []byte) bool {
	tc, ok := serverConn.(*net.TCPConn)
	if ok {
		tc.SetNoDelay(true)
	}
	if cb.fakeFirst && cb.useTTLTrick {
		remoteAddr := serverConn.RemoteAddr().String()
		fakeHello := cb.builder.BuildClientHello(fakeSNI, nil, nil, nil, 517)
		for i := 0; i < 3; i++ {
			probe, err := net.DialTimeout("tcp", remoteAddr, 300*time.Millisecond)
			if err == nil {
				probe.Write(fakeHello)
				probe.Close()
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	fragments := cb.engine.Fragment(firstData, cb.fragmentStrategy)
	for i, frag := range fragments {
		_, err := serverConn.Write(frag)
		if err != nil {
			return false
		}
		if i < len(fragments)-1 && cb.fragmentDelay > 0 {
			time.Sleep(time.Duration(cb.fragmentDelay * float64(time.Second)))
		}
	}
	if ok {
		tc.SetNoDelay(false)
	}
	return true
}

type FailRecord struct {
	times []time.Time
}

func (r *FailRecord) prune(cutoff time.Time) {
	filtered := r.times[:0]
	for _, t := range r.times {
		if t.After(cutoff) {
			filtered = append(filtered, t)
		}
	}
	r.times = filtered
}

type ConnectionTracker struct {
	mu       sync.Mutex
	failures map[string]*FailRecord
	success  map[string]int
}

func NewConnectionTracker() *ConnectionTracker {
	return &ConnectionTracker{
		failures: make(map[string]*FailRecord),
		success:  make(map[string]int),
	}
}

func (ct *ConnectionTracker) RecordFailure(ip string) int {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-FailoverWindow * time.Second)
	if ct.failures[ip] == nil {
		ct.failures[ip] = &FailRecord{}
	}
	r := ct.failures[ip]
	r.times = append(r.times, now)
	r.prune(cutoff)
	return len(r.times)
}

func (ct *ConnectionTracker) RecordSuccess(ip string) {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	delete(ct.failures, ip)
	ct.success[ip]++
}

func (ct *ConnectionTracker) ShouldFailover(ip string) bool {
	ct.mu.Lock()
	defer ct.mu.Unlock()
	r := ct.failures[ip]
	if r == nil {
		return false
	}
	return len(r.times) >= FailoverThreshold
}

var (
	connTracker = NewConnectionTracker()
	connCounter int64
)

func newConnID() string {
	n := atomic.AddInt64(&connCounter, 1)
	return fmt.Sprintf("C%06d", n)
}

type PipeWorker struct {
	src       net.Conn
	dst       net.Conn
	connID    string
	mon       *PacketMonitor
	evType    string
	acc       *int64
	onFirst   func()
	closeOther net.Conn
}

func (pw *PipeWorker) run(wg *sync.WaitGroup) {
	defer wg.Done()
	bufPtr := bufPool.Get().(*[]byte)
	buf := *bufPtr
	defer bufPool.Put(bufPtr)
	first := true
	for {
		nr, err := pw.src.Read(buf)
		if nr > 0 {
			if _, wErr := pw.dst.Write(buf[:nr]); wErr != nil {
				break
			}
			if first && pw.onFirst != nil {
				pw.onFirst()
				first = false
			}
			if pw.mon != nil && pw.acc != nil {
				n64 := int64(nr)
				prev := atomic.AddInt64(pw.acc, n64) - n64
				if prev/DataLogInterval != (prev+n64)/DataLogInterval {
					pw.mon.Emit(PacketEvent{Event: pw.evType, ConnID: pw.connID, Data: map[string]interface{}{"bytes": nr}})
				}
			}
		}
		if err != nil {
			break
		}
	}
	pw.closeOther.Close()
}

type ProxyServer struct {
	listenHost  string
	listenPort  int
	connectIP   string
	connectPort string
	fakeSNI     string
	strategy    BypassStrategy
	interfaceIP string
	semaphore   chan struct{}
	logger      *log.Logger
	dialer      *net.Dialer
	builder     ClientHelloBuilder
}

func NewProxyServer(listenHost string, listenPort int, connectIP string, connectPort int,
	fakeSNI string, strategy BypassStrategy, interfaceIP string) *ProxyServer {

	d := &net.Dialer{
		Timeout:   15 * time.Second,
		KeepAlive: 30 * time.Second,
	}
	if interfaceIP != "" {
		d.LocalAddr = &net.TCPAddr{IP: net.ParseIP(interfaceIP)}
	}

	return &ProxyServer{
		listenHost:  listenHost,
		listenPort:  listenPort,
		connectIP:   connectIP,
		connectPort: fmt.Sprintf("%s:%d", connectIP, connectPort),
		fakeSNI:     fakeSNI,
		strategy:    strategy,
		interfaceIP: interfaceIP,
		semaphore:   make(chan struct{}, MaxConcurrentConns),
		logger:      log.New(os.Stdout, "", 0),
		dialer:      d,
	}
}

func (ps *ProxyServer) Start() error {
	addr := fmt.Sprintf("%s:%d", ps.listenHost, ps.listenPort)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	defer ln.Close()
	printRunningBanner(ps.listenHost, ps.listenPort, ps.connectIP,
		func() int {
			var p int
			fmt.Sscanf(ps.connectPort[strings.LastIndex(ps.connectPort, ":")+1:], "%d", &p)
			return p
		}(),
		ps.fakeSNI, ps.strategy.Name())

	for {
		conn, err := ln.Accept()
		if err != nil {
			continue
		}
		if tc, ok := conn.(*net.TCPConn); ok {
			tc.SetReadBuffer(TCPReadBuffer)
			tc.SetWriteBuffer(TCPWriteBuffer)
			tc.SetNoDelay(true)
		}
		ps.semaphore <- struct{}{}
		go func(c net.Conn) {
			defer func() { <-ps.semaphore }()
			ps.handleConnection(c)
		}(conn)
	}
}

func (ps *ProxyServer) handleConnection(incoming net.Conn) {
	mon := GetMonitor()
	connID := newConnID()
	clientStr := incoming.RemoteAddr().String()
	serverStr := ps.connectPort

	if mon != nil {
		mon.Emit(PacketEvent{Event: EvConnOpen, ConnID: connID, Data: map[string]interface{}{
			"client":   clientStr,
			"server":   serverStr,
			"fake_sni": ps.fakeSNI,
			"method":   ps.strategy.Name(),
		}})
	}

	defer func() {
		incoming.Close()
		if mon != nil {
			mon.Emit(PacketEvent{Event: EvConnClose, ConnID: connID})
		}
	}()

	incoming.SetDeadline(time.Now().Add(30 * time.Second))
	bufPtr := bufPool.Get().(*[]byte)
	buf := *bufPtr
	n, err := incoming.Read(buf)
	if err != nil || n == 0 {
		bufPool.Put(bufPtr)
		return
	}
	firstData := make([]byte, n)
	copy(firstData, buf[:n])
	bufPool.Put(bufPtr)
	incoming.SetDeadline(time.Time{})

	parsed := ps.builder.ParseClientHello(firstData)
	clientSNI := ""
	if s, ok := parsed["sni"].(string); ok {
		clientSNI = s
	}

	if mon != nil {
		if parsed["handshake_type"] == "ClientHello" {
			mon.Emit(PacketEvent{Event: EvTLSParsed, ConnID: connID, Data: map[string]interface{}{
				"sni": clientSNI, "size": n,
			}})
		} else {
			mon.Emit(PacketEvent{Event: EvTLSUnknown, ConnID: connID, Data: map[string]interface{}{
				"size": n,
			}})
		}
	}

	if mon != nil && !mon.quiet {
		ps.logger.Printf("[%s] %s → %s | SNI=%s | Fake=%s | %s",
			connID, clientStr, serverStr, clientSNI, ps.fakeSNI, ps.strategy.Name())
	}

	outgoing, err := ps.dialer.Dial("tcp", serverStr)
	if err != nil {
		connTracker.RecordFailure(ps.connectIP)
		if mon != nil {
			mon.Emit(PacketEvent{Event: EvConnError, ConnID: connID, Data: map[string]interface{}{
				"error": err.Error(),
			}})
		}
		return
	}
	defer outgoing.Close()

	if tc, ok := outgoing.(*net.TCPConn); ok {
		tc.SetReadBuffer(TCPReadBuffer)
		tc.SetWriteBuffer(TCPWriteBuffer)
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
		tc.SetNoDelay(true)
	}

	success := ps.applyStrategyInstrumented(incoming, outgoing, firstData, connID, mon)
	if !success {
		if mon != nil && !mon.quiet {
			ps.logger.Printf("[%s] strategy '%s' failed, sending raw", connID, ps.strategy.Name())
		}
		outgoing.Write(firstData)
	}

	var (
		serverResponded int32
		c2sAcc          int64
		s2cAcc          int64
		wg              sync.WaitGroup
	)

	wg.Add(2)

	c2sWorker := &PipeWorker{
		src:        incoming,
		dst:        outgoing,
		connID:     connID,
		mon:        mon,
		evType:     EvDataC2S,
		acc:        &c2sAcc,
		closeOther: outgoing,
	}
	s2cWorker := &PipeWorker{
		src:        outgoing,
		dst:        incoming,
		connID:     connID,
		mon:        mon,
		evType:     EvDataS2C,
		acc:        &s2cAcc,
		closeOther: incoming,
		onFirst: func() {
			if atomic.CompareAndSwapInt32(&serverResponded, 0, 1) {
				connTracker.RecordSuccess(ps.connectIP)
				if mon != nil {
					mon.Emit(PacketEvent{Event: EvServerResponse, ConnID: connID, Data: map[string]interface{}{"size": 0}})
				}
			}
		},
	}

	go c2sWorker.run(&wg)
	go s2cWorker.run(&wg)

	wg.Wait()

	if atomic.LoadInt32(&serverResponded) == 0 {
		connTracker.RecordFailure(ps.connectIP)
		if mon != nil {
			mon.Emit(PacketEvent{Event: EvDPIBlocked, ConnID: connID, Data: map[string]interface{}{
				"reason": "server never responded",
			}})
		}
	}
}

func (ps *ProxyServer) applyStrategyInstrumented(
	clientConn, serverConn net.Conn,
	firstData []byte,
	connID string,
	mon *PacketMonitor,
) bool {
	name := ps.strategy.Name()
	switch name {
	case "fragment":
		fs := ps.strategy.(*FragmentBypass)
		fragments := fs.engine.Fragment(firstData, fs.strategy)
		if mon != nil {
			sizes := make([]int, len(fragments))
			for i, f := range fragments {
				sizes[i] = len(f)
			}
			mon.Emit(PacketEvent{Event: EvFragStart, ConnID: connID, Data: map[string]interface{}{
				"count": len(fragments), "sizes": sizes, "strategy": fs.strategy,
			}})
		}
		if tc, ok := serverConn.(*net.TCPConn); ok {
			tc.SetNoDelay(true)
		}
		for i, frag := range fragments {
			_, err := serverConn.Write(frag)
			sent := err == nil
			if mon != nil {
				delay := 0.0
				if i < len(fragments)-1 {
					delay = fs.fragmentDelay
				}
				mon.Emit(PacketEvent{Event: EvFragPiece, ConnID: connID, Data: map[string]interface{}{
					"index": i, "total": len(fragments),
					"size": len(frag), "sent": sent, "delay": delay,
				}})
			}
			if i < len(fragments)-1 && fs.fragmentDelay > 0 {
				time.Sleep(time.Duration(fs.fragmentDelay * float64(time.Second)))
			}
		}
		if tc, ok := serverConn.(*net.TCPConn); ok {
			tc.SetNoDelay(false)
		}
		return true

	case "fake_sni":
		fsb := ps.strategy.(*FakeSNIBypass)
		if fsb.useTTLTrick {
			if mon != nil {
				mon.Emit(PacketEvent{Event: EvFakeSNITTL, ConnID: connID, Data: map[string]interface{}{
					"sni": ps.fakeSNI, "ttl": 2,
				}})
			}
		} else {
			if mon != nil {
				mon.Emit(PacketEvent{Event: EvFakeSNISend, ConnID: connID, Data: map[string]interface{}{
					"sni": ps.fakeSNI, "method": "fragment-fallback",
				}})
			}
		}
		return ps.strategy.Apply(clientConn, serverConn, ps.fakeSNI, firstData)

	case "combined":
		cb := ps.strategy.(*CombinedBypass)
		if cb.useTTLTrick {
			if mon != nil {
				mon.Emit(PacketEvent{Event: EvFakeSNITTL, ConnID: connID, Data: map[string]interface{}{
					"sni": ps.fakeSNI, "ttl": 2,
				}})
			}
		}
		fragments := cb.engine.Fragment(firstData, cb.fragmentStrategy)
		if mon != nil {
			sizes := make([]int, len(fragments))
			for i, f := range fragments {
				sizes[i] = len(f)
			}
			mon.Emit(PacketEvent{Event: EvFragStart, ConnID: connID, Data: map[string]interface{}{
				"count": len(fragments), "sizes": sizes, "strategy": cb.fragmentStrategy,
			}})
		}
		result := ps.strategy.Apply(clientConn, serverConn, ps.fakeSNI, firstData)
		if mon != nil && result {
			mon.Emit(PacketEvent{Event: EvDPIBypassOK, ConnID: connID})
		}
		return result
	}
	return ps.strategy.Apply(clientConn, serverConn, ps.fakeSNI, firstData)
}

var defaultConfig = map[string]interface{}{
	"LISTEN_HOST":       "0.0.0.0",
	"LISTEN_PORT":       float64(40443),
	"CONNECT_IP":        "104.18.38.202",
	"CONNECT_PORT":      float64(443),
	"FAKE_SNI":          "cdnjs.cloudflare.com",
	"BYPASS_METHOD":     "fragment",
	"FRAGMENT_STRATEGY": "sni_split",
	"FRAGMENT_DELAY":    0.1,
	"USE_TTL_TRICK":     false,
	"FAKE_SNI_METHOD":   "prefix_fake",
	"MONITOR":           true,
}

const banner = `
 ██████╗ ███████╗████████╗ █████╗     ███████╗███╗   ██╗██╗
 ██╔══██╗██╔════╝╚══██╔══╝██╔══██╗    ██╔════╝████╗  ██║██║
 ██████╔╝███████╗   ██║   ███████║    ███████╗██╔██╗ ██║██║
 ██╔══██╗╚════██║   ██║   ██╔══██║    ╚════██║██║╚██╗██║██║
 ██║  ██║███████║   ██║   ██║  ██║    ███████║██║ ╚████║██║
 ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝    ╚══════╝╚═╝  ╚═══╝╚═╝
`

type ConfigLoader struct{}

func (ConfigLoader) Load(path string) (map[string]interface{}, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}
	var cfg map[string]interface{}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

func (ConfigLoader) Generate(path string) error {
	data, err := json.MarshalIndent(defaultConfig, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return err
	}
	fmt.Printf("Generated default config: %s\n", path)
	fmt.Println(string(data))
	return nil
}

func (ConfigLoader) Merge(base, overlay map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{}, len(base))
	for k, v := range base {
		result[k] = v
	}
	for k, v := range overlay {
		result[k] = v
	}
	return result
}

type StrategyFactory struct{}

func (StrategyFactory) Build(cfg map[string]interface{}) BypassStrategy {
	method := strings.ToLower(strMapVal(cfg, "BYPASS_METHOD", "fragment"))
	fragStrategy := strMapVal(cfg, "FRAGMENT_STRATEGY", "sni_split")
	fragDelay := floatMapVal(cfg, "FRAGMENT_DELAY", 0.1)
	useTTL := boolMapVal(cfg, "USE_TTL_TRICK", false)
	fakeSNIMethod := strMapVal(cfg, "FAKE_SNI_METHOD", "prefix_fake")
	fragReal := boolMapVal(cfg, "FAKE_SNI_FRAGMENT_REAL", true)

	switch method {
	case "fragment":
		return NewFragmentBypass(fragStrategy, fragDelay, true)
	case "fake_sni":
		return NewFakeSNIBypass(fakeSNIMethod, useTTL, fragReal, fragStrategy)
	case "combined":
		return NewCombinedBypass(fragStrategy, useTTL, fragDelay, true)
	}
	fmt.Printf("Warning: Unknown bypass method '%s', using 'fragment'\n", method)
	return NewFragmentBypass("sni_split", 0.1, true)
}

func buildStrategy(cfg map[string]interface{}) BypassStrategy {
	return StrategyFactory{}.Build(cfg)
}

type AddressParser struct{}

func (AddressParser) Parse(addr, defaultHost string, defaultPort int) (string, int) {
	if addr == "" {
		return defaultHost, defaultPort
	}
	if strings.HasPrefix(addr, ":") {
		p := 0
		fmt.Sscanf(addr[1:], "%d", &p)
		if p == 0 {
			fmt.Printf("Error: Invalid port in '%s'\n", addr)
			os.Exit(1)
		}
		return defaultHost, p
	}
	parts := strings.SplitN(addr, ":", 2)
	if len(parts) == 2 {
		host := parts[0]
		if host == "" {
			host = defaultHost
		}
		p := 0
		fmt.Sscanf(parts[1], "%d", &p)
		if p == 0 {
			fmt.Printf("Error: Invalid port in '%s'\n", addr)
			os.Exit(1)
		}
		return host, p
	}
	return parts[0], defaultPort
}

func parseHostPort(addr, defaultHost string, defaultPort int) (string, int) {
	return AddressParser{}.Parse(addr, defaultHost, defaultPort)
}

func resolveHost(host string) string {
	addrs, err := net.LookupHost(host)
	if err != nil || len(addrs) == 0 {
		return host
	}
	return addrs[0]
}

func isValidPort(port int) bool {
	return port >= 1 && port <= 65535
}

func getDefaultInterfaceIPv4(dest string) string {
	conn, err := net.Dial("udp", dest+":53")
	if err != nil {
		return ""
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

type PlatformInfo struct{}

func (PlatformInfo) Show() {
	w := 52
	fmt.Printf("\n╭%s╮\n", strings.Repeat("─", w))
	fmt.Printf("│%s│\n", centerPad(fmt.Sprintf("  Platform Info  —  v%s", Version), w))
	fmt.Printf("├%s┤\n", strings.Repeat("─", w))

	rows := []struct{ k, v string }{
		{"platform", runtime.GOOS + "/" + runtime.GOARCH},
		{"go_version", runtime.Version()},
		{"cpu_cores", fmt.Sprintf("%d", runtime.NumCPU())},
		{"goroutines", fmt.Sprintf("%d", runtime.NumGoroutine())},
		{"max_conns", fmt.Sprintf("%d", MaxConcurrentConns)},
		{"buffer_size", fmtBytes(BufferSize)},
		{"tcp_buf_read", fmtBytes(TCPReadBuffer)},
		{"tcp_buf_write", fmtBytes(TCPWriteBuffer)},
		{"fragment_support", "✓  yes"},
		{"tls_record_frag", "✓  yes"},
		{"fake_sni", "✓  yes"},
		{"tcp_nodelay", "✓  yes"},
	}

	for _, r := range rows {
		val := r.v
		if strings.HasPrefix(val, "✓") {
			val = green(val)
		} else if strings.HasPrefix(val, "✗") {
			val = red(val)
		} else {
			val = cyan(val)
		}
		fmt.Printf("│  %-28s %-16s  │\n", r.k, val)
	}
	fmt.Printf("╰%s╯\n", strings.Repeat("─", w))
	fmt.Println()
	fmt.Printf("  %s  Recommended methods:\n", bold("★"))
	fmt.Printf("  %s   combined   — TTL trick + fragmentation %s\n", green("★"), dim("(best)"))
	fmt.Printf("  %s   fragment   — fragmentation only\n", cyan("✓"))
}

func showPlatformInfo() {
	PlatformInfo{}.Show()
}

func printHelpExtra() {
	fmt.Printf(`
%s
%s
%s

%s

  rstaspoof %s
      Instant launch with default config:
      listen :40443  →  104.19.230.21:443
      fake SNI: www.hcaptcha.com  │  method: combined

  rstaspoof %s
      Full manual mode.

%s

  %s   HOST:PORT   Local proxy address  (default: 0.0.0.0:40443)
  %s  IP:PORT     Remote server to forward to
  %s      HOSTNAME    Fake SNI domain to spoof
  %s   METHOD      Bypass method: fragment | fake_sni | combined
  %s   FILE        Load settings from JSON config file
  %s              Verbose logging
  %s                Suppress all output except errors
  %s               Disable real-time packet display
  %s                   Disable raw socket injection
  %s                Force TTL trick (no root needed)
  %s                     Show platform capabilities and exit
  %s FILE     Write default config JSON and exit
  %s              Print version

%s

  %s   Split in the middle of the SNI value  %s
  %s            Split the record in half
  %s           Split into many 24-byte chunks
  %s TLS-level record fragmentation

%s

  %s   Fragment ClientHello at SNI boundary.  No root needed.
  %s   Inject fake SNI (TTL trick).
  %s   Both fake_sni + fragmentation.  Best results.

%s

  rstaspoof -tddd
  rstaspoof -listen :40443 -connect 104.19.230.21:443 -sni www.hcaptcha.com -method combined
  rstaspoof -listen :40443 -connect 1.2.3.4:443 -sni cdn.example.com -method fragment
  rstaspoof -config myconfig.json
  rstaspoof -info

%s

  %s   Server replied  →  %s
  %s   No response     →  %s
  %s   ClientHello was split and sent in pieces
  %s   Fake SNI packet dispatched to DPI
  %s   ClientHello parsed, real SNI extracted

%s

  pkg install golang
  go run rstaspoof.go -tddd
  No root required — fragment and TTL methods work without root.

%s
`,
		bold(strings.Repeat("━", 62)),
		bold("  RSTA SNI SPOOF  —  Command Reference"),
		bold(strings.Repeat("━", 62)),
		cyan("QUICK START (Termux / no root)"),
		yellow("-tddd"),
		yellow("-listen :40443 -connect IP:443 -sni DOMAIN"),
		cyan("ARGUMENTS"),
		green("-listen"), green("-connect"), green("-sni"), green("-method"), green("-config"),
		green("-verbose"), green("-quiet"), green("-no-monitor"), green("-no-raw"),
		green("-ttl-trick"), green("-info"), green("-generate-config"), green("-version"),
		cyan("FRAGMENT STRATEGIES")+" (use with -fragment-strategy)",
		yellow("sni_split"), green("← recommended"),
		yellow("half"),
		yellow("multi"),
		yellow("tls_record_frag"),
		cyan("BYPASS METHODS"),
		yellow("fragment"), yellow("fake_sni"), yellow("combined"),
		cyan("EXAMPLES"),
		cyan("REAL-TIME MONITOR LEGEND"),
		green("[SVR RESP ]"), green("SNI spoof is WORKING"),
		red("[BLOCKED  ]"), red("DPI may be blocking"),
		yellow("[FRAGMENT ]"),
		magenta("[FAKE SNI ]"),
		blue("[TLS HELLO]"),
		cyan("TERMUX SETUP"),
		bold(strings.Repeat("━", 62)),
	)
}

func printRunningBanner(listenHost string, listenPort int, connectIP string, connectPort int, fakeSNI, method string) {
	w := 66

	centerPadFn := func(s string) string {
		return centerPad(s, w)
	}

	row := func(left, right string) string {
		content := fmt.Sprintf("  %-26s %s", left, cyan(right))
		pad := w - 2 - len(fmt.Sprintf("  %-26s %s", left, right))
		if pad < 0 {
			pad = 0
		}
		return fmt.Sprintf("│%s%s│", content, strings.Repeat(" ", pad))
	}

	sep := fmt.Sprintf("├%s┤", strings.Repeat("─", w))

	lines := []string{
		fmt.Sprintf("╭%s╮", strings.Repeat("─", w)),
		fmt.Sprintf("│%s│", centerPadFn(fmt.Sprintf("  RSTA SNI SPOOF  v%s  —  Live Proxy", Version))),
		sep,
		row("Listen", fmt.Sprintf("%s:%d", listenHost, listenPort)),
		row("Forward", fmt.Sprintf("%s:%d", connectIP, connectPort)),
		row("Fake SNI", fakeSNI),
		row("Method", method),
		row("Max Conns", fmt.Sprintf("%d", MaxConcurrentConns)),
		row("Buffer", fmt.Sprintf("%s / conn", fmtBytes(BufferSize))),
		row("CPUs", fmt.Sprintf("%d", runtime.NumCPU())),
		sep,
		fmt.Sprintf("│%s│", centerPadFn(fmt.Sprintf("  Configure your app  →  127.0.0.1:%d", listenPort))),
		fmt.Sprintf("╰%s╯", strings.Repeat("─", w)),
	}

	fmt.Println()
	for _, line := range lines {
		if colorEnabled {
			fmt.Println(cyan(line))
		} else {
			fmt.Println(line)
		}
	}
	fmt.Println()
	fmt.Printf("  %s  — watching connections in real time\n  %s = spoof working  │  %s = spoof failed\n  %s\n",
		bold("SNI Spoof Status"),
		green("✓ SERVER REPLIED"),
		red("✗ DPI BLOCKED"),
		strings.Repeat("─", 58))
}

func centerPad(s string, width int) string {
	if len(s) >= width {
		return s
	}
	totalPad := width - len(s)
	left := totalPad / 2
	right := totalPad - left
	return strings.Repeat(" ", left) + s + strings.Repeat(" ", right)
}

func concat(slices ...[]byte) []byte {
	total := 0
	for _, s := range slices {
		total += len(s)
	}
	result := make([]byte, 0, total)
	for _, s := range slices {
		result = append(result, s...)
	}
	return result
}

func strVal(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func toInt(v interface{}) int {
	if v == nil {
		return 0
	}
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	}
	return 0
}

func toFloat(v interface{}) float64 {
	if v == nil {
		return 0
	}
	if x, ok := v.(float64); ok {
		return x
	}
	return 0
}

func toIntSlice(v interface{}) []int {
	if v == nil {
		return nil
	}
	if s, ok := v.([]int); ok {
		return s
	}
	if s, ok := v.([]interface{}); ok {
		result := make([]int, len(s))
		for i, x := range s {
			result[i] = toInt(x)
		}
		return result
	}
	return nil
}

func strMapVal(m map[string]interface{}, key, def string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return def
}

func floatMapVal(m map[string]interface{}, key string, def float64) float64 {
	if v, ok := m[key]; ok {
		if f, ok := v.(float64); ok {
			return f
		}
	}
	return def
}

func boolMapVal(m map[string]interface{}, key string, def bool) bool {
	if v, ok := m[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return def
}

func intMapVal(m map[string]interface{}, key string, def int) int {
	if v, ok := m[key]; ok {
		return toInt(v)
	}
	return def
}

func main() {
	fs := flag.NewFlagSet("rstaspoof", flag.ExitOnError)
	fHelp           := fs.Bool("help", false, "")
	fTddd           := fs.Bool("tddd", false, "")
	fConfig         := fs.String("config", "", "")
	fGenerateConfig := fs.String("generate-config", "", "")
	fListen         := fs.String("listen", "", "")
	fConnect        := fs.String("connect", "", "")
	fSNI            := fs.String("sni", "", "")
	fMethod         := fs.String("method", "", "")
	fFragStrategy   := fs.String("fragment-strategy", "", "")
	fFragDelay      := fs.Float64("fragment-delay", -1, "")
	fTTLTrick       := fs.Bool("ttl-trick", false, "")
	fNoRaw          := fs.Bool("no-raw", false, "")
	fNoMonitor      := fs.Bool("no-monitor", false, "")
	fVerbose        := fs.Bool("verbose", false, "")
	fQuiet          := fs.Bool("quiet", false, "")
	fVersion        := fs.Bool("version", false, "")
	fInfo           := fs.Bool("info", false, "")
	_ = fNoRaw
	_ = fVerbose

	fs.Parse(os.Args[1:])

	if *fVersion {
		fmt.Printf("RSTA SNI Spoof %s\n", Version)
		return
	}

	if *fHelp {
		fmt.Println(banner)
		printHelpExtra()
		return
	}

	loader := ConfigLoader{}

	if *fGenerateConfig != "" {
		if err := loader.Generate(*fGenerateConfig); err != nil {
			os.Exit(1)
		}
		return
	}

	if *fTddd {
		*fListen = ":40443"
		*fConnect = "104.19.230.21:443"
		*fSNI = "www.hcaptcha.com"
		*fMethod = "combined"
	}

	if *fInfo {
		showPlatformInfo()
		return
	}

	cfg := make(map[string]interface{})
	for k, v := range defaultConfig {
		cfg[k] = v
	}

	if *fConfig != "" {
		if userCfg, err := loader.Load(*fConfig); err == nil {
			cfg = loader.Merge(cfg, userCfg)
		}
	} else {
		for _, candidate := range []string{"config.json", "snispf.json"} {
			if _, err := os.Stat(candidate); err == nil {
				if userCfg, err := loader.Load(candidate); err == nil {
					cfg = loader.Merge(cfg, userCfg)
					break
				}
			}
		}
	}

	addrParser := AddressParser{}

	if *fListen != "" {
		h, p := addrParser.Parse(*fListen, "0.0.0.0", 40443)
		cfg["LISTEN_HOST"] = h
		cfg["LISTEN_PORT"] = float64(p)
	}
	if *fConnect != "" {
		h, p := addrParser.Parse(*fConnect, "104.18.38.202", 443)
		cfg["CONNECT_IP"] = h
		cfg["CONNECT_PORT"] = float64(p)
	}
	if *fSNI != "" {
		cfg["FAKE_SNI"] = *fSNI
	}
	if *fMethod != "" {
		cfg["BYPASS_METHOD"] = *fMethod
	}
	if *fFragStrategy != "" {
		cfg["FRAGMENT_STRATEGY"] = *fFragStrategy
	}
	if *fFragDelay >= 0 {
		cfg["FRAGMENT_DELAY"] = *fFragDelay
	}
	if *fTTLTrick {
		cfg["USE_TTL_TRICK"] = true
	}
	if *fNoMonitor {
		cfg["MONITOR"] = false
	}

	listenPort := intMapVal(cfg, "LISTEN_PORT", 40443)
	connectPort := intMapVal(cfg, "CONNECT_PORT", 443)

	cfg["CONNECT_IP"] = resolveHost(strMapVal(cfg, "CONNECT_IP", ""))
	interfaceIP := getDefaultInterfaceIPv4(strMapVal(cfg, "CONNECT_IP", "8.8.8.8"))

	monitorMode := !*fNoMonitor && !*fQuiet
	var mon *PacketMonitor
	if boolMapVal(cfg, "MONITOR", true) && monitorMode {
		mon = InitMonitor(*fQuiet)
	} else {
		mon = NewPacketMonitor(50, true)
		globalMonitor = mon
	}

	strategy := buildStrategy(cfg)

	server := NewProxyServer(
		strMapVal(cfg, "LISTEN_HOST", "0.0.0.0"),
		listenPort,
		strMapVal(cfg, "CONNECT_IP", ""),
		connectPort,
		strMapVal(cfg, "FAKE_SNI", ""),
		strategy,
		interfaceIP,
	)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		m := GetMonitor()
		if m != nil {
			m.PrintStats()
		}
		os.Exit(0)
	}()

	_ = mon
	if err := server.Start(); err != nil {
		os.Exit(1)
	}
}
