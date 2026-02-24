# CC LOG

Claude Code Session Log Viewer -- a lightweight web app for browsing and inspecting Claude Code `.jsonl` session logs.

## Tech Stack

- **Backend**: Python / FastAPI
- **Frontend**: HTML + Tailwind CSS + vanilla JavaScript
- **Server**: Uvicorn

## Quick Start

```bash
pip install -r requirements.txt
python run.py            # opens browser at http://localhost:5173
python run.py --no-browser  # start without opening browser
```

## Directory Structure

```
cc-log/
├── run.py               # Entry point (uvicorn launcher)
├── requirements.txt
├── src/
│   ├── __init__.py
│   ├── server.py        # FastAPI app and API routes
│   └── static/          # Frontend assets (HTML, JS, CSS)
└── CLAUDE.md
```

## Key Files

| File | Purpose |
|------|---------|
| `run.py` | Startup script; reads HOST/PORT env vars, opens browser |
| `src/server.py` | FastAPI application with API endpoints and static file serving |
| `src/static/` | Frontend HTML/JS/CSS served as static files |
