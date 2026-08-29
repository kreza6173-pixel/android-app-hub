(() => {
  "use strict";

  const state = {
    sources: [],
    activeSourceId: null,
    activeSourceData: null,
    activeTab: "catalog",
    searchTerm: "",
    polling: null,
    changelogDays: 30,
  };

  const el = {
    sourceList: document.getElementById("source-list"),
    sourceCount: document.getElementById("source-count"),
    statusLine: document.getElementById("status-line"),
    refreshBtn: document.getElementById("refresh-btn"),
    exportBtn: document.getElementById("export-btn"),
    catalogHeader: document.getElementById("catalog-header"),
    catalogBody: document.getElementById("catalog-body"),
    changelogBody: document.getElementById("changelog-body"),
    viewCatalog: document.getElementById("view-catalog"),
    viewChangelog: document.getElementById("view-changelog"),
    searchBox: document.getElementById("search-box"),
    tabs: document.querySelectorAll(".tab"),
    dayChips: document.querySelectorAll(".day-chip"),
  };

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error(`${path} -> ${res.status}`);
    return res.json();
  }

  function timeAgo(iso) {
    if (!iso) return "never";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function escapeHtml(str) {
    return (str || "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Light markdown -> HTML for text pulled out of upstream READMEs
  // (so raw "**bold**" / "`code`" from a source's markdown doesn't show
  // up as literal asterisks/backticks in the UI). Input is already
  // HTML-escaped, so this only ever wraps existing safe text.
  function renderInlineMarkdown(escaped) {
    return escaped
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function mdText(raw) {
    return renderInlineMarkdown(escapeHtml(raw));
  }

  // Deterministic accent color per source, for the sidebar avatar.
  const AVATAR_PALETTE = ["#eda23c", "#6fa8dc", "#6fcf97", "#c98bdb", "#e0715c", "#7ad1c9", "#d9c25c"];
  function colorForId(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
  }
  function initialsFor(title) {
    const words = title.replace(/[—-].*$/, "").trim().split(/\s+/).filter(Boolean);
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  const EXTERNAL_ICON = `<svg class="external-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>`;
  const FOLDER_ICON = `<svg class="folder-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>`;
  const CHEVRON_ICON = `<svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>`;

  // ---------- Sidebar ----------

  function renderSidebar() {
    el.sourceCount.textContent = `(${state.sources.length})`;
    el.sourceList.innerHTML = state.sources.map((s) => `
      <div class="source-item ${s.id === state.activeSourceId ? "active" : ""}" data-id="${s.id}">
        <div class="source-avatar" style="background:${colorForId(s.id)}">${initialsFor(s.title)}</div>
        <div class="source-body">
          <div class="source-title-row">
            <span class="source-title">${escapeHtml(s.title)}</span>
            <span class="source-dot ${s.pending ? "" : "hidden"}" title="Fetching…"></span>
          </div>
          <div class="source-meta">
            <span>${s.item_count} items</span>
            <span>·</span>
            <span>${s.category_count} categories</span>
          </div>
          <div class="source-tags">
            ${(s.tags || []).map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}
          </div>
          ${s.error ? `<div class="diff-line remove" style="margin-top:4px;">${escapeHtml(s.error)}</div>` : ""}
        </div>
      </div>
    `).join("");

    el.sourceList.querySelectorAll(".source-item").forEach((node) => {
      node.addEventListener("click", () => selectSource(node.dataset.id));
    });
  }

  // ---------- Catalog ----------

  function itemMatchesSearch(item) {
    if (!state.searchTerm) return true;
    const hay = `${item.name} ${item.desc || ""}`.toLowerCase();
    return hay.includes(state.searchTerm);
  }

  function renderItemCard(item) {
    const isLink = !!item.url;
    const tag = isLink ? "a" : "div";
    const attrs = isLink ? `href="${escapeHtml(item.url)}" target="_blank" rel="noopener"` : "";
    return `
      <${tag} class="item-card ${isLink ? "is-link" : "no-link"}" ${attrs}>
        <div class="item-name">
          <span class="item-name-text">${mdText(item.name)}</span>
          ${item.stars != null ? `<span class="item-stars">★ ${item.stars}</span>` : (isLink ? EXTERNAL_ICON : "")}
        </div>
        ${item.desc ? `<div class="item-desc">${mdText(item.desc)}</div>` : ""}
      </${tag}>
    `;
  }

  function renderCatalog() {
    const data = state.activeSourceData;
    if (!data) {
      el.catalogHeader.innerHTML = "";
      el.catalogBody.innerHTML = `<div class="empty-state">Loading sources for the first time — this can take a few seconds.</div>`;
      return;
    }

    el.catalogHeader.innerHTML = `
      <h2>${escapeHtml(data.title)}</h2>
      <div class="sub">
        <span class="muted">${escapeHtml(data.description || "")}</span>
        <a class="source-link" href="${data.html_url}" target="_blank" rel="noopener">${EXTERNAL_ICON}${data.html_url.replace("https://", "")}</a>
      </div>
    `;

    if (data.error) {
      el.catalogBody.innerHTML = `<div class="empty-state">Could not fetch this source right now:<br><code>${escapeHtml(data.error)}</code></div>`;
      return;
    }

    const categories = (data.categories || []).map((cat) => {
      const items = cat.items.filter(itemMatchesSearch);
      return { ...cat, items };
    }).filter((cat) => cat.items.length > 0);

    if (categories.length === 0) {
      el.catalogBody.innerHTML = `<div class="empty-state">${state.searchTerm ? "No apps match your search." : "No categorized items were found in this source yet."}</div>`;
      return;
    }

    el.catalogBody.innerHTML = categories.map((cat, idx) => `
      <div class="category-block">
        <div class="category-title" data-idx="${idx}">
          ${FOLDER_ICON}
          ${escapeHtml(cat.name)}
          <span class="category-count">${cat.items.length}</span>
          ${CHEVRON_ICON}
        </div>
        <div class="item-grid" data-idx="${idx}">
          ${cat.items.map(renderItemCard).join("")}
        </div>
      </div>
    `).join("");

    el.catalogBody.querySelectorAll(".category-title").forEach((titleNode) => {
      titleNode.addEventListener("click", () => {
        titleNode.classList.toggle("collapsed");
        const grid = el.catalogBody.querySelector(`.item-grid[data-idx="${titleNode.dataset.idx}"]`);
        grid.classList.toggle("collapsed");
      });
    });
  }

  async function selectSource(id) {
    state.activeSourceId = id;
    renderSidebar();
    el.catalogBody.innerHTML = `<div class="empty-state">Loading…</div>`;
    try {
      state.activeSourceData = await api(`/api/sources/${id}`);
    } catch (e) {
      state.activeSourceData = { title: id, error: String(e), categories: [] };
    }
    renderCatalog();
  }

  // ---------- Changelog (grouped by source, day-filtered) ----------

  async function renderChangelog() {
    el.changelogBody.innerHTML = `<div class="empty-state">Loading…</div>`;
    const data = await api(`/api/changelog/grouped?days=${state.changelogDays}`);
    const sourceIds = Object.keys(data.sources || {});

    if (sourceIds.length === 0) {
      el.changelogBody.innerHTML = `<div class="empty-state">No changes recorded in the last ${state.changelogDays} days.</div>`;
      return;
    }

    // Preserve sidebar source order rather than object key order.
    const orderedIds = state.sources.map((s) => s.id).filter((id) => sourceIds.includes(id));

    el.changelogBody.innerHTML = orderedIds.map((sid) => {
      const group = data.sources[sid];
      return `
        <div class="changelog-source-block">
          <div class="changelog-source-header" data-sid="${sid}">
            <span class="changelog-source-title">${escapeHtml(group.title)}</span>
            <span class="changelog-source-count">${group.entries.length} change${group.entries.length === 1 ? "" : "s"}</span>
            ${CHEVRON_ICON}
          </div>
          <div class="changelog-entries" data-sid="${sid}">
            ${group.entries.map((e) => `
              <div class="changelog-entry">
                <div class="changelog-entry-head">
                  <span class="changelog-time">${timeAgo(e.timestamp)} — ${new Date(e.timestamp).toLocaleString()}</span>
                </div>
                ${e.added.map((l) => `<div class="diff-line add">+ ${escapeHtml(l)}</div>`).join("")}
                ${e.removed.map((l) => `<div class="diff-line remove">- ${escapeHtml(l)}</div>`).join("")}
              </div>
            `).join("")}
          </div>
        </div>
      `;
    }).join("");

    el.changelogBody.querySelectorAll(".changelog-source-header").forEach((header) => {
      header.addEventListener("click", () => {
        header.classList.toggle("collapsed");
        const entries = el.changelogBody.querySelector(`.changelog-entries[data-sid="${header.dataset.sid}"]`);
        entries.classList.toggle("collapsed");
      });
    });
  }

  el.dayChips.forEach((chip) => {
    chip.addEventListener("click", () => {
      el.dayChips.forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.changelogDays = parseInt(chip.dataset.days, 10);
      renderChangelog();
    });
  });

  // ---------- Export ----------

  el.exportBtn.addEventListener("click", () => {
    window.location.href = `/api/export?days=${state.changelogDays}`;
  });

  // ---------- Tabs / search / refresh ----------

  function setTab(tab) {
    state.activeTab = tab;
    el.tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    el.viewCatalog.classList.toggle("hidden", tab !== "catalog");
    el.viewChangelog.classList.toggle("hidden", tab !== "changelog");
    if (tab === "changelog") renderChangelog();
  }

  el.tabs.forEach((t) => t.addEventListener("click", () => setTab(t.dataset.tab)));

  el.searchBox.addEventListener("input", (e) => {
    state.searchTerm = e.target.value.trim().toLowerCase();
    if (state.activeTab === "catalog") renderCatalog();
  });

  el.refreshBtn.addEventListener("click", async () => {
    await api("/api/refresh", { method: "POST" });
    startPolling(true);
  });

  // ---------- Polling / bootstrap ----------

  async function loadSources() {
    const data = await api("/api/sources");
    state.sources = data.sources;
    if (!state.activeSourceId && state.sources.length) {
      state.activeSourceId = state.sources[0].id;
    }
    renderSidebar();
    return data;
  }

  async function refreshActiveSourceIfNeeded() {
    if (!state.activeSourceId) return;
    try {
      state.activeSourceData = await api(`/api/sources/${state.activeSourceId}`);
      if (state.activeTab === "catalog") renderCatalog();
    } catch (e) { /* keep previous data */ }
  }

  function startPolling(forceImmediate) {
    if (state.polling) clearInterval(state.polling);
    const tick = async () => {
      const data = await loadSources();
      if (data.refresh_in_progress) {
        el.statusLine.textContent = "refreshing sources…";
        el.statusLine.classList.add("busy");
        el.refreshBtn.classList.add("spinning");
      } else {
        el.statusLine.textContent = data.last_run
          ? `last checked ${timeAgo(new Date(data.last_run * 1000).toISOString())}`
          : "idle";
        el.statusLine.classList.remove("busy");
        el.refreshBtn.classList.remove("spinning");
        await refreshActiveSourceIfNeeded();
        if (state.activeTab === "changelog") renderChangelog();
        clearInterval(state.polling);
        state.polling = setInterval(tick, 15000);
      }
    };
    if (forceImmediate) tick();
    state.polling = setInterval(tick, 1500);
    tick();
  }

  (async function init() {
    await loadSources();
    if (state.activeSourceId) await selectSource(state.activeSourceId);
    startPolling(false);
  })();
})();
