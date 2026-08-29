import base64
import json
import os

import requests

API_ROOT = "https://api.github.com"
TIMEOUT = 20


def _headers():
    h = {"Accept": "application/vnd.github+json", "User-Agent": "android-app-hub"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


class FetchError(Exception):
    pass


def _get(url, params=None):
    resp = requests.get(url, headers=_headers(), params=params, timeout=TIMEOUT)
    if resp.status_code == 403 and "rate limit" in resp.text.lower():
        raise FetchError(
            "GitHub API rate limit hit. Set a GITHUB_TOKEN environment "
            "variable to raise the limit (see README)."
        )
    if resp.status_code == 404:
        raise FetchError(f"Not found: {url}")
    resp.raise_for_status()
    return resp


def fetch_repo_meta(owner, repo):
    r = _get(f"{API_ROOT}/repos/{owner}/{repo}")
    data = r.json()
    return {
        "stars": data.get("stargazers_count"),
        "default_branch": data.get("default_branch", "main"),
        "html_url": data.get("html_url"),
        "pushed_at": data.get("pushed_at"),
        "description": data.get("description"),
    }


def fetch_file_raw(owner, repo, path, ref=None):
    r = _get(f"{API_ROOT}/repos/{owner}/{repo}/contents/{path}", params={"ref": ref} if ref else None)
    data = r.json()
    if data.get("encoding") == "base64":
        return base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    raise FetchError(f"Unexpected encoding for {path}")


def fetch_readme(owner, repo):
    r = _get(f"{API_ROOT}/repos/{owner}/{repo}/readme")
    data = r.json()
    return base64.b64decode(data["content"]).decode("utf-8", errors="replace")


def fetch_json_file(owner, repo, path, ref=None):
    text = fetch_file_raw(owner, repo, path, ref=ref)
    return json.loads(text)


def fetch_recent_commits(owner, repo, per_page=8):
    r = _get(f"{API_ROOT}/repos/{owner}/{repo}/commits", params={"per_page": per_page})
    out = []
    for c in r.json():
        commit = c.get("commit", {})
        out.append({
            "sha": c.get("sha", "")[:7],
            "message": commit.get("message", "").splitlines()[0],
            "date": commit.get("author", {}).get("date"),
            "url": c.get("html_url"),
        })
    return out


def fetch_user_repos(username, per_page=100):
    r = _get(
        f"{API_ROOT}/users/{username}/repos",
        params={"per_page": per_page, "sort": "updated", "type": "owner"},
    )
    repos = [x for x in r.json() if not x.get("fork")]
    return repos
