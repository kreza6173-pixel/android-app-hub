# Android App Hub

A self-hosted dashboard that aggregates seven Android app/module directories
from GitHub into one clean, categorized, searchable web UI — designed to
run locally on-device via **Termux**, with zero cloud dependency.

Every time you start it, it automatically re-fetches all seven sources,
diffs the new content against the previous run, and logs what changed
in a per-source **Changelog** tab.

## Tracked sources

| Source | What it is |
|---|---|
| [rushiranpise/shizuku-modules](https://github.com/rushiranpise/shizuku-modules) | Auto-maintained directory of apps that use Shizuku |
| [krishna3163/awesome-android-app-repositories](https://github.com/krishna3163/awesome-android-app-repositories) | Curated list of open-source Android app repos |
| [krishna3163/best_shizuku_apps_for_android_no_root](https://github.com/krishna3163/best_shizuku_apps_for_android_no_root) | Hand-picked Shizuku apps that need no root |
| [krishna3163/best-root-apps-for-android](https://github.com/krishna3163/best-root-apps-for-android) | Hand-picked apps/modules for rooted devices |
| [timschneeb/awesome-shizuku](https://github.com/timschneeb/awesome-shizuku) | The original, most comprehensive curated list of Shizuku apps (9.8k★) |
| [timschneeb/app-crawler](https://github.com/timschneeb/app-crawler/blob/master/SUMMARY.md) | Generated summary from the app-crawler tool |
| [UrkeJH/ShizukuDhizuku-list](https://github.com/UrkeJH/ShizukuDhizuku-list) | Curated list of Shizuku/Dhizuku-compatible apps (489★) |

Sources are declared in [`app/sources/config.py`](app/sources/config.py) —
add a new GitHub repo, user, or file by appending one entry to that list.

## Features

- **Live categorized catalog** — every source is parsed into categories
  and searchable cards (name, description, star count where available).
  Cards with a real link open the source app/repo in a new tab; entries
  with no link (e.g. a plain description line) are shown as plain cards
  instead of dead links, so it's always clear what's clickable.
- **Inline markdown rendering** — `**bold**` and `` `code` `` fragments
  pulled from an upstream README are rendered properly instead of showing
  up as literal asterisks/backticks.
- **Auto-refresh on every launch** — no manual step required; a background
  refresh starts the moment the server boots, plus a manual "Refresh" button.
- **Full changelog, not just the latest diff** — the Changelog tab is
  grouped by source (collapsible, like the catalog) and shows every change
  in the selected window (7 / 30 / 90 days), so older changes you may have
  missed don't get pushed out by a single noisy source.
- **One-click export** — the Export button downloads a Markdown file with
  the full catalog plus the changelog for the selected day range, ready to
  archive or share.
- **Works fully offline after the first load** of whatever it already
  cached — only the refresh step needs internet access.
- **No build step.** Vanilla HTML/CSS/JS frontend, a small Flask backend —
  nothing to compile, nothing to bundle.

## Run it in Termux

```bash
pkg update && pkg install python git
git clone https://github.com/<your-username>/android-app-hub.git
cd android-app-hub
./run.sh
```

Then open **http://127.0.0.1:8000** in your phone's browser.

`run.sh` creates a local virtual environment, installs dependencies, and
starts the server — it only needs to install packages the first time you
run it.

### Optional: raise the GitHub API rate limit

Without a token, GitHub allows 60 unauthenticated API requests per hour,
which is enough for normal use of this project (about 8 requests per
refresh). If you refresh very frequently, set a
[personal access token](https://github.com/settings/tokens) (no scopes
needed for public data):

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
./run.sh
```

## Run it on a regular computer

Same steps work on Linux/macOS — `run.sh` only uses the Termux shebang as
a hint and runs fine under any POSIX shell:

```bash
git clone https://github.com/<your-username>/android-app-hub.git
cd android-app-hub
bash run.sh
```

Or manually:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python run.py
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Interface to bind the web server to |
| `PORT` | `8000` | Port to serve the UI on |
| `GITHUB_TOKEN` | *(none)* | Optional GitHub token for a higher API rate limit |

## Project layout

```
android-app-hub/
├── run.py                  # entry point
├── run.sh                  # Termux/Linux launcher (venv + deps + run)
├── app/
│   ├── server.py           # Flask routes + background auto-refresh
│   ├── aggregator.py       # fetch → parse → snapshot orchestration
│   ├── store.py            # local JSON cache + diff-based changelog
│   ├── sources/
│   │   ├── config.py       # the list of tracked sources — edit this to add more
│   │   ├── fetchers.py     # GitHub REST API helpers
│   │   └── parser.py       # markdown/JSON → categorized items
│   ├── templates/index.html
│   └── static/{css,js}/
└── cache/                  # generated at runtime, gitignored
```

## How the changelog works

On every refresh, each source's raw content (README markdown, a JSON
index file, or a repo list) is fingerprinted with SHA-256. If the
fingerprint differs from the previous run, a line-level diff
(`difflib.SequenceMatcher`) is computed between the old and new content,
and the added/removed lines are stored as a changelog entry with a
timestamp. Nothing is ever fabricated — if a source hasn't changed, no
changelog entry is created for that run.

## License

This repository contains only aggregation/display code. All app
listings, descriptions, and metadata belong to their respective upstream
repositories and authors — see the Tracked sources table above.
