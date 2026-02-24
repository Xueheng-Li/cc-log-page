#!/usr/bin/env python3
"""CC LOG - Claude Code Session Log Viewer"""
import os
import sys
import webbrowser
import threading
import uvicorn

def open_browser(port):
    """Open browser after a short delay."""
    import time
    time.sleep(1.5)
    webbrowser.open(f"http://localhost:{port}")

def main():
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "5173"))

    # Open browser in background
    if "--no-browser" not in sys.argv:
        threading.Thread(target=open_browser, args=(port,), daemon=True).start()

    print(f"\n  CC LOG - Claude Code Session Log Viewer")
    print(f"  Running at http://localhost:{port}\n")

    uvicorn.run(
        "src.server:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )

if __name__ == "__main__":
    main()
