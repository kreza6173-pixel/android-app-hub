"""
Source registry.

Each entry describes one of the six upstream GitHub repositories the hub
tracks. `kind` tells the fetcher which strategy to use:

  - "json_index"   : a structured JSON file living inside the repo
                      (falls back to "readme" if the file is missing/moved)
  - "readme"       : parse the repository's root README.md as an
                      awesome-list (## / ### headings + "- [Name](url) - desc")
  - "file"         : parse one specific markdown file inside a repo
  - "user_profile" : a GitHub *user*, not a repo — list their public repos
                      grouped by primary language / topic

Add a new repo by appending an entry here; nothing else needs to change.
"""

SOURCES = [
    {
        "id": "shizuku-modules",
        "title": "Shizuku Modules Directory",
        "owner": "rushiranpise",
        "repo": "shizuku-modules",
        "kind": "json_index",
        "json_path": "data/repos.json",
        "readme_fallback": True,
        "description": "Auto-maintained directory of Android apps that use Shizuku.",
        "category_field": "category",
        "tags": ["shizuku", "no-root"],
    },
    {
        "id": "awesome-android-app-repositories",
        "title": "Awesome Android App Repositories",
        "owner": "krishna3163",
        "repo": "awesome-android-app-repositories",
        "kind": "readme",
        "description": "Curated list of open-source Android app repositories.",
        "tags": ["awesome-list", "open-source"],
    },
    {
        "id": "best-shizuku-apps-no-root",
        "title": "Best Shizuku Apps (No Root)",
        "owner": "krishna3163",
        "repo": "best_shizuku_apps_for_android_no_root",
        "kind": "readme",
        "description": "Hand-picked Shizuku-powered apps that don't require root.",
        "tags": ["shizuku", "no-root"],
    },
    {
        "id": "best-root-apps",
        "title": "Best Root Apps for Android",
        "owner": "krishna3163",
        "repo": "best-root-apps-for-android",
        "kind": "readme",
        "description": "Hand-picked apps and modules for rooted Android devices.",
        "tags": ["root", "magisk"],
    },
    {
        "id": "awesome-shizuku",
        "title": "Awesome Shizuku",
        "owner": "timschneeb",
        "repo": "awesome-shizuku",
        "kind": "readme",
        "description": "The original, most comprehensive curated list of Android apps that use Shizuku — 9.8k stars.",
        "tags": ["shizuku", "awesome-list"],
    },
    {
        "id": "app-crawler-summary",
        "title": "App Crawler — Summary",
        "owner": "timschneeb",
        "repo": "app-crawler",
        "kind": "file",
        "file_path": "SUMMARY.md",
        "description": "Generated summary of apps discovered by timschneeb's app-crawler tool.",
        "tags": ["crawler", "catalog"],
    },
    {
    "id": "shizuku-dhizuku-list",
    "type": "repo",
    "repo": "UrkeJH/ShizukuDhizuku-list",
    "category": "shizuku",
    "title": "Shizuku & Dhizuku App List",
    "description": "Curated list of apps supporting Shizuku and Dhizuku APIs for privileged operations without root."
    },
]

SOURCE_BY_ID = {s["id"]: s for s in SOURCES}
