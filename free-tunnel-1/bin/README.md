# Binaries go here

This module does not bundle any circumvention *services* (servers, keys) — you
supply those. It does, however, bundle one thing directly: `src/rstaspoof.go`,
the actual no-root SNI-spoof engine, since you gave us its exact source. Build
it once and drop the binary here.

## bin/rstaspoof — bundled source, build it yourself

`src/rstaspoof.go` is your own tool, included as-is. Build it on-device (in
Termux, since it already has Go and matches your device's arch) or cross-compile
from a PC:

```
# On-device, in Termux:
pkg install golang
cd /path/to/src
go build -o rstaspoof rstaspoof.go
```

**Then get it out of Termux's sandbox.** Termux runs as its own regular app —
it has no permission to write into `/data/local/tmp` (that path belongs to the
shell/root user Shizuku runs as), so a direct `cp` there fails with
`Permission denied`. Route through shared storage instead, which both Termux
and the shell can reach:

```
# In Termux, once:
termux-setup-storage
cp rstaspoof ~/storage/shared/rstaspoof
```

Then open the module's WebUI → **Binaries** panel → **Import binary**: enter
`/sdcard/rstaspoof` as the source path, pick `rstaspoof` as the target, and hit
Import. That runs the copy with the shell/root privilege the WebUI has, so it
can actually write into `bin/`. The same Import row works for `xray`,
`dnstt-client`, and `psiphon` once you've built or downloaded those too.

**Honest note on its `-no-raw` flag:** the tool's own `-h` text mentions "raw
socket injection," but that flag is parsed and then discarded
(`_ = fNoRaw`) — there's no raw-socket code path in the source you gave us.
The real, working mechanism is two ordinary TCP sockets: a short-lived decoy
connection carrying the fake SNI, plus TLS-record fragmentation of the real
ClientHello on the actual connection. That's why it needs no root — and why
running it via root wouldn't make this particular technique any stronger.
The module's real optimization over a manual Termux run is process
supervision and automatic failover across your candidate list (see
`webui/app.js`, `Supervisor`) — the binary tracks failures internally
(`ConnectionTracker`/`ShouldFailover`) but never acts on them; the module
does that part for it.

## Everything else

| File            | What it is                          | Get it from |
|------------------|--------------------------------------|-------------|
| `bin/xray`        | Xray-core — your VLESS/Trojan client, dialing 127.0.0.1:&lt;rstaspoof listen port&gt; instead of the real server directly, plus the outer wrapper for Psiphon+V2Ray | https://github.com/XTLS/Xray-core/releases — `android-arm64` asset, rename to `xray`. |
| `bin/dnstt-client` | DNSTT client (DNS-tunneling)          | https://www.bamsoftware.com/software/dnstt/ (source) — cross-compile for `arm64`. |
| `bin/psiphon`      | Psiphon tunnel-core console client    | https://github.com/Psiphon-Labs/psiphon-tunnel-core — no official ARM CLI release; build `ConsoleClient` yourself. |

Same rule applies to these: build/download them wherever you like, get the
result onto shared storage (`/sdcard/...`), then use the WebUI's **Import
binary** row to move each into `bin/` with the right permissions — no manual
`cp`/`chmod` needed, and no `Permission denied` surprises from Termux trying
to write into `/data/local/tmp` directly.

The WebUI's Binaries panel shows which ones it can currently find.
