#!/usr/bin/env python3
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.server import create_app  # noqa: E402

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "127.0.0.1")
    application = create_app()
    print(f"\n  Android App Hub running at http://{host}:{port}\n  (open this address in your browser)\n")
    application.run(host=host, port=port, debug=False, use_reloader=False)
