import json
import logging

from . import store
from .sources import fetchers
from .sources.config import SOURCES
from .sources.parser import parse_awesome_markdown, parse_json_index

log = logging.getLogger("android-app-hub")

_last_result_cache = {}


def _summary(parsed):
    item_count = sum(len(c["items"]) for c in parsed["categories"]) + len(parsed.get("uncategorized", []))
    return {"item_count": item_count, "category_count": len(parsed["categories"])}


def fetch_and_parse_source(src):
    """Fetch one source per its `kind`, parse it, snapshot it, and return
    a ready-to-serve dict. Raises fetchers.FetchError on failure."""
    kind = src["kind"]
    owner = src["owner"]
    repo = src.get("repo")

    if kind == "json_index":
        try:
            raw = fetchers.fetch_json_file(owner, repo, src["json_path"])
            raw_text = json.dumps(raw, sort_keys=True, ensure_ascii=False)
            entries = raw if isinstance(raw, list) else raw.get("apps") or raw.get("repos") or []
            parsed = parse_json_index(entries, category_field=src.get("category_field", "category"))
            meta = {"kind": "json_index", "path": src["json_path"]}
        except fetchers.FetchError:
            if not src.get("readme_fallback"):
                raise
            raw_text = fetchers.fetch_readme(owner, repo)
            parsed = parse_awesome_markdown(raw_text)
            meta = {"kind": "readme", "fallback": True}

    elif kind == "readme":
        raw_text = fetchers.fetch_readme(owner, repo)
        parsed = parse_awesome_markdown(raw_text)
        meta = {"kind": "readme"}

    elif kind == "file":
        raw_text = fetchers.fetch_file_raw(owner, repo, src["file_path"])
        parsed = parse_awesome_markdown(raw_text)
        meta = {"kind": "file", "path": src["file_path"]}

    elif kind == "user_profile":
        repos = fetchers.fetch_user_repos(owner)
        raw_text = json.dumps(
            [{"name": r["full_name"], "desc": r.get("description"), "pushed_at": r.get("pushed_at")} for r in repos],
            sort_keys=True,
        )
        buckets = {}
        order = []
        for r in repos:
            lang = r.get("language") or "Other"
            if lang not in buckets:
                buckets[lang] = []
                order.append(lang)
            buckets[lang].append({
                "name": r["name"],
                "url": r.get("html_url", ""),
                "desc": r.get("description") or "",
                "stars": r.get("stargazers_count"),
            })
        parsed = {"categories": [{"name": l, "items": buckets[l]} for l in order], "uncategorized": []}
        meta = {"kind": "user_profile", "repo_count": len(repos)}

    else:
        raise ValueError(f"Unknown source kind: {kind}")

    summary = _summary(parsed)
    changed = store.record_snapshot(src["id"], raw_text, summary, extra=meta)

    result = {
        "id": src["id"],
        "title": src["title"],
        "description": src["description"],
        "tags": src.get("tags", []),
        "owner": owner,
        "repo": repo,
        "html_url": f"https://github.com/{owner}/{repo}" if repo else f"https://github.com/{owner}",
        "categories": parsed["categories"],
        "uncategorized": parsed.get("uncategorized", []),
        "item_count": summary["item_count"],
        "category_count": summary["category_count"],
        "changed_this_run": changed,
        "meta": meta,
    }
    _last_result_cache[src["id"]] = result
    return result


def refresh_all(sources=None):
    targets = sources or SOURCES
    results = []
    for src in targets:
        try:
            results.append(fetch_and_parse_source(src))
        except Exception as exc:  # noqa: BLE001 - surface every failure, keep going
            log.warning("Failed to refresh %s: %s", src["id"], exc)
            store.record_error(src["id"], str(exc))
            results.append({
                "id": src["id"],
                "title": src["title"],
                "description": src["description"],
                "tags": src.get("tags", []),
                "owner": src["owner"],
                "repo": src.get("repo"),
                "html_url": f"https://github.com/{src['owner']}/{src['repo']}" if src.get("repo") else f"https://github.com/{src['owner']}",
                "categories": [],
                "uncategorized": [],
                "item_count": 0,
                "category_count": 0,
                "changed_this_run": False,
                "error": str(exc),
            })
    return results


def get_cached_or_placeholder(src):
    if src["id"] in _last_result_cache:
        return _last_result_cache[src["id"]]
    state = store.get_source_state(src["id"])
    return {
        "id": src["id"],
        "title": src["title"],
        "description": src["description"],
        "tags": src.get("tags", []),
        "owner": src["owner"],
        "repo": src.get("repo"),
        "html_url": f"https://github.com/{src['owner']}/{src['repo']}" if src.get("repo") else f"https://github.com/{src['owner']}",
        "categories": [],
        "uncategorized": [],
        "item_count": (state or {}).get("item_count", 0),
        "category_count": (state or {}).get("category_count", 0),
        "changed_this_run": False,
        "pending": True,
    }
