/* ============================================================
   Privacy Audit — app.js
   All device access goes through window.Shizuku.exec /
   execWithOptions, exposed by the Shevery ADB Modules WebUI
   bridge (module.prop has usesShellBridge=true).
   ============================================================ */

(function () {
  "use strict";

  /* ---------- permission catalogue ---------- */
  // short name (as it appears after "android.permission.") -> category + label
  const PERM_MAP = {
    CAMERA:                     { cat: "camera",   label: "Camera" },
    RECORD_AUDIO:                { cat: "mic",      label: "Microphone" },
    ACCESS_FINE_LOCATION:        { cat: "location", label: "Precise location" },
    ACCESS_COARSE_LOCATION:      { cat: "location", label: "Approximate location" },
    ACCESS_BACKGROUND_LOCATION:  { cat: "location", label: "Background location", bg: true },
    READ_EXTERNAL_STORAGE:       { cat: "storage",  label: "Read storage" },
    WRITE_EXTERNAL_STORAGE:      { cat: "storage",  label: "Write storage" },
    READ_MEDIA_IMAGES:           { cat: "storage",  label: "Read photos" },
    READ_MEDIA_VIDEO:            { cat: "storage",  label: "Read videos" },
    READ_MEDIA_AUDIO:            { cat: "storage",  label: "Read audio" },
    MANAGE_EXTERNAL_STORAGE:     { cat: "storage",  label: "All files access", full: true, appOp: true }
  };
  const PERM_LIST = Object.keys(PERM_MAP);

  // packages that are never eligible for revoke/grant/freeze, no matter what.
  const PROTECTED_PKGS = [
    "android",
    "com.android.systemui",
    "com.android.settings",
    "com.android.shell",
    "com.android.providers.settings",
    "com.android.providers.media",
    "com.google.android.gms",
    "com.google.android.gsf"
  ];

  const STANDBY_INACTIVE_HINTS = ["rare", "restricted", "never", "40", "45", "50"];

  /* ---------- state ---------- */
  const state = {
    bridgeReady: false,
    root: false,
    moduleInfo: null,
    apps: [],            // [{pkg, bucket, inactive, perms:{SHORT:true/false}}]
    scanning: false,
    includeSystem: false,
    inactiveOnly: false,
    activeTab: "camera",
    consoleEntries: []
  };

  /* ---------- dom refs ---------- */
  const $ = (id) => document.getElementById(id);
  const el = {
    chipMode: $("chipMode"),
    chipAccess: $("chipAccess"),
    bridgeWarning: $("bridgeWarning"),
    mainContent: $("mainContent"),
    gaugeFill: $("gaugeFill"),
    gaugeSweep: $("gaugeSweep"),
    gaugeScore: $("gaugeScore"),
    heroStatus: $("heroStatus"),
    heroSub: $("heroSub"),
    btnScan: $("btnScan"),
    toggleSystem: $("toggleSystem"),
    toggleInactiveOnly: $("toggleInactiveOnly"),
    scanProgress: $("scanProgress"),
    scanElapsed: $("scanElapsed"),
    tabs: $("tabs"),
    tabRoot: $("tabRoot"),
    listEmpty: $("listEmpty"),
    appList: $("appList"),
    console: $("console"),
    consoleHandle: $("consoleHandle"),
    consoleBody: $("consoleBody"),
    consoleCount: $("consoleCount"),
    modalBackdrop: $("modalBackdrop"),
    modalTitle: $("modalTitle"),
    modalBody: $("modalBody"),
    modalCancel: $("modalCancel"),
    modalConfirm: $("modalConfirm"),
    toast: $("toast")
  };

  const GAUGE_CIRC = 2 * Math.PI * 86; // r=86

  /* ============================================================
     Shizuku bridge helpers
     ============================================================ */
  function bridgeAvailable() {
    return typeof window.Shizuku !== "undefined" && window.Shizuku !== null;
  }

  function shExec(cmd, opts) {
    if (!bridgeAvailable()) {
      return { ok: false, exitCode: -1, stdout: "", stderr: "window.Shizuku is not available", timedOut: false };
    }
    let raw;
    try {
      raw = opts
        ? window.Shizuku.execWithOptions(cmd, JSON.stringify(opts))
        : window.Shizuku.exec(cmd);
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

  /* ============================================================
     Init
     ============================================================ */
  function init() {
    if (!bridgeAvailable()) {
      el.bridgeWarning.classList.remove("hidden");
      el.mainContent.classList.add("hidden");
      el.chipMode.textContent = "MODE: N/A";
      return;
    }
    state.bridgeReady = true;

    try {
      state.moduleInfo = JSON.parse(window.Shizuku.getModuleInfo());
    } catch (e) {
      state.moduleInfo = null;
    }
    if (state.moduleInfo) {
      el.chipAccess.textContent = "ACCESS: " + (state.moduleInfo.accessMode || "?").toUpperCase();
      el.chipAccess.classList.add(state.moduleInfo.accessMode === "full" ? "chip-ok" : "chip-warn");
    }

    const idRes = shExec("id");
    if (idRes.ok && /uid=0\(root\)/.test(idRes.stdout)) {
      state.root = true;
      el.chipMode.textContent = "MODE: ROOT";
      el.chipMode.classList.add("chip-warn");
      el.tabRoot.classList.remove("hidden");
    } else if (idRes.ok) {
      el.chipMode.textContent = "MODE: ADB";
      el.chipMode.classList.add("chip-ok");
    } else {
      el.chipMode.textContent = "MODE: UNKNOWN";
    }

    bindEvents();
    renderConsole();
  }

  function bindEvents() {
    el.btnScan.addEventListener("click", runScan);
    el.toggleSystem.addEventListener("change", (e) => { state.includeSystem = e.target.checked; });
    el.toggleInactiveOnly.addEventListener("change", (e) => {
      state.inactiveOnly = e.target.checked;
      renderList();
    });
    el.tabs.addEventListener("click", (e) => {
      const btn = e.target.closest(".tab");
      if (!btn || btn.classList.contains("hidden")) return;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      renderList();
    });
    el.consoleHandle.addEventListener("click", () => el.console.classList.toggle("open"));
    el.modalCancel.addEventListener("click", closeModal);
  }

  /* ============================================================
     Scanning
     ============================================================ */
  function buildScanScript() {
    const permsRegex = PERM_LIST.join("|");
    return [
      "#!/system/bin/sh",
      'if [ "$INCLUDE_SYSTEM" = "1" ]; then',
      '  PKGS=$(pm list packages 2>/dev/null | sed "s/^package://")',
      "else",
      '  PKGS=$(pm list packages -3 2>/dev/null | sed "s/^package://")',
      "fi",
      "for pkg in $PKGS; do",
      '  DUMP=$(dumpsys package "$pkg" 2>/dev/null)',
      '  MATCHES=$(echo "$DUMP" | grep -E "android\\.permission\\.(' + permsRegex + '): granted=")',
      "  LINE=$(echo \"$MATCHES\" | sed -E 's/^[[:space:]]*android\\.permission\\.([A-Z_]+): granted=(true|false).*/\\1=\\2/' | tr '\\n' ',')",
      '  BUCKET=$(am get-standby-bucket "$pkg" 2>/dev/null | tr -d "\\r\\n")',
      '  echo "PKG::${pkg}::${BUCKET}::${LINE}"',
      "done",
      'echo "SCAN_DONE"'
    ].join("\n");
  }

  function runScan() {
    if (state.scanning) return;
    state.scanning = true;
    el.btnScan.disabled = true;
    el.scanProgress.classList.remove("hidden");
    el.gaugeSweep.classList.add("spinning");
    el.heroStatus.textContent = "Scanning…";
    el.heroSub.textContent = state.includeSystem
      ? "Including system apps — this takes longer."
      : "Checking third-party apps for sensitive grants.";

    const started = Date.now();
    const tick = setInterval(() => {
      el.scanElapsed.textContent = " (" + Math.floor((Date.now() - started) / 1000) + "s)";
    }, 500);

    // Yield one frame so the "scanning" UI actually paints before the
    // blocking bridge call runs.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const script = buildScanScript();
        const result = shExec(script, {
          timeoutSeconds: 110,
          env: { INCLUDE_SYSTEM: state.includeSystem ? "1" : "0" }
        });

        clearInterval(tick);
        state.scanning = false;
        el.btnScan.disabled = false;
        el.scanProgress.classList.add("hidden");
        el.gaugeSweep.classList.remove("spinning");

        if (!result.ok && !result.stdout) {
          el.heroStatus.textContent = "Scan failed";
          el.heroSub.textContent = (result.stderr || "Unknown error").slice(0, 160);
          showToast("Scan failed — see console", "fail");
          return;
        }

        state.apps = parseScanOutput(result.stdout);
        finishScan();
      }, 30);
    });
  }

  function parseScanOutput(stdout) {
    const apps = [];
    const lines = (stdout || "").split("\n");
    for (const line of lines) {
      if (!line.startsWith("PKG::")) continue;
      const parts = line.split("::");
      if (parts.length < 4) continue;
      const pkg = parts[1];
      const bucketRaw = (parts[2] || "").toLowerCase();
      const permsCsv = parts.slice(3).join("::"); // in case perm names ever contain '::'
      const perms = {};
      permsCsv.split(",").forEach((tok) => {
        if (!tok) return;
        const eq = tok.indexOf("=");
        if (eq === -1) return;
        const name = tok.slice(0, eq);
        const val = tok.slice(eq + 1) === "true";
        if (PERM_MAP[name]) perms[name] = val;
      });
      const inactive = STANDBY_INACTIVE_HINTS.some((h) => bucketRaw.indexOf(h) !== -1);
      apps.push({ pkg, bucket: parts[2] || "", inactive, perms });
    }
    return apps;
  }

  function finishScan() {
    const scored = computeScore(state.apps);
    animateGauge(scored.score);
    el.heroStatus.textContent = scored.label;
    el.heroSub.textContent = state.apps.length + " apps scanned · " +
      scored.grantedApps + " with sensitive grants" +
      (scored.bgLocationApps ? " · " + scored.bgLocationApps + " tracking location in the background" : "");
    showToast("Scan complete — " + state.apps.length + " apps", "ok");
    renderList();
  }

  function computeScore(apps) {
    let riskPoints = 0;
    let grantedApps = 0;
    let bgLocationApps = 0;
    const maxPerApp = 4; // camera, mic, location, storage — one point each if any perm in that category is granted
    apps.forEach((app) => {
      const cats = { camera: false, mic: false, location: false, storage: false };
      let appHasGrant = false;
      Object.keys(app.perms).forEach((name) => {
        if (!app.perms[name]) return;
        const meta = PERM_MAP[name];
        if (!meta) return;
        cats[meta.cat] = true;
        appHasGrant = true;
        if (meta.bg) bgLocationApps++;
      });
      if (appHasGrant) grantedApps++;
      riskPoints += Object.values(cats).filter(Boolean).length;
    });
    const maxPossible = Math.max(apps.length * maxPerApp, 1);
    const score = Math.max(0, Math.round(100 - (100 * riskPoints) / maxPossible));
    let label;
    if (apps.length === 0) label = "No apps scanned";
    else if (score >= 85) label = "Privacy Index: " + score + "% — Safe";
    else if (score >= 60) label = "Privacy Index: " + score + "% — Fair";
    else label = "Privacy Index: " + score + "% — Exposed";
    return { score, label, grantedApps, bgLocationApps };
  }

  function animateGauge(score) {
    const offset = GAUGE_CIRC - (GAUGE_CIRC * score) / 100;
    el.gaugeFill.style.strokeDasharray = String(GAUGE_CIRC);
    el.gaugeFill.style.strokeDashoffset = String(offset);
    el.gaugeFill.style.stroke = score >= 85 ? "var(--phosphor)" : score >= 60 ? "var(--amber)" : "var(--red)";
    let cur = 0;
    const dur = 700, startT = performance.now();
    function step(t) {
      const p = Math.min(1, (t - startT) / dur);
      cur = Math.round(score * p);
      el.gaugeScore.textContent = cur;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ============================================================
     Rendering the app list (chunked for smooth scrolling)
     ============================================================ */
  function filteredApps() {
    const cat = state.activeTab;
    if (cat === "root") return [];
    return state.apps.filter((app) => {
      if (state.inactiveOnly && !app.inactive) return false;
      return Object.keys(app.perms).some((name) => PERM_MAP[name] && PERM_MAP[name].cat === cat);
    });
  }

  function updateTabCounts() {
    ["camera", "mic", "location", "storage"].forEach((cat) => {
      const n = state.apps.filter((app) =>
        Object.keys(app.perms).some((name) => app.perms[name] && PERM_MAP[name] && PERM_MAP[name].cat === cat)
      ).length;
      const badge = $("cnt-" + cat);
      if (badge) badge.textContent = n ? String(n) : "";
    });
  }

  function renderList() {
    updateTabCounts();
    el.appList.innerHTML = "";

    if (state.activeTab === "root") {
      renderRootTools();
      el.listEmpty.classList.add("hidden");
      return;
    }

    const apps = filteredApps();
    if (apps.length === 0) {
      el.listEmpty.classList.remove("hidden");
      el.listEmpty.textContent = state.apps.length === 0
        ? "Run a scan to see results here."
        : "Nothing in this category.";
      return;
    }
    el.listEmpty.classList.add("hidden");

    // progressive/chunked rendering so a long list doesn't jank the UI thread
    const CHUNK = 14;
    let i = 0;
    function renderChunk() {
      const frag = document.createDocumentFragment();
      const end = Math.min(i + CHUNK, apps.length);
      for (; i < end; i++) frag.appendChild(buildAppRow(apps[i]));
      el.appList.appendChild(frag);
      if (i < apps.length) requestAnimationFrame(renderChunk);
    }
    renderChunk();
  }

  function buildAppRow(app) {
    const li = document.createElement("li");
    li.className = "app-row";

    const avatar = document.createElement("div");
    avatar.className = "app-avatar";
    avatar.textContent = app.pkg.replace(/^[a-z0-9]+\./, "").charAt(0).toUpperCase() || "?";
    li.appendChild(avatar);

    const info = document.createElement("div");
    info.className = "app-info";
    const pkgEl = document.createElement("div");
    pkgEl.className = "app-pkg";
    pkgEl.textContent = app.pkg;
    info.appendChild(pkgEl);

    const badges = document.createElement("div");
    badges.className = "app-badges";
    if (app.inactive) {
      const b = document.createElement("span");
      b.className = "badge badge-idle";
      b.textContent = "INACTIVE";
      badges.appendChild(b);
    }
    if (app.perms.ACCESS_BACKGROUND_LOCATION) {
      const b = document.createElement("span");
      b.className = "badge badge-risk";
      b.textContent = "BG LOCATION";
      badges.appendChild(b);
    }
    if (app.perms.MANAGE_EXTERNAL_STORAGE) {
      const b = document.createElement("span");
      b.className = "badge badge-warn";
      b.textContent = "ALL FILES";
      badges.appendChild(b);
    }
    if (PROTECTED_PKGS.indexOf(app.pkg) !== -1) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "PROTECTED";
      badges.appendChild(b);
    }
    info.appendChild(badges);
    li.appendChild(info);

    // relevant permission(s) for the active tab on this app
    const catPerms = Object.keys(app.perms).filter(
      (name) => PERM_MAP[name] && PERM_MAP[name].cat === state.activeTab
    );
    const primary = catPerms.find((n) => app.perms[n]) || catPerms[0];

    const sw = document.createElement("div");
    sw.className = "switch" + (app.perms[primary] ? " on" : "") + (PROTECTED_PKGS.indexOf(app.pkg) !== -1 ? " protected" : "");
    sw.title = primary ? PERM_MAP[primary].label : "";
    if (PROTECTED_PKGS.indexOf(app.pkg) === -1 && primary) {
      sw.addEventListener("click", () => togglePermission(app, primary, sw));
    }
    li.appendChild(sw);

    return li;
  }

  function togglePermission(app, permName, switchEl) {
    const meta = PERM_MAP[permName];
    const currentlyGranted = !!app.perms[permName];
    const action = currentlyGranted ? "revoke" : "grant";

    const doIt = () => {
      switchEl.classList.add("pending");
      const cmd = buildPermCommand(app.pkg, permName, action);
      const result = shExec(cmd);
      switchEl.classList.remove("pending");
      if (result.ok) {
        app.perms[permName] = !currentlyGranted;
        switchEl.classList.toggle("on", app.perms[permName]);
        showToast(
          (action === "revoke" ? "Revoked " : "Granted ") + meta.label + " for " + shortPkg(app.pkg),
          "ok"
        );
        updateTabCounts();
      } else {
        showToast("Failed: " + (result.stderr || "unknown error").slice(0, 120), "fail");
      }
    };

    if (action === "grant" || state.includeSystem) {
      confirmModal(
        action === "grant" ? "Grant permission" : "Revoke on a system app",
        (action === "grant"
          ? "Grant " + meta.label + " back to " + app.pkg + "?"
          : app.pkg + " looks like a system app. Revoking permissions from system apps can break device features. Continue?"),
        doIt
      );
    } else {
      doIt();
    }
  }

  function buildPermCommand(pkg, permName, action) {
    const full = "android.permission." + permName;
    const meta = PERM_MAP[permName];
    if (meta.appOp) {
      // special/all-files access is controlled through appops, not pm revoke
      return "cmd appops set " + shq(pkg) + " " + permName + " " + (action === "revoke" ? "ignore" : "allow");
    }
    return "pm " + action + " " + shq(pkg) + " " + full;
  }

  function shq(s) {
    // package names are already validated by the package manager (no shell
    // metacharacters), but quote defensively anyway.
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
  }

  function shortPkg(pkg) {
    const parts = pkg.split(".");
    return parts.length > 1 ? parts[parts.length - 1] : pkg;
  }

  /* ============================================================
     Root Tools tab (only shown when uid=0 was detected)
     ============================================================ */
  function renderRootTools() {
    const wrap = document.createElement("li");
    wrap.style.listStyle = "none";

    const notice = document.createElement("div");
    notice.className = "badge-warn";
    notice.style.cssText = "font-family:var(--mono);font-size:12px;color:var(--amber);border:1px solid rgba(245,185,77,0.4);border-radius:8px;padding:10px 12px;margin-bottom:10px;display:block;";
    notice.textContent = "Root-only tools. These act immediately on the device — protected packages are still blocked, but everything else runs for real.";
    el.appList.appendChild(notice);

    const inactiveApps = state.apps.filter((a) => a.inactive && PROTECTED_PKGS.indexOf(a.pkg) === -1);
    if (inactiveApps.length === 0) {
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.textContent = state.apps.length ? "No inactive apps with sensitive grants found." : "Run a scan first.";
      el.appList.appendChild(empty);
      return;
    }

    inactiveApps.forEach((app) => {
      const row = document.createElement("li");
      row.className = "app-row";

      const info = document.createElement("div");
      info.className = "app-info";
      const pkgEl = document.createElement("div");
      pkgEl.className = "app-pkg";
      pkgEl.textContent = app.pkg;
      info.appendChild(pkgEl);
      const sub = document.createElement("div");
      sub.className = "badges app-badges";
      sub.style.color = "var(--muted)";
      sub.style.fontSize = "10px";
      sub.textContent = "standby: " + (app.bucket || "?");
      info.appendChild(sub);
      row.appendChild(info);

      const freeze = document.createElement("button");
      freeze.className = "row-btn danger";
      freeze.textContent = "Freeze";
      freeze.addEventListener("click", () => rootAction(app.pkg, "freeze"));
      row.appendChild(freeze);

      const stop = document.createElement("button");
      stop.className = "row-btn";
      stop.textContent = "Force-stop";
      stop.addEventListener("click", () => rootAction(app.pkg, "forcestop"));
      row.appendChild(stop);

      el.appList.appendChild(row);
    });
  }

  function rootAction(pkg, action) {
    if (PROTECTED_PKGS.indexOf(pkg) !== -1) {
      showToast("This package is protected", "fail");
      return;
    }
    const cmds = {
      freeze: "pm disable-user --user 0 " + shq(pkg),
      unfreeze: "pm enable " + shq(pkg),
      forcestop: "am force-stop " + shq(pkg)
    };
    const labels = { freeze: "Freeze " + pkg, unfreeze: "Unfreeze " + pkg, forcestop: "Force-stop " + pkg };
    confirmModal(
      labels[action],
      action === "freeze"
        ? "Freezing disables " + pkg + " until you re-enable it from the same tools or the app store. Continue?"
        : action === "forcestop"
        ? "Force-stopping " + pkg + " kills it immediately. Continue?"
        : "Re-enable " + pkg + "?",
      () => {
        const result = shExec(cmds[action]);
        showToast(result.ok ? labels[action] + " — done" : "Failed: " + (result.stderr || "").slice(0, 100), result.ok ? "ok" : "fail");
      }
    );
  }

  /* ============================================================
     Modal / toast / console
     ============================================================ */
  let pendingConfirm = null;
  function confirmModal(title, body, onConfirm) {
    el.modalTitle.textContent = title;
    el.modalBody.textContent = body;
    pendingConfirm = onConfirm;
    el.modalBackdrop.classList.remove("hidden");
  }
  function closeModal() {
    el.modalBackdrop.classList.add("hidden");
    pendingConfirm = null;
  }
  el.modalConfirm.addEventListener("click", () => {
    const fn = pendingConfirm;
    closeModal();
    if (fn) fn();
  });
  el.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === el.modalBackdrop) closeModal();
  });

  let toastTimer = null;
  function showToast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = "toast " + (kind || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 3200);
  }

  function renderConsole() {
    el.consoleCount.textContent = state.consoleEntries.length + " entries";
    const frag = document.createDocumentFragment();
    state.consoleEntries.slice(-40).forEach((entry) => {
      const div = document.createElement("div");
      div.className = "console-line " + (entry.result.ok ? "ok" : "fail");
      const hh = entry.time.toTimeString().slice(0, 8);
      const cmdPreview = entry.cmd.length > 90 ? entry.cmd.slice(0, 90) + "…" : entry.cmd;
      div.innerHTML =
        '<span class="t">' + hh + "</span>" +
        '<span class="cmd">$ ' + escapeHtml(cmdPreview) + "</span>";
      frag.appendChild(div);
    });
    el.consoleBody.innerHTML = "";
    el.consoleBody.appendChild(frag);
    el.consoleBody.scrollTop = el.consoleBody.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  document.addEventListener("DOMContentLoaded", init);
})();
