import logging
import threading
import time
from datetime import datetime, timezone

from flask import Flask, Response, jsonify, render_template, request

from . import aggregator, store
from .sources.config import SOURCES, SOURCE_BY_ID

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("android-app-hub")

app = Flask(__name__)

_refresh_state = {"in_progress": False, "last_run": None, "last_error": None}
_refresh_lock = threading.Lock()


def _run_refresh_background():
    with _refresh_lock:
        if _refresh_state["in_progress"]:
            return
        _refresh_state["in_progress"] = True
    try:
        log.info("Auto-refresh started (%d sources)...", len(SOURCES))
        started = time.time()
        results = aggregator.refresh_all()
        changed = sum(1 for r in results if r.get("changed_this_run"))
        errored = sum(1 for r in results if r.get("error"))
        log.info(
            "Auto-refresh finished in %.1fs — %d changed, %d errored",
            time.time() - started, changed, errored,
        )
        _refresh_state["last_error"] = None
    except Exception as exc:  # noqa: BLE001
        log.exception("Auto-refresh crashed")
        _refresh_state["last_error"] = str(exc)
    finally:
        _refresh_state["in_progress"] = False
        _refresh_state["last_run"] = time.time()


def start_background_refresh():
    """Kick off a refresh automatically every time the server starts,
    so the WebUI is up to date the moment the user opens it."""
    t = threading.Thread(target=_run_refresh_background, daemon=True)
    t.start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/sources")
def api_sources():
    out = []
    for src in SOURCES:
        result = aggregator.get_cached_or_placeholder(src)
        out.append({
            "id": result["id"],
            "title": result["title"],
            "description": result["description"],
            "tags": result["tags"],
            "owner": result["owner"],
            "repo": result["repo"],
            "html_url": result["html_url"],
            "item_count": result["item_count"],
            "category_count": result["category_count"],
            "pending": result.get("pending", False),
            "error": result.get("error"),
        })
    return jsonify({
        "sources": out,
        "refresh_in_progress": _refresh_state["in_progress"],
        "last_run": _refresh_state["last_run"],
    })


@app.route("/api/sources/<source_id>")
def api_source_detail(source_id):
    src = SOURCE_BY_ID.get(source_id)
    if not src:
        return jsonify({"error": "unknown source"}), 404
    result = aggregator.get_cached_or_placeholder(src)
    return jsonify(result)


@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    if _refresh_state["in_progress"]:
        return jsonify({"status": "already_running"}), 202
    start_background_refresh()
    return jsonify({"status": "started"}), 202


@app.route("/api/refresh/status")
def api_refresh_status():
    return jsonify(_refresh_state)


@app.route("/api/changelog")
def api_changelog():
    return jsonify({"entries": store.get_changelog(limit=100)})


@app.route("/api/changelog/<source_id>")
def api_changelog_source(source_id):
    return jsonify({"entries": store.get_changelog(source_id=source_id, limit=100)})


@app.route("/api/changelog/grouped")
def api_changelog_grouped():
    """Every change per source within the last N days (default 30) —
    each source keeps its own full window, so one noisy source can't
    push another source's older-but-still-recent changes out of view."""
    try:
        days = int(request.args.get("days", 30))
    except ValueError:
        days = 30
    days = max(1, min(days, 365))
    grouped = store.get_changelog_grouped(days=days)
    titled = {
        sid: {"title": SOURCE_BY_ID[sid]["title"], "entries": entries}
        for sid, entries in grouped.items()
        if sid in SOURCE_BY_ID
    }
    return jsonify({"days": days, "sources": titled})


def _build_export_markdown(days):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [f"# Android App Hub — Export", f"_Generated {now}_", ""]

    lines.append("## Catalog")
    lines.append("")
    for src in SOURCES:
        result = aggregator.get_cached_or_placeholder(src)
        lines.append(f"### {result['title']}")
        lines.append(f"<{result['html_url']}>")
        if result.get("description"):
            lines.append(f"_{result['description']}_")
        lines.append("")
        if result.get("error"):
            lines.append(f"(could not fetch: {result['error']})")
            lines.append("")
            continue
        for cat in result.get("categories", []):
            lines.append(f"**{cat['name']}**")
            lines.append("")
            for item in cat["items"]:
                name = item.get("name", "").strip()
                url = item.get("url", "").strip()
                desc = (item.get("desc") or "").strip()
                if url:
                    line = f"- [{name}]({url})"
                else:
                    line = f"- {name}"
                if desc:
                    line += f" — {desc}"
                lines.append(line)
            lines.append("")

    lines.append(f"## Changelog — last {days} days")
    lines.append("")
    grouped = store.get_changelog_grouped(days=days)
    if not grouped:
        lines.append("_No changes recorded in this window._")
    for src in SOURCES:
        entries = grouped.get(src["id"])
        if not entries:
            continue
        lines.append(f"### {src['title']}")
        lines.append("")
        for e in entries:
            lines.append(f"**{e['timestamp']}**")
            for a in e.get("added", []):
                lines.append(f"+ {a}")
            for r in e.get("removed", []):
                lines.append(f"- {r}")
            lines.append("")

    return "\n".join(lines)


@app.route("/api/export")
def api_export():
    try:
        days = int(request.args.get("days", 30))
    except ValueError:
        days = 30
    days = max(1, min(days, 365))
    text = _build_export_markdown(days)
    filename = f"android-app-hub-export-{datetime.now(timezone.utc).strftime('%Y%m%d')}.md"
    return Response(
        text,
        mimetype="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def create_app():
    start_background_refresh()
    return app
