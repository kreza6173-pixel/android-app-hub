(() => {
  "use strict";

  const state = {
    sources: [],
    activeSourceId: null,
    activeSourceData: null,
    activeTab: "catalog",
    searchTerm: "",
    polling: null,
  };

  const el = {
    sourceList: document.getElementById("source-list"),
    sourceCount: document.getElementById("source-count"),
    statusLine: document.getElementById("status-line"),
    refreshBtn: document.getElementById("refresh-btn"),
    catalogHeader: document.getElementById("catalog-header"),
    catalogBody: document.getElementById("catalog-body"),
    changelogBody: document.getElementById("changelog-body"),
    viewCatalog: document.getElementById("view-catalog"),
    viewChangelog: document.getElementById("view-changelog"),
    searchBox: document.getElementById("search-box"),
    tabs: document.querySelectorAll(".tab"),
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

  // ---------- Sidebar ----------

  function renderSidebar() {
    el.sourceCount.textContent = `(${state.sources.length})`;
    el.sourceList.innerHTML = state.sources.map((s) => `
      <div class="source-item ${s.id === state.activeSourceId ? "active" : ""}" data-id="${s.id}">
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
        <a class="source-link" href="${data.html_url}" target="_blank" rel="noopener">${data.html_url.replace("https://", "")} ↗</a>
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
          <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>
          ${escapeHtml(cat.name)}
          <span class="category-count">${cat.items.length}</span>
        </div>
        <div class="item-grid" data-idx="${idx}">
          ${cat.items.map((item) => `
            <a class="item-card" href="${item.url || '#'}" target="${item.url ? '_blank' : '_self'}" rel="noopener">
              <div class="item-name">
                <span>${escapeHtml(item.name)}</span>
                ${item.stars != null ? `<span class="item-stars">★ ${item.stars}</span>` : ""}
              </div>
              ${item.desc ? `<div class="item-desc">${escapeHtml(item.desc)}</div>` : ""}
            </a>
          `).join("")}
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

  // ---------- Changelog ----------

  function sourceTitleFor(id) {
    const s = state.sources.find((x) => x.id === id);
    return s ? s.title : id;
  }

  async function renderChangelog() {
    el.changelogBody.innerHTML = `<div class="empty-state">Loading…</div>`;
    const { entries } = await api("/api/changelog");
    if (!entries.length) {
      el.changelogBody.innerHTML = `<div class="empty-state">No changes detected yet. Changes appear here after a source's content differs from the previous check.</div>`;
      return;
    }
    el.changelogBody.innerHTML = entries.map((e) => `
      <div class="changelog-entry">
        <div class="changelog-entry-head">
          <span class="changelog-source">${escapeHtml(sourceTitleFor(e.source_id))}</span>
          <span class="changelog-time">${timeAgo(e.timestamp)}</span>
        </div>
        ${e.added.map((l) => `<div class="diff-line add">+ ${escapeHtml(l)}</div>`).join("")}
        ${e.removed.map((l) => `<div class="diff-line remove">- ${escapeHtml(l)}</div>`).join("")}
      </div>
    `).join("");
  }

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
