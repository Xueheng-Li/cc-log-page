# CC LOG

Claude Code 会话日志查看器 — 三栏式 Web 应用，浏览、搜索、导出 `.jsonl` 会话日志。

## Tech Stack

- **Backend**: Python 3.9+ / FastAPI / uvicorn / watchfiles
- **Frontend**: Vanilla JavaScript + Tailwind CSS (CDN) + Lucide icons (CDN)
- **Data**: Claude Code JSONL logs from `~/.claude/projects/`

## Quick Start

```bash
pip install -r requirements.txt
python run.py                   # http://localhost:5173
python run.py --no-browser      # headless
PORT=8080 python run.py         # custom port
```

## Project Structure

```
cc-log/
├── run.py                  # Entry point (uvicorn launcher, browser auto-open)
├── requirements.txt        # fastapi, uvicorn[standard], watchfiles
├── src/
│   ├── __init__.py
│   ├── server.py           # FastAPI app: API routes, WebSocket, JSONL parser, file watcher
│   └── static/
│       ├── index.html      # Three-panel layout, Tailwind CSS, modals, inline fallback script
│       └── app.js          # State management, API client, rendering, keyboard shortcuts
├── CLAUDE.md
└── README.md
```

## Architecture

### Backend (`src/server.py`)
- Scans `~/.claude/projects/` on startup, indexes all JSONL session files
- Project path encoding: CC replaces `/` with `-` in directory names (e.g., `/Users/xueheng/PythonProjects/cc-log` → `-Users-xueheng-PythonProjects-cc-log`)
- Decoding uses filesystem-aware greedy path matcher (naive `replace('-','/')` breaks names like `cc-log`)
- `watchfiles` monitors for new/changed JSONL files, pushes updates via WebSocket
- Static files mounted at `/static/`, index.html served at root `/`

### Frontend (`src/static/`)
- **index.html**: Static HTML shell with Tailwind classes, three modals (search/export/share), inline fallback script guarded by `if (typeof initPanelResize === 'function') return;`
- **app.js**: Full app logic — loaded via `<script src="/static/app.js">` (path must match static mount!)
- All UI text is Simplified Chinese (i18n object at top of app.js)
- Icons: Lucide SVG — static HTML uses `data-lucide` attributes, dynamic rendering uses inline `<svg>`

### DOM ID Convention
- Panels: `panel-projects`, `panel-sessions`, `panel-detail`
- Lists: `project-list`, `session-list`, `message-list`
- Modals: `modal-search`, `modal-export`, `modal-share`
- Buttons use `data-action="..."` attributes, not `#btn-*` IDs (except `#btn-batch-toggle`)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/projects` | List all projects (supports `sort_by`, `sort_order`) |
| GET | `/api/projects/{id}/sessions` | Sessions for a project |
| GET | `/api/sessions/{id}` | Session detail with all messages |
| GET | `/api/search?q=...` | Global full-text search |
| GET | `/api/sessions/{id}/export?format=markdown\|json\|html` | Export single session |
| POST | `/api/sessions/batch-export` | Batch export as ZIP (`{session_ids, format}`) |
| GET | `/api/sessions/{id}/share` | Returns self-contained HTML page |
| GET | `/api/stats` | System statistics |
| GET | `/api/health` | Health check |
| WS | `/ws/live` | Real-time log updates |

## Commit & Change Tracking

- Before committing substantial changes, update `CHANGELOG.md` with a summary of what changed
- Update this `CLAUDE.md` if architecture, conventions, or API endpoints change
- Keep CHANGELOG entries grouped under `### Added`, `### Changed`, `### Fixed`, `### Removed`

## Development Notes

- **Script path**: `<script src="/static/app.js">` — must use absolute path from root, not relative
- **No hardcoded sample data**: HTML containers should be empty; app.js renders all dynamic content
- **Search highlight markers**: Server uses `<<hl>>` / `<</hl>>` (not `<<highlight>>`)
- **Response format**: API wraps data in objects: `{projects: [...]}`, `{sessions: [...]}`, `{messages: [...], metadata: {...}}`
- **Playwright testing**: Use `wait_until="domcontentloaded"` (WebSocket keeps `networkidle` waiting forever)
