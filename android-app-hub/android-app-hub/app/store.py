import difflib
import hashlib
import json
import os
import threading
from datetime import datetime, timezone

CACHE_DIR = os.path.join(os.path.dirname(__file__), "..", "cache")
STATE_FILE = os.path.join(CACHE_DIR, "state.json")
CHANGELOG_FILE = os.path.join(CACHE_DIR, "changelog.json")
MAX_CHANGELOG_PER_SOURCE = 40
MAX_DIFF_LINES = 12

_lock = threading.Lock()


def _now():
    return datetime.now(timezone.utc).isoformat()


def _ensure_dir():
    os.makedirs(CACHE_DIR, exist_ok=True)


def _load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def _save_json(path, data):
    _ensure_dir()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_state():
    return _load_json(STATE_FILE, {})


def load_changelog():
    return _load_json(CHANGELOG_FILE, {})


def _fingerprint(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _line_diff(old_text, new_text):
    old_lines = [l for l in old_text.splitlines() if l.strip()]
    new_lines = [l for l in new_text.splitlines() if l.strip()]
    sm = difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False)
    added, removed = [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("replace", "delete"):
            removed.extend(old_lines[i1:i2])
        if tag in ("replace", "insert"):
            added.extend(new_lines[j1:j2])
    return added[:MAX_DIFF_LINES], removed[:MAX_DIFF_LINES]


def record_snapshot(source_id, raw_text, parsed_summary, extra=None):
    """
    Compare raw_text against the last stored snapshot for this source.
    If it changed, append a changelog entry with an added/removed line diff.
    Always updates the state file with the latest snapshot + timestamp.
    Returns True if this update produced a changelog entry (i.e. content changed).
    """
    with _lock:
        state = load_state()
        changelog = load_changelog()

        prev = state.get(source_id)
        new_fp = _fingerprint(raw_text)
        changed = False

        if prev and prev.get("fingerprint") != new_fp:
            added, removed = _line_diff(prev.get("raw_text", ""), raw_text)
            if added or removed:
                entry = {
                    "timestamp": _now(),
                    "added": added,
                    "removed": removed,
                    "added_count": len(added),
                    "removed_count": len(removed),
                }
                changelog.setdefault(source_id, [])
                changelog[source_id].insert(0, entry)
                changelog[source_id] = changelog[source_id][:MAX_CHANGELOG_PER_SOURCE]
                changed = True

        state[source_id] = {
            "fingerprint": new_fp,
            "raw_text": raw_text,
            "checked_at": _now(),
            "item_count": parsed_summary.get("item_count", 0),
            "category_count": parsed_summary.get("category_count", 0),
            "extra": extra or {},
        }

        _save_json(STATE_FILE, state)
        _save_json(CHANGELOG_FILE, changelog)
        return changed


def record_error(source_id, message):
    with _lock:
        state = load_state()
        entry = state.get(source_id, {})
        entry["last_error"] = message
        entry["error_at"] = _now()
        state[source_id] = entry
        _save_json(STATE_FILE, state)


def get_source_state(source_id):
    return load_state().get(source_id)


def get_changelog(source_id=None, limit=50):
    changelog = load_changelog()
    if source_id:
        return changelog.get(source_id, [])[:limit]
    merged = []
    for sid, entries in changelog.items():
        for e in entries:
            merged.append({**e, "source_id": sid})
    merged.sort(key=lambda e: e["timestamp"], reverse=True)
    return merged[:limit]
