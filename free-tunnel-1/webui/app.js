/* ============================================================
   Free Net Tunnel — app.js
   All device access goes through window.Shizuku.exec /
   execWithOptions (module.prop has usesShellBridge=true).

   SNI-spoof runs YOUR rstaspoof.go (bundled under bin/src/,
   built by you — see bin/README.md). It needs no root; the only
   thing this module adds on top of a manual Termux run is
   process supervision and automatic candidate failover, since
   rstaspoof tracks failures internally but never acts on them.
   ============================================================ */

(function () {
  "use strict";

  const WORKDIR = "/data/local/tmp/free_tunnel";
  const BIN = WORKDIR + "/bin";
  const CFG = WORKDIR + "/configs";
  const ST = WORKDIR + "/state";
  const LOG = WORKDIR + "/logs";

  const PORTS = {
    psiphonRootInbound: 12346,
    psiphonLocalProxy: 10809
  };

  const FAILOVER_THRESHOLD = 3;   // BLOCKED events before switching candidates
  const FAILOVER_WINDOW_MS = 30000;

  const state = {
    root: false,
    binaries: {},
    candidates: [],       // [{fakeSni, ip, port}]
    activeCandidateIdx: -1,
    consoleEntries: [],
    supervisorTimer: null,
    lastFailoverCheckLen: 0
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    chipMode: $("chipMode"),
    chipConn: $("chipConn"),
    bridgeWarning: $("bridgeWarning"),
    mainContent: $("mainContent"),
    binariesGrid: $("binariesGrid"),
    tabs: $("tabs"),
    candidateList: $("candidateList"),
    scanCandidateList: $("scanCandidateList"),
    scanResults: $("scanResults"),
    sniLiveStats: $("sniLiveStats"),
    routingRoot: $("routingRoot"),
    routingNonRoot: $("routingNonRoot"),
    console: $("console"),
    consoleHandle: $("consoleHandle"),
    consoleBody: $("consoleBody"),
    consoleCount: $("consoleCount"),
    toast: $("toast")
  };

  /* ---------- bridge ---------- */
  function bridgeAvailable() { return typeof window.Shizuku !== "undefined" && window.Shizuku !== null; }

  function shExec(cmd, opts) {
    if (!bridgeAvailable()) return { ok: false, exitCode: -1, stdout: "", stderr: "window.Shizuku is not available", timedOut: false };
    let raw;
    try {
      raw = opts ? window.Shizuku.execWithOptions(cmd, JSON.stringify(opts)) : window.Shizuku.exec(cmd);
    } catch (e) {
      raw = JSON.stringify({ ok: false, exitCode: -1, stdout: "", stderr: String(e), timedOut: false });
    }
    let result;
    try { result = JSON.parse(raw); }
    catch (e) { result = { ok: false, exitCode: -1, stdout: "", stderr: "unparseable bridge response", timedOut: false }; }
    logConsole(cmd, result);
    return result;
  }

  function logConsole(cmd, result) {
    state.consoleEntries.push({ cmd, result, time: new Date() });
    if (state.consoleEntries.length > 200) state.consoleEntries.shift();
    renderConsole();
  }
  function renderConsole() {
    el.consoleCount.textContent = state.consoleEntries.length + " entries";
    const frag = document.createDocumentFragment();
    state.consoleEntries.slice(-50).forEach((entry) => {
      const div = document.createElement("div");
      div.className = "console-line " + (entry.result.ok ? "ok" : "fail");
      const hh = entry.time.toTimeString().slice(0, 8);
      const preview = entry.cmd.length > 140 ? entry.cmd.slice(0, 140) + "…" : entry.cmd;
      div.innerHTML = '<span class="t">' + hh + "</span>" + '<span class="cmd">$ ' + escapeHtml(preview) + "</span>";
      frag.appendChild(div);
    });
    el.consoleBody.innerHTML = "";
    el.consoleBody.appendChild(frag);
    el.consoleBody.scrollTop = el.consoleBody.scrollHeight;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  let toastTimer = null;
  function showToast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = "toast " + (kind || "");
    el.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3600);
  }
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

  /* ============================================================
     Starfield background (decorative only)
     ============================================================ */
  function initStars() {
    const canvas = $("stars");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let stars = [];
    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const count = Math.floor((canvas.width * canvas.height) / 9000);
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.2 + 0.2,
        phase: Math.random() * Math.PI * 2,
        speed: 0.3 + Math.random() * 0.6
      }));
    }
    function frame(t) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      stars.forEach((s) => {
        const twinkle = 0.5 + 0.5 * Math.sin(t * 0.001 * s.speed + s.phase);
        ctx.globalAlpha = 0.25 + twinkle * 0.55;
        ctx.fillStyle = "#ECEBFA";
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      });
      requestAnimationFrame(frame);
    }
    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(frame);
  }

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    initStars();
    if (!bridgeAvailable()) {
      el.bridgeWarning.classList.remove("hidden");
      el.mainContent.classList.add("hidden");
      return;
    }
    const setupRes = shExec("mkdir -p " + shq(BIN) + " " + shq(CFG) + " " + shq(ST) + " " + shq(LOG) + " && id");
    state.root = setupRes.ok && /uid=0\(root\)/.test(setupRes.stdout);
    el.chipMode.textContent = state.root ? "MODE: ROOT" : "MODE: ADB";
    el.chipMode.classList.add(state.root ? "chip-warn" : "chip-ok");
    el.routingRoot.classList.toggle("hidden", !state.root);
    el.routingNonRoot.classList.toggle("hidden", state.root);

    checkBinaries();
    loadCandidates();
    checkActiveMethod();
    bindEvents();
    renderConsole();
  }

  function checkBinaries() {
    const names = ["rstaspoof", "xray", "dnstt-client", "psiphon"];
    const script = names.map((n) => "test -x " + shq(BIN + "/" + n) + " && echo " + n + "=yes || echo " + n + "=no").join("; ");
    const res = shExec(script);
    const found = {};
    (res.stdout || "").split("\n").forEach((line) => {
      const m = line.match(/^([a-zA-Z0-9._-]+)=(yes|no)$/);
      if (m) found[m[1]] = m[2] === "yes";
    });
    el.binariesGrid.innerHTML = "";
    names.forEach((name) => {
      const ok = !!found[name];
      state.binaries[name] = ok;
      const chip = document.createElement("span");
      chip.className = "bin-chip " + (ok ? "found" : "missing");
      chip.textContent = (ok ? "✓ " : "— ") + name;
      el.binariesGrid.appendChild(chip);
    });
  }

  function importBinary() {
    let src = $("importSrcPath").value.trim();
    const name = $("importTargetName").value;
    if (!src) { showToast("Enter the source path (e.g. /sdcard/rstaspoof)", "fail"); return; }

    if (!src.startsWith("/")) {
      // Common typo: "sdcard/rstaspoof" instead of "/sdcard/rstaspoof" — a
      // relative path silently never matches, so normalize instead of
      // failing on something this obvious.
      const normalized = src.startsWith("sdcard/") ? "/" + src : "/sdcard/" + src;
      showToast("Treating that as " + normalized + " (paths need a leading /)", "ok");
      src = normalized;
      $("importSrcPath").value = normalized;
    }

    const dest = BIN + "/" + name;
    const script =
      "test -f " + shq(src) + " || { echo NOFILE; exit 1; }; " +
      "cp " + shq(src) + " " + shq(dest) + " && chmod 755 " + shq(dest) + " && echo IMPORTED";
    const res = shExec(script);
    if (res.ok && res.stdout.indexOf("IMPORTED") !== -1) {
      showToast(name + " imported to bin/", "ok");
      $("importSrcPath").value = "";
      checkBinaries();
    } else if (res.stdout.indexOf("NOFILE") !== -1) {
      showToast("No file at " + src + " — check the exact filename (build output may not include .go)", "fail");
    } else {
      showToast("Import failed: " + (res.stderr || "unknown error").slice(0, 120), "fail");
    }
  }

  function checkActiveMethod() {
    const script =
      "M=$(cat " + shq(ST + "/active.method") + " 2>/dev/null); " +
      "if [ -z \"$M\" ]; then echo NONE; exit 0; fi; " +
      "PID=$(cat " + shq(ST) + "/$M.pid 2>/dev/null); " +
      "if [ -n \"$PID\" ] && kill -0 \"$PID\" 2>/dev/null; then echo \"$M:alive\"; else echo \"$M:dead\"; fi";
    const res = shExec(script);
    const out = (res.ok && res.stdout.trim()) || "NONE";
    if (out === "NONE") { el.chipConn.textContent = "LINK: down"; el.chipConn.className = "chip chip-muted"; return; }
    const [method, status] = out.split(":");
    if (status === "alive") {
      el.chipConn.textContent = "LINK: " + method;
      el.chipConn.className = "chip chip-live";
    } else {
      el.chipConn.textContent = "LINK: down (" + method + " stopped)";
      el.chipConn.className = "chip chip-muted";
    }
  }

  function bindEvents() {
    el.tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn) return;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".method-panel").forEach((p) => p.classList.add("hidden"));
      $("panel-" + btn.dataset.tab).classList.remove("hidden");
    });

    $("btnAddCandidate").addEventListener("click", () => { addCandidate(); });
    $("btnAddScanCandidate").addEventListener("click", () => { addCandidate(); });
    $("btnImportBinary").addEventListener("click", importBinary);
    $("btnStartSni").addEventListener("click", startSni);
    $("btnStopSni").addEventListener("click", stopSni);
    $("btnForceKillSni").addEventListener("click", forceKillSni);
    $("btnRunScan").addEventListener("click", runScan);
    $("btnConvert").addEventListener("click", runConvert);
    $("btnCopyConverted").addEventListener("click", copyConverted);

    document.querySelectorAll("[data-start]").forEach((btn) => btn.addEventListener("click", () => {
      if (btn.dataset.start === "dnstt") startDnstt();
      if (btn.dataset.start === "psiphon") startPsiphon();
    }));
    document.querySelectorAll("[data-stop]").forEach((btn) => btn.addEventListener("click", () => stopByPidfile(btn.dataset.stop)));

    el.consoleHandle.addEventListener("click", () => el.console.classList.toggle("open"));
    $("btnApplyRouting").addEventListener("click", applyRouting);
    $("btnClearRouting").addEventListener("click", clearRouting);
  }

  /* ============================================================
     File helpers
     ============================================================ */
  function writeFileB64(path, content) {
    const b64 = btoa(unescape(encodeURIComponent(content)));
    const chunks = b64.match(/.{1,4000}/g) || [""];
    const parts = ["rm -f " + shq(path + ".b64")];
    chunks.forEach((chunk) => parts.push("printf '%s' " + shq(chunk) + " >> " + shq(path + ".b64")));
    parts.push("base64 -d " + shq(path + ".b64") + " > " + shq(path) + " && rm -f " + shq(path + ".b64"));
    return shExec(parts.join(" && "));
  }
  function readFile(path) {
    const res = shExec("cat " + shq(path) + " 2>/dev/null");
    return res.ok ? res.stdout : "";
  }

  function startBackground(method, launchCmd) {
    const pidfile = ST + "/" + method + ".pid";
    const logfile = LOG + "/" + method + ".log";
    const cmd = "nohup sh -c " + shq(launchCmd) + " > " + shq(logfile) + " 2>&1 & echo $! > " + shq(pidfile) + " ; echo " + shq(method) + " > " + shq(ST + "/active.method");
    return shExec(cmd);
  }
  function stopByPidfile(method) {
    const pidfile = ST + "/" + method + ".pid";
    shExec("PID=$(cat " + shq(pidfile) + " 2>/dev/null); [ -n \"$PID\" ] && kill \"$PID\" 2>/dev/null; rm -f " + shq(pidfile) + " " + shq(ST + "/active.method"));
    checkActiveMethod();
  }

  /* ============================================================
     Candidates (shared between SNI tab and Scanner tab)
     ============================================================ */
  function loadCandidates() {
    const raw = readFile(CFG + "/candidates.json");
    try {
      state.candidates = raw ? JSON.parse(raw) : [];
    } catch (e) {
      state.candidates = [];
    }
    if (state.candidates.length === 0) {
      state.candidates = [{ fakeSni: "www.hcaptcha.com", ip: "", port: 443 }];
    }
    renderCandidates();
  }
  let saveCandidatesTimer = null;
  function saveCandidates() {
    clearTimeout(saveCandidatesTimer);
    saveCandidatesTimer = setTimeout(() => {
      writeFileB64(CFG + "/candidates.json", JSON.stringify(state.candidates, null, 2));
    }, 800);
  }
  function saveCandidatesNow() {
    clearTimeout(saveCandidatesTimer);
    writeFileB64(CFG + "/candidates.json", JSON.stringify(state.candidates, null, 2));
  }
  function addCandidate() {
    state.candidates.push({ fakeSni: "", ip: "", port: 443 });
    saveCandidatesNow();
    renderCandidates();
  }
  function removeCandidate(idx) {
    state.candidates.splice(idx, 1);
    saveCandidatesNow();
    renderCandidates();
  }
  function updateCandidate(idx, field, value) {
    state.candidates[idx][field] = value;
    saveCandidates();
  }

  function renderCandidates() {
    [el.candidateList, el.scanCandidateList].forEach((container) => {
      if (!container) return;
      container.innerHTML = "";
      state.candidates.forEach((c, idx) => {
        const row = document.createElement("div");
        row.className = "candidate-row" + (idx === state.activeCandidateIdx ? " active-candidate" : "");

        const sni = document.createElement("input");
        sni.placeholder = "fake SNI"; sni.value = c.fakeSni || "";
        sni.addEventListener("input", (e) => updateCandidate(idx, "fakeSni", e.target.value));

        const ip = document.createElement("input");
        ip.placeholder = "real IP"; ip.value = c.ip || "";
        ip.addEventListener("input", (e) => updateCandidate(idx, "ip", e.target.value));

        const port = document.createElement("input");
        port.placeholder = "port"; port.value = c.port || 443;
        port.addEventListener("input", (e) => updateCandidate(idx, "port", e.target.value));

        const del = document.createElement("button");
        del.className = "row-x"; del.textContent = "×";
        del.addEventListener("click", () => removeCandidate(idx));

        row.appendChild(sni); row.appendChild(ip); row.appendChild(port); row.appendChild(del);
        container.appendChild(row);
      });
    });
  }

  /* ============================================================
     SNI Spoof — rstaspoof orchestration + failover supervisor
     ============================================================ */
  function startSni() {
    if (!state.binaries.rstaspoof) { showToast("rstaspoof binary not found — build it from bin/src/rstaspoof.go, see bin/README.md", "fail"); return; }
    const valid = state.candidates.filter((c) => c.fakeSni && c.ip && c.port);
    if (valid.length === 0) { showToast("Add at least one candidate (fake SNI + real IP + port)", "fail"); return; }
    state.activeCandidateIdx = state.candidates.indexOf(valid[0]);
    launchRstaspoof();
    if ($("sni-autofailover").checked) startSupervisor();
    renderCandidates();
  }

  function launchRstaspoof() {
    const c = state.candidates[state.activeCandidateIdx];
    const listenPort = parseInt($("sni-listenport").value, 10) || 40443;
    const method = $("sni-method").value;
    const strategy = $("sni-fragstrategy").value;
    stopByPidfile("sni"); // clean any previous instance before relaunching
    const cmd = BIN + "/rstaspoof -listen :" + listenPort +
      " -connect " + shq(c.ip + ":" + c.port) +
      " -sni " + shq(c.fakeSni) +
      " -method " + shq(method) +
      " -fragment-strategy " + shq(strategy);
    const result = startBackground("sni", cmd);
    if (result.ok) {
      showToast("rstaspoof started on :" + listenPort + " → " + c.fakeSni, "ok");
    } else {
      showToast("Failed to start: " + (result.stderr || "").slice(0, 100), "fail");
    }
    checkActiveMethod();
  }

  function stopSni() {
    stopSupervisor();
    stopByPidfile("sni");
    state.activeCandidateIdx = -1;
    renderCandidates();
    showToast("SNI-spoof stopped", "ok");
  }

  // One command, one confirmation, no dependence on the pidfile being
  // accurate — for when Stop didn't actually take (e.g. its kill got lost
  // in a backlog of pending confirmations) and the port is still held.
  function forceKillSni() {
    stopSupervisor();
    const res = shExec("pkill -9 -f " + shq(BIN + "/rstaspoof") + "; rm -f " + shq(ST + "/sni.pid") + " " + shq(ST + "/active.method"));
    state.activeCandidateIdx = -1;
    renderCandidates();
    showToast(res.ok ? "Force-killed any running rstaspoof" : "pkill may not exist on this device — reboot is the fallback", res.ok ? "ok" : "fail");
    checkActiveMethod();
  }

  // The binary tracks failures (ConnectionTracker/ShouldFailover) but never
  // acts on them — this is that missing piece, at the orchestration layer.
  function startSupervisor() {
    stopSupervisor();
    state.lastFailoverCheckLen = 0;
    // 25s, not 5s — every poll is a shell command, and on devices that
    // require confirming each one (some ReCommand/access-mode setups do),
    // a tight loop turns into a nonstop wall of prompts.
    state.supervisorTimer = setInterval(checkFailover, 25000);
  }
  function stopSupervisor() {
    if (state.supervisorTimer) { clearInterval(state.supervisorTimer); state.supervisorTimer = null; }
  }

  function checkFailover() {
    const logPath = LOG + "/sni.log";
    const res = shExec("tail -n 200 " + shq(logPath) + " 2>/dev/null");
    if (!res.ok) return;
    const lines = res.stdout.split("\n");
    const blockedCount = lines.filter((l) => l.indexOf("BLOCKED") !== -1).length;
    const okCount = lines.filter((l) => l.indexOf("SVR RESP") !== -1 || l.indexOf("BYPASS OK") !== -1).length;

    updateLiveStats(okCount, blockedCount);

    if (blockedCount >= FAILOVER_THRESHOLD && okCount === 0) {
      const valid = state.candidates.filter((c) => c.fakeSni && c.ip && c.port);
      if (valid.length < 2) return; // nothing to fail over to
      const currentPos = valid.indexOf(state.candidates[state.activeCandidateIdx]);
      const next = valid[(currentPos + 1) % valid.length];
      state.activeCandidateIdx = state.candidates.indexOf(next);
      showToast("Repeated BLOCKED — failing over to " + next.fakeSni, "fail");
      launchRstaspoof();
      renderCandidates();
    }
  }

  function updateLiveStats(ok, blocked) {
    el.sniLiveStats.classList.remove("hidden");
    el.sniLiveStats.innerHTML =
      "candidate: " + (state.candidates[state.activeCandidateIdx] ? state.candidates[state.activeCandidateIdx].fakeSni : "—") +
      " &nbsp;·&nbsp; <span class=\"ok\">server replied: " + ok + "</span>" +
      " &nbsp;·&nbsp; <span class=\"fail\">blocked: " + blocked + "</span>";
  }

  /* ============================================================
     Scanner
     ============================================================ */
  function runScan() {
    el.scanResults.innerHTML = "";
    const valid = state.candidates.filter((c) => c.fakeSni && c.ip && c.port);
    if (valid.length === 0) { showToast("Add candidates first", "fail"); return; }
    const reportLines = [];
    valid.forEach((c) => {
      const res = shExec("timeout 4 nc -z -w 4 " + shq(c.ip) + " " + shq(String(c.port)) + " 2>/dev/null && echo open || echo closed");
      const ok = res.ok && res.stdout.trim() === "open";
      reportLines.push((ok ? "[OK] " : "[FAIL] ") + c.fakeSni + " -> " + c.ip + " -> " + c.port);
      const row = document.createElement("div");
      row.className = "scan-result-row";
      row.innerHTML = "<span>" + escapeHtml(c.fakeSni) + " → " + escapeHtml(c.ip) + ":" + escapeHtml(String(c.port)) + "</span>" +
        "<span class=\"" + (ok ? "status-ok" : "status-fail") + "\">" + (ok ? "✓ reachable" : "✗ unreachable") + "</span>";
      el.scanResults.appendChild(row);
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    writeFileB64(LOG + "/scan-" + stamp + ".txt", reportLines.join("\n") + "\n");
    showToast("Scan complete", "ok");
  }

  /* ============================================================
     Converter — matches the exact transform demonstrated:
     address/port → 127.0.0.1:<listen>, SNI case-randomized,
     fingerprint → unsafe, two-stage fragmentation block added.
     ============================================================ */
  function randomizeCase(str) {
    return str.split("").map((ch) => {
      if (!/[a-zA-Z]/.test(ch)) return ch;
      return Math.random() < 0.5 ? ch.toUpperCase() : ch.toLowerCase();
    }).join("");
  }

  function runConvert() {
    const raw = $("convInput").value.trim();
    if (!raw) { showToast("Paste a config first", "fail"); return; }
    let config;
    try { config = JSON.parse(raw); }
    catch (e) { showToast("Not valid JSON — paste the full profile, not a link", "fail"); return; }

    const outbounds = config.outbounds || [];
    let target = outbounds.find((o) => o.tag === "proxy");
    if (!target) target = outbounds.find((o) => ["vless", "vmess", "trojan"].indexOf(o.protocol) !== -1);
    if (!target) { showToast("No proxy/vless/vmess/trojan outbound found in this config", "fail"); return; }

    const listenPort = parseInt($("sni-listenport").value, 10) || 40443;

    // rewrite the outbound's server address/port to the local forwarder
    if (target.settings) {
      if (Array.isArray(target.settings.servers)) {
        target.settings.servers.forEach((s) => { s.address = "127.0.0.1"; s.port = listenPort; });
      }
      if (Array.isArray(target.settings.vnext)) {
        target.settings.vnext.forEach((v) => { v.address = "127.0.0.1"; v.port = listenPort; });
      }
    }

    const ss = target.streamSettings || (target.streamSettings = {});
    if ($("convRandomizeCase").checked && ss.tlsSettings && ss.tlsSettings.serverName) {
      ss.tlsSettings.serverName = randomizeCase(ss.tlsSettings.serverName);
      ss.tlsSettings.fingerprint = "unsafe";
    }
    if ($("convFinalmask").checked) {
      ss.finalmask = {
        tcp: [
          { type: "fragment", settings: { packets: "tlshello", lengths: ["5", "94", "1"], delays: ["0"], maxSplit: "0" } },
          { type: "fragment", settings: { packets: "1-1", lengths: ["109", "1"], delays: ["1"], maxSplit: "355" } }
        ]
      };
    }

    $("convOutput").value = JSON.stringify(config, null, 2);
    showToast("Converted — points at 127.0.0.1:" + listenPort, "ok");
  }

  function copyConverted() {
    const text = $("convOutput").value;
    if (!text) { showToast("Nothing to copy yet", "fail"); return; }
    try {
      navigator.clipboard.writeText(text).then(
        () => showToast("Copied", "ok"),
        () => fallbackCopy(text)
      );
    } catch (e) {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    const ta = $("convOutput");
    ta.select();
    try { document.execCommand("copy"); showToast("Copied", "ok"); }
    catch (e) { showToast("Copy failed — select and copy manually", "fail"); }
  }

  /* ============================================================
     DNSTT
     ============================================================ */
  function startDnstt() {
    if (!state.binaries["dnstt-client"]) { showToast("dnstt-client binary not found — see bin/README.md", "fail"); return; }
    const doh = $("dnstt-doh").value.trim();
    const domain = $("dnstt-domain").value.trim();
    const pubkey = $("dnstt-pubkey").value.trim();
    const localPort = parseInt($("dnstt-localport").value, 10) || 7000;
    if (!doh || !domain || !pubkey) { showToast("DoH URL, domain, and public key are required", "fail"); return; }
    const cmd = BIN + "/dnstt-client -doh " + shq(doh) + " -pubkey " + shq(pubkey) + " " + shq(domain) + " 127.0.0.1:" + localPort;
    const result = startBackground("dnstt", cmd);
    showToast(result.ok ? "DNSTT started — local tunnel on 127.0.0.1:" + localPort : "Failed: " + (result.stderr || "").slice(0, 100), result.ok ? "ok" : "fail");
    checkActiveMethod();
  }

  /* ============================================================
     Psiphon + V2Ray
     ============================================================ */
  function startPsiphon() {
    if (!state.binaries.psiphon) { showToast("psiphon binary not found — see bin/README.md", "fail"); return; }
    if (!state.binaries.xray) { showToast("xray binary not found — see bin/README.md", "fail"); return; }
    const psiConfig = $("psi-config").value.trim();
    const socksPort = parseInt($("psi-socksport").value, 10) || 10808;
    const server = $("psi-server").value.trim();
    const port = parseInt($("psi-port").value, 10) || 443;
    const id = $("psi-id").value.trim();
    const sni = $("psi-sni").value.trim();
    if (!psiConfig || !server || !id) { showToast("Psiphon config path, Xray server, and UUID/password are required", "fail"); return; }

    const outbound = {
      tag: "proxy", protocol: "vless",
      settings: { vnext: [{ address: server, port: port, users: [{ id: id, encryption: "none" }] }] },
      streamSettings: { network: "tcp", security: "tls", tlsSettings: { serverName: sni || server }, sockopt: { dialerProxy: "psiphon-out" } }
    };
    const psiphonOutbound = { tag: "psiphon-out", protocol: "socks", settings: { servers: [{ address: "127.0.0.1", port: socksPort }] } };
    const inbound = state.root
      ? { tag: "in", port: PORTS.psiphonRootInbound, protocol: "dokodemo-door", settings: { network: "tcp", followRedirect: true }, sniffing: { enabled: true, destOverride: ["tls", "http"] } }
      : { tag: "in", port: PORTS.psiphonLocalProxy, protocol: "socks", settings: { udp: true } };

    writeFileB64(CFG + "/xray-psiphon.json", JSON.stringify({ log: { loglevel: "warning" }, inbounds: [inbound], outbounds: [outbound, psiphonOutbound] }, null, 2));

    const launchCmd = BIN + "/psiphon -config " + psiConfig + " > " + LOG + "/psiphon.log 2>&1 & echo $! > " + ST + "/psiphon-core.pid; sleep 3; " + BIN + "/xray run -c " + CFG + "/xray-psiphon.json";
    const result = startBackground("psiphon", launchCmd);
    showToast(result.ok ? "Psiphon+V2Ray starting (needs a few seconds)" : "Failed: " + (result.stderr || "").slice(0, 100), result.ok ? "ok" : "fail");
    checkActiveMethod();
  }

  /* ============================================================
     Routing — only meaningful for methods where THIS module runs
     the client (psiphon). SNI-spoof's real client is your own
     v2rayNG app, which handles its own system-wide routing.
     ============================================================ */
  function activeInboundPort() {
    const res = shExec("cat " + shq(ST + "/active.method") + " 2>/dev/null");
    const method = res.ok ? res.stdout.trim() : "";
    if (method === "psiphon") return state.root ? PORTS.psiphonRootInbound : PORTS.psiphonLocalProxy;
    return null;
  }
  function applyRouting() {
    const port = activeInboundPort();
    if (state.root) {
      if (!port) { showToast("Routing only applies to Psiphon+V2Ray in this version — SNI-spoof's client is your own v2rayNG app", "fail"); return; }
      if ($("routeAllTcp").checked) {
        shExec("iptables -t nat -N FREETUNNEL 2>/dev/null; iptables -t nat -F FREETUNNEL");
        shExec("iptables -t nat -A FREETUNNEL -p tcp --dport 443 -j REDIRECT --to-port " + port);
        shExec("iptables -t nat -A FREETUNNEL -p tcp --dport 80 -j REDIRECT --to-port " + port);
        shExec("iptables -t nat -C OUTPUT -j FREETUNNEL 2>/dev/null || iptables -t nat -A OUTPUT -j FREETUNNEL");
        showToast("Routing rules applied", "ok");
      }
    } else if ($("setSystemProxy").checked && port) {
      shExec("settings put global http_proxy 127.0.0.1:" + port);
      showToast("System proxy set to 127.0.0.1:" + port, "ok");
    }
    if ($("setPrivateDns").checked) {
      const host = $("privateDnsHost").value.trim();
      if (host) { shExec("settings put global private_dns_mode hostname"); shExec("settings put global private_dns_specifier " + shq(host)); }
    }
  }
  function clearRouting() {
    if (state.root) {
      shExec("iptables -t nat -D OUTPUT -j FREETUNNEL 2>/dev/null");
      shExec("iptables -t nat -F FREETUNNEL 2>/dev/null");
    } else {
      shExec("settings put global http_proxy :0");
    }
    shExec("settings put global private_dns_mode off");
    showToast("Routing cleared", "ok");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
