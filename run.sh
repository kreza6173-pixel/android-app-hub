#!/data/data/com.termux/files/usr/bin/env bash
# Also works on regular Linux/macOS (falls back to /usr/bin/env bash there).
set -euo pipefail

cd "$(dirname "$0")"

PYTHON_BIN="${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    echo "python3 not found."
    echo "On Termux run:  pkg install python"
    exit 1
fi

if [ ! -d ".venv" ]; then
    echo "Setting up virtual environment (first run only)..."
    "$PYTHON_BIN" -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

pip install --quiet --upgrade pip
pip install --quiet -r requirements.txt

echo ""
echo "Starting Android App Hub..."
echo "Tip: set GITHUB_TOKEN in your shell first to avoid GitHub API rate limits."
echo ""

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8000}"

python run.py
