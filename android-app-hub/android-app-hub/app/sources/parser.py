"""
Turns raw markdown (awesome-list style) into a normalized structure:

{
    "categories": [
        {
            "name": "Customization",
            "items": [
                {"name": "App Name", "url": "https://...", "desc": "..."},
                ...
            ]
        },
        ...
    ],
    "uncategorized": [ ...items found before the first heading... ]
}

The parser is intentionally forgiving: awesome-lists vary a lot in how
strictly they follow the "- [Name](url) - description" convention, so we
fall back gracefully whenever a line doesn't match cleanly.
"""

import re

HEADING_RE = re.compile(r"^(#{2,3})\s+(.*)$")
# - [Name](url) - description   /   - [Name](url): description  /  - [Name](url)
LINK_ITEM_RE = re.compile(
    r"^\s*[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s*[-:–—]?\s*(.*)$"
)
# plain bullet with no link: "- Name - description"
PLAIN_ITEM_RE = re.compile(r"^\s*[-*]\s+(.*)$")
# markdown table row: | Name | url | desc |
TABLE_ROW_RE = re.compile(r"^\s*\|(.+)\|\s*$")

SKIP_HEADINGS = {
    "table of contents", "contents", "license", "credits",
    "credits & acknowledgments", "contributing", "about",
}


def _clean_heading(text):
    return re.sub(r"[#\s]+$", "", text).strip()


def parse_awesome_markdown(markdown_text):
    lines = markdown_text.splitlines()
    categories = []
    current = None
    uncategorized = []
    in_table = False
    table_header_skipped = False

    for raw_line in lines:
        line = raw_line.rstrip()
        if not line.strip():
            in_table = False
            table_header_skipped = False
            continue

        h = HEADING_RE.match(line)
        if h:
            name = _clean_heading(h.group(2))
            name = re.sub(r"^[^\w(]+", "", name).strip()  # strip leading emoji/symbols
            if not name or name.lower() in SKIP_HEADINGS:
                current = None
                continue
            current = {"name": name, "items": []}
            categories.append(current)
            in_table = False
            table_header_skipped = False
            continue

        link_item = LINK_ITEM_RE.match(line)
        if link_item:
            name, url, desc = link_item.groups()
            item = {"name": name.strip(), "url": url.strip(), "desc": desc.strip(" -:–—")}
            (current["items"] if current else uncategorized).append(item)
            continue

        table_row = TABLE_ROW_RE.match(line)
        if table_row:
            cells = [c.strip() for c in table_row.group(1).split("|")]
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
                continue  # markdown table separator row
            if not table_header_skipped and current is not None and len(current["items"]) == 0:
                # heuristically treat the first row after a heading as a header row
                # only skip it if it looks like labels, not a real entry
                if all(not re.search(r"https?://", c) for c in cells):
                    table_header_skipped = True
                    continue
            link_in_row = None
            for c in cells:
                m = re.search(r"\[([^\]]+)\]\(([^)]+)\)", c)
                if m:
                    link_in_row = m
                    break
            if link_in_row:
                name, url = link_in_row.groups()
                rest = " ".join(c for c in cells if c and c != link_in_row.group(0))
                item = {"name": name.strip(), "url": url.strip(), "desc": rest.strip()}
            elif cells:
                item = {"name": cells[0], "url": "", "desc": " ".join(cells[1:])}
            else:
                continue
            (current["items"] if current else uncategorized).append(item)
            continue

        plain_item = PLAIN_ITEM_RE.match(line)
        if plain_item:
            text = plain_item.group(1).strip()
            url_match = re.search(r"https?://\S+", text)
            item = {
                "name": text if not url_match else text[: url_match.start()].strip(" -:–—") or url_match.group(0),
                "url": url_match.group(0).rstrip(").,") if url_match else "",
                "desc": "" if not url_match else text.replace(url_match.group(0), "").strip(" -:–—"),
            }
            if item["name"]:
                (current["items"] if current else uncategorized).append(item)
            continue

    categories = [c for c in categories if c["items"]]
    return {"categories": categories, "uncategorized": uncategorized}


def parse_json_index(entries, category_field="category"):
    """Group a flat list of dict entries (e.g. data/repos.json) into
    the same {categories:[...]} shape the markdown parser produces."""
    buckets = {}
    order = []
    for e in entries:
        cat = (e.get(category_field) or "Uncategorized").strip() or "Uncategorized"
        if cat not in buckets:
            buckets[cat] = []
            order.append(cat)
        buckets[cat].append({
            "name": e.get("name") or e.get("full_name") or e.get("repo") or "Unnamed",
            "url": e.get("homepage") or e.get("html_url") or e.get("url") or "",
            "desc": e.get("description") or "",
            "stars": e.get("stars") or e.get("stargazers_count"),
            "icon_url": e.get("icon_url"),
        })
    return {"categories": [{"name": c, "items": buckets[c]} for c in order], "uncategorized": []}
