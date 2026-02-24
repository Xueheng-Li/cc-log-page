"""
CC LOG - Claude Code Session Log Viewer Backend

A FastAPI server that reads, parses, and serves Claude Code JSONL session logs
from ~/.claude/projects/. Provides REST APIs, WebSocket live updates, search,
export (JSON/Markdown/HTML), and shareable standalone HTML generation.

Usage:
    python src/server.py
    # or: uvicorn src.server:app --host 0.0.0.0 --port 5173

Environment variables (prefix CCLOG_):
    CCLOG_CLAUDE_DIR    - Root Claude directory (default: ~/.claude)
    CCLOG_HOST          - Bind host (default: 0.0.0.0)
    CCLOG_PORT          - Bind port (default: 5173)
    CCLOG_DEBUG         - Enable debug/reload (default: false)
    CCLOG_WATCH_ENABLED - Enable filesystem watcher (default: true)
"""

from __future__ import annotations

import asyncio
import html as html_module
import io
import json
import logging
import os
import re
import time
import zipfile
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, computed_field

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

logger = logging.getLogger("cclog")


@dataclass
class Settings:
    """Application configuration loaded from environment variables."""

    claude_dir: Path = field(default_factory=lambda: Path.home() / ".claude")
    projects_dir: Path | None = None
    host: str = "0.0.0.0"
    port: int = 5173
    debug: bool = False
    watch_enabled: bool = True
    watch_debounce_ms: int = 500
    search_max_results: int = 50
    search_snippet_chars: int = 120
    max_session_cache_size: int = 200
    cors_origins: list[str] = field(default_factory=lambda: ["*"])

    @staticmethod
    def from_env() -> Settings:
        """Load settings from environment with CCLOG_ prefix."""
        s = Settings()
        if v := os.environ.get("CCLOG_CLAUDE_DIR"):
            s.claude_dir = Path(v).expanduser()
        if v := os.environ.get("CCLOG_PROJECTS_DIR"):
            s.projects_dir = Path(v).expanduser()
        if v := os.environ.get("CCLOG_HOST"):
            s.host = v
        if v := os.environ.get("CCLOG_PORT"):
            s.port = int(v)
        if v := os.environ.get("CCLOG_DEBUG"):
            s.debug = v.lower() in ("true", "1", "yes")
        if v := os.environ.get("CCLOG_WATCH_ENABLED"):
            s.watch_enabled = v.lower() in ("true", "1", "yes")
        if v := os.environ.get("CCLOG_WATCH_DEBOUNCE_MS"):
            s.watch_debounce_ms = int(v)
        if v := os.environ.get("CCLOG_SEARCH_MAX_RESULTS"):
            s.search_max_results = int(v)
        if v := os.environ.get("CCLOG_CORS_ORIGINS"):
            s.cors_origins = [o.strip() for o in v.split(",")]
        # Support legacy env vars
        if v := os.environ.get("CLAUDE_DIR"):
            s.claude_dir = Path(v).expanduser()
        if v := os.environ.get("HOST"):
            s.host = v
        if v := os.environ.get("PORT"):
            s.port = int(v)
        return s

    def get_projects_dir(self) -> Path:
        if self.projects_dir:
            return self.projects_dir
        return self.claude_dir / "projects"


# ═══════════════════════════════════════════════════════════════════════════════
# Pydantic Response Models
# ═══════════════════════════════════════════════════════════════════════════════


class ProjectModel(BaseModel):
    id: str
    display_name: str
    short_name: str
    path: str
    session_count: int
    last_active: datetime | None
    total_size_bytes: int = 0


class SessionSummary(BaseModel):
    id: str
    project_id: str
    first_message: str
    message_count: int
    start_time: datetime | None
    end_time: datetime | None
    duration_seconds: int | None
    model: str | None
    version: str | None
    cwd: str | None
    git_branch: str | None
    file_size_bytes: int
    slug: str | None = None

    @computed_field
    @property
    def duration_display(self) -> str:
        if not self.duration_seconds:
            return ""
        mins, secs = divmod(self.duration_seconds, 60)
        hours, mins = divmod(mins, 60)
        if hours > 0:
            return f"{hours}h {mins}m"
        elif mins > 0:
            return f"{mins}m {secs}s"
        return f"{secs}s"


class TextBlock(BaseModel):
    type: Literal["text"] = "text"
    text: str


class ThinkingBlock(BaseModel):
    type: Literal["thinking"] = "thinking"
    text: str


class ToolUseBlock(BaseModel):
    type: Literal["tool_use"] = "tool_use"
    tool_use_id: str
    name: str
    input: dict


class ToolResultBlock(BaseModel):
    type: Literal["tool_result"] = "tool_result"
    tool_use_id: str
    content: str
    is_error: bool = False


ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock


class MessageType(str, Enum):
    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    TOOL_RESULT = "tool_result"


class ToolResultData(BaseModel):
    stdout: str | None = None
    stderr: str | None = None
    is_error: bool = False
    is_image: bool = False
    file_path: str | None = None
    content: str | None = None
    interrupted: bool = False


class Message(BaseModel):
    uuid: str
    parent_uuid: str | None
    type: MessageType
    role: str | None
    content: list[ContentBlock]
    content_text: str
    timestamp: datetime | None
    tool_name: str | None = None
    tool_input: dict | None = None
    tool_result: ToolResultData | None = None
    is_thinking: bool = False
    is_sidechain: bool = False
    is_meta: bool = False
    is_compact_summary: bool = False
    model: str | None = None
    duration_ms: int | None = None
    stop_reason: str | None = None


class Conversation(BaseModel):
    session_id: str
    project_id: str
    messages: list[Message]
    metadata: SessionSummary


class SearchResultItem(BaseModel):
    session_id: str
    project_id: str
    project_name: str
    message_uuid: str
    role: str
    snippet: str
    timestamp: datetime | None
    match_count: int = 1


class SearchResponse(BaseModel):
    query: str
    total_results: int
    results: list[SearchResultItem]
    search_time_ms: float


class ExportFormat(str, Enum):
    JSON = "json"
    MARKDOWN = "markdown"
    HTML = "html"


class BatchExportRequest(BaseModel):
    session_ids: list[str]
    format: ExportFormat = ExportFormat.MARKDOWN


class ProjectListResponse(BaseModel):
    projects: list[ProjectModel]
    total_count: int


class SessionListResponse(BaseModel):
    sessions: list[SessionSummary]
    project: ProjectModel
    total_count: int


class StatsResponse(BaseModel):
    total_projects: int
    total_sessions: int
    total_messages_estimated: int
    total_size_bytes: int
    oldest_session: datetime | None
    newest_session: datetime | None


# ═══════════════════════════════════════════════════════════════════════════════
# JSONL Parser
# ═══════════════════════════════════════════════════════════════════════════════


def decode_project_path(dir_name: str) -> str:
    """Decode a Claude project directory name back to filesystem path.

    Claude Code encodes absolute paths by replacing '/' with '-' and '.' with '-'.
    Examples:
        '-Users-xueheng-PythonProjects'        -> '/Users/xueheng/PythonProjects'
        '-Users-xueheng-PythonProjects-cc-log'  -> '/Users/xueheng/PythonProjects/cc-log'
        '-Users-xueheng--claude'                -> '/Users/xueheng/.claude'

    Ambiguity: a hyphen could be an original '/', an original '.', or a literal '-'.
    Resolution: greedily match existing filesystem paths from left to right.
    When the parent path exists but no child matches, consume all remaining parts
    as a single hyphenated name (the project directory itself, which may be deleted).
    """
    if not dir_name or dir_name == "-":
        return "/"

    # Remove leading dash (represents the root '/')
    stripped = dir_name.lstrip("-")
    if not stripped:
        return "/"

    parts = stripped.split("-")
    # parts may contain empty strings from consecutive dashes (e.g., '--claude' -> ['', 'claude'])

    path = "/"
    i = 0
    while i < len(parts):
        # Empty part means there was a consecutive dash -> try dot-prefix (hidden dir)
        if parts[i] == "":
            i += 1
            if i < len(parts):
                # Try longest match with dot prefix
                found = False
                for j in range(len(parts), i, -1):
                    candidate = "." + "-".join(parts[i:j])
                    test_path = os.path.join(path, candidate)
                    if os.path.exists(test_path):
                        path = test_path
                        i = j
                        found = True
                        break
                if not found:
                    # Fallback: use all remaining parts as dot-prefixed name
                    candidate = "." + "-".join(parts[i:])
                    path = os.path.join(path, candidate)
                    i = len(parts)
            continue

        # Try to find the shortest prefix (parts[i:j]) that exists as a directory,
        # where what remains after j can also be resolved. But for efficiency,
        # use this heuristic: try longest match first (greedy filesystem check).
        found = False
        for j in range(len(parts), i, -1):
            candidate = "-".join(parts[i:j])
            test_path = os.path.join(path, candidate)
            if os.path.exists(test_path):
                path = test_path
                i = j
                found = True
                break
        if not found:
            # The parent path exists on disk but no child component matches.
            # This means all remaining parts form a single directory name
            # (likely the leaf project dir, possibly deleted).
            if os.path.isdir(path):
                remaining = "-".join(parts[i:])
                path = os.path.join(path, remaining)
                i = len(parts)
            else:
                # Parent also doesn't exist; just append single part
                path = os.path.join(path, parts[i])
                i += 1

    return path


def encode_project_path(path: str) -> str:
    return path.replace("/", "-")


def get_short_name(decoded_path: str) -> str:
    """Extract last meaningful component from decoded path."""
    parts = decoded_path.rstrip("/").rsplit("/", 1)
    return parts[-1] if parts[-1] else "/"


def is_valid_session_file(filename: str) -> bool:
    """Check if a filename is a valid session JSONL file."""
    return (
        filename.endswith(".jsonl")
        and not filename.startswith("._")
        and not filename.startswith(".")
    )


def discover_sessions(projects_dir: Path) -> dict[str, list[Path]]:
    """Scan projects directory and return {project_id: [session_paths]}."""
    result: dict[str, list[Path]] = {}
    try:
        for entry in os.scandir(projects_dir):
            if not entry.is_dir():
                continue
            project_id = entry.name
            sessions: list[Path] = []
            try:
                for file_entry in os.scandir(entry.path):
                    if (
                        file_entry.is_file()
                        and is_valid_session_file(file_entry.name)
                    ):
                        sessions.append(Path(file_entry.path))
            except (OSError, PermissionError):
                continue
            if sessions:
                result[project_id] = sessions
    except (OSError, PermissionError) as e:
        logger.error(f"Cannot scan projects directory {projects_dir}: {e}")
    return result


def _parse_timestamp(ts: Any) -> datetime | None:
    """Parse timestamp from various formats found in JSONL."""
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00"))
        except ValueError:
            return None
    elif isinstance(ts, (int, float)) and ts > 0:
        try:
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (OSError, ValueError, OverflowError):
            return None
    return None


def _extract_text_preview(content: Any, max_len: int = 200) -> str:
    """Extract a plain text preview from message content."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif block.get("type") == "tool_result":
                    snippet = str(block.get("content", ""))[:50]
                    parts.append(f"[Tool Result: {snippet}]")
            elif isinstance(block, str):
                parts.append(block)
        text = " ".join(parts)
    else:
        return str(content)[:max_len]

    # Strip XML command tags
    text = re.sub(r"<command-message>.*?</command-message>", "", text, flags=re.DOTALL)
    text = re.sub(r"<command-name>.*?</command-name>", "", text, flags=re.DOTALL)
    text = re.sub(r"</?command-args>", "", text)
    text = text.strip()

    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


def _read_last_timestamp(path: Path, read_bytes: int = 8192) -> datetime | None:
    """Read last few lines of file to extract the final timestamp (seek from end)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            file_size = f.tell()
            read_size = min(read_bytes, file_size)
            f.seek(file_size - read_size)
            tail = f.read().decode("utf-8", errors="replace")

        for line in reversed(tail.strip().split("\n")):
            try:
                obj = json.loads(line)
                ts = obj.get("timestamp")
                if isinstance(ts, str) and ts:
                    return datetime.fromisoformat(ts.replace("Z", "+00:00"))
                elif isinstance(ts, (int, float)) and ts > 0:
                    return datetime.fromtimestamp(ts, tz=timezone.utc)
            except (json.JSONDecodeError, ValueError):
                continue
    except (OSError, UnicodeDecodeError):
        pass
    return None


def extract_session_metadata(
    jsonl_path: Path, project_id: str
) -> SessionSummary | None:
    """Extract session metadata by reading only the first/last lines."""
    try:
        stat = jsonl_path.stat()
        file_size = stat.st_size
        if file_size == 0:
            return None

        first_user_msg = None
        first_timestamp = None
        model = None
        version = None
        cwd = None
        git_branch = None
        session_id = jsonl_path.stem
        slug = None

        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i > 20:
                    break
                try:
                    obj = json.loads(line, strict=False)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue

                line_type = obj.get("type")

                # Skip file-history-snapshot
                if line_type == "file-history-snapshot":
                    continue

                ts = obj.get("timestamp")
                if ts and not first_timestamp:
                    first_timestamp = _parse_timestamp(ts)

                if not version and obj.get("version"):
                    version = obj["version"]
                if not cwd and obj.get("cwd"):
                    cwd = obj["cwd"]
                if not git_branch and obj.get("gitBranch"):
                    git_branch = obj["gitBranch"] or None
                if not slug and obj.get("slug"):
                    slug = obj["slug"]

                if line_type == "user" and not first_user_msg:
                    msg = obj.get("message", {})
                    content = msg.get("content", "")
                    first_user_msg = _extract_text_preview(content, max_len=200)

                if line_type == "assistant" and not model:
                    msg = obj.get("message", {})
                    m = msg.get("model")
                    if m and m != "<synthetic>":
                        model = m

        last_timestamp = _read_last_timestamp(jsonl_path)

        # Estimate message count
        estimated_lines = max(1, file_size // 500)

        duration = None
        if first_timestamp and last_timestamp:
            delta = (last_timestamp - first_timestamp).total_seconds()
            duration = int(delta) if delta > 0 else None

        return SessionSummary(
            id=session_id,
            project_id=project_id,
            first_message=first_user_msg or "(no user message)",
            message_count=estimated_lines,
            start_time=first_timestamp,
            end_time=last_timestamp,
            duration_seconds=duration,
            model=model,
            version=version,
            cwd=cwd,
            git_branch=git_branch,
            file_size_bytes=file_size,
            slug=slug,
        )
    except (OSError, PermissionError) as e:
        logger.warning(f"Cannot read session file {jsonl_path}: {e}")
        return None


def _normalize_content(content: Any) -> list[ContentBlock]:
    """Normalize message content into typed blocks."""
    if isinstance(content, str):
        return [TextBlock(text=content)] if content else []
    if not isinstance(content, list):
        return [TextBlock(text=str(content))] if content else []

    blocks: list[ContentBlock] = []
    for block in content:
        if isinstance(block, str):
            blocks.append(TextBlock(text=block))
        elif isinstance(block, dict):
            block_type = block.get("type", "")

            if block_type == "text":
                blocks.append(TextBlock(text=block.get("text", "")))
            elif block_type == "thinking":
                blocks.append(ThinkingBlock(
                    text=block.get("thinking", block.get("text", ""))
                ))
            elif block_type == "tool_use":
                blocks.append(ToolUseBlock(
                    tool_use_id=block.get("id", ""),
                    name=block.get("name", ""),
                    input=block.get("input", {}),
                ))
            elif block_type == "tool_result":
                result_content = block.get("content", "")
                if isinstance(result_content, list):
                    result_content = " ".join(
                        b.get("text", str(b)) for b in result_content
                        if isinstance(b, dict)
                    )
                blocks.append(ToolResultBlock(
                    tool_use_id=block.get("tool_use_id", ""),
                    content=str(result_content),
                    is_error=block.get("is_error", False),
                ))
            # Skip image blocks (base64 data too large for API responses)
            # Skip unknown block types
    return blocks


def _blocks_to_text(blocks: list[ContentBlock]) -> str:
    """Extract plain text from content blocks for search/display."""
    parts = []
    for block in blocks:
        if isinstance(block, TextBlock):
            parts.append(block.text)
        elif isinstance(block, ThinkingBlock):
            parts.append(block.text[:500])
        elif isinstance(block, ToolUseBlock):
            parts.append(f"[Tool: {block.name}]")
        elif isinstance(block, ToolResultBlock):
            parts.append(block.content[:200])
    return " ".join(parts)


def _parse_tool_use_result(raw: Any) -> ToolResultData | None:
    """Parse the toolUseResult field on user-type lines."""
    if isinstance(raw, str):
        return ToolResultData(content=raw[:2000], is_error=True)
    if not isinstance(raw, dict):
        return None

    if "stdout" in raw:
        return ToolResultData(
            stdout=raw.get("stdout"),
            stderr=raw.get("stderr"),
            is_error=bool(raw.get("stderr")),
            is_image=raw.get("isImage", False),
            interrupted=raw.get("interrupted", False),
        )
    elif "content" in raw:
        return ToolResultData(
            content=str(raw.get("content", ""))[:2000],
            file_path=raw.get("filePath") or raw.get("file"),
            is_error=raw.get("is_error", False),
        )
    else:
        return ToolResultData(content=str(raw)[:500])


def parse_session(jsonl_path: Path, project_id: str) -> list[Message]:
    """Parse a complete JSONL session file into a list of Message objects."""
    messages: list[Message] = []
    pending_tool_uses: dict[str, Message] = {}

    try:
        with open(jsonl_path, "r", encoding="utf-8", errors="replace") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                # Remove BOM if present
                if line.startswith("\ufeff"):
                    line = line[1:]
                try:
                    obj = json.loads(line, strict=False)
                except json.JSONDecodeError:
                    continue

                line_type = obj.get("type")

                # Skip non-message types
                if line_type in (
                    "progress", "file-history-snapshot",
                    "queue-operation", "summary"
                ):
                    continue

                msg_data = obj.get("message", {})
                timestamp = _parse_timestamp(obj.get("timestamp"))

                if line_type == "user":
                    message = _parse_user_message(obj, msg_data, timestamp)
                    if message:
                        messages.append(message)
                        _pair_tool_results(message, pending_tool_uses)

                elif line_type == "assistant":
                    if not msg_data:
                        continue
                    message = _parse_assistant_message(obj, msg_data, timestamp)
                    if message:
                        messages.append(message)
                        _track_tool_uses(message, pending_tool_uses)

                elif line_type == "system":
                    message = _parse_system_message(obj, timestamp)
                    if message:
                        messages.append(message)

    except (OSError, PermissionError) as e:
        logger.error(f"Error parsing session {jsonl_path}: {e}")
    return messages


def _parse_user_message(
    obj: dict, msg_data: dict, timestamp: datetime | None
) -> Message | None:
    content = msg_data.get("content", "")
    content_blocks = _normalize_content(content)
    content_text = _blocks_to_text(content_blocks)

    tool_result_data = None
    raw_result = obj.get("toolUseResult")
    if raw_result:
        tool_result_data = _parse_tool_use_result(raw_result)

    # Determine if this is a tool_result message
    has_tool_result = tool_result_data is not None
    for block in content_blocks:
        if isinstance(block, ToolResultBlock):
            has_tool_result = True
            break

    return Message(
        uuid=obj.get("uuid", ""),
        parent_uuid=obj.get("parentUuid"),
        type=MessageType.TOOL_RESULT if has_tool_result else MessageType.USER,
        role="user",
        content=content_blocks,
        content_text=content_text,
        timestamp=timestamp,
        tool_result=tool_result_data,
        is_sidechain=obj.get("isSidechain", False),
        is_meta=obj.get("isMeta", False),
        is_compact_summary=obj.get("isCompactSummary", False),
    )


def _parse_assistant_message(
    obj: dict, msg_data: dict, timestamp: datetime | None
) -> Message | None:
    content = msg_data.get("content", [])
    content_blocks = _normalize_content(content)
    content_text = _blocks_to_text(content_blocks)

    tool_name = None
    tool_input = None
    for block in content_blocks:
        if isinstance(block, ToolUseBlock):
            tool_name = block.name
            tool_input = block.input
            break

    is_thinking = any(isinstance(b, ThinkingBlock) for b in content_blocks)

    return Message(
        uuid=obj.get("uuid", ""),
        parent_uuid=obj.get("parentUuid"),
        type=MessageType.ASSISTANT,
        role="assistant",
        content=content_blocks,
        content_text=content_text,
        timestamp=timestamp,
        tool_name=tool_name,
        tool_input=tool_input,
        is_thinking=is_thinking,
        is_sidechain=obj.get("isSidechain", False),
        is_meta=obj.get("isMeta", False),
        is_compact_summary=obj.get("isCompactSummary", False),
        model=msg_data.get("model"),
        duration_ms=obj.get("durationMs"),
        stop_reason=msg_data.get("stop_reason"),
    )


def _parse_system_message(
    obj: dict, timestamp: datetime | None
) -> Message | None:
    content_str = obj.get("content", "")
    subtype = obj.get("subtype", "")

    display_text = f"[{subtype}] {content_str}" if subtype else (content_str or "")

    return Message(
        uuid=obj.get("uuid", ""),
        parent_uuid=obj.get("parentUuid"),
        type=MessageType.SYSTEM,
        role="system",
        content=[TextBlock(text=display_text)] if display_text else [],
        content_text=display_text,
        timestamp=timestamp,
        is_compact_summary=obj.get("isCompactSummary", False),
    )


def _pair_tool_results(
    user_msg: Message, pending: dict[str, Message]
) -> None:
    """Pair tool_result content blocks with pending tool_use messages."""
    for block in user_msg.content:
        if isinstance(block, ToolResultBlock) and block.tool_use_id in pending:
            tool_use_msg = pending.pop(block.tool_use_id)
            tool_use_msg.tool_result = ToolResultData(
                content=block.content[:2000],
                is_error=block.is_error,
            )


def _track_tool_uses(
    assistant_msg: Message, pending: dict[str, Message]
) -> None:
    """Track tool_use blocks for future pairing."""
    for block in assistant_msg.content:
        if isinstance(block, ToolUseBlock):
            pending[block.tool_use_id] = assistant_msg


# ═══════════════════════════════════════════════════════════════════════════════
# Search Index
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class SearchEntry:
    session_id: str
    project_id: str
    project_name: str
    message_uuid: str
    role: str
    text_lower: str
    text_original: str
    timestamp: datetime | None


class SearchIndex:
    """In-memory full-text search index."""

    def __init__(self, snippet_chars: int = 120):
        self._entries: list[SearchEntry] = []
        self._snippet_chars = snippet_chars
        self._indexed_sessions: set[str] = set()

    @property
    def entry_count(self) -> int:
        return len(self._entries)

    def add_entry(self, entry: SearchEntry) -> None:
        self._entries.append(entry)

    def add_session_messages(
        self,
        session_id: str,
        project_id: str,
        project_name: str,
        messages: list[Message],
    ) -> None:
        if session_id in self._indexed_sessions:
            return
        for msg in messages:
            if msg.content_text.strip():
                self._entries.append(SearchEntry(
                    session_id=session_id,
                    project_id=project_id,
                    project_name=project_name,
                    message_uuid=msg.uuid,
                    role=msg.role or msg.type.value,
                    text_lower=msg.content_text.lower(),
                    text_original=msg.content_text,
                    timestamp=msg.timestamp,
                ))
        self._indexed_sessions.add(session_id)

    def is_session_indexed(self, session_id: str) -> bool:
        return session_id in self._indexed_sessions

    def search(
        self,
        query: str,
        project_id: str | None = None,
        role: str | None = None,
        limit: int = 50,
    ) -> list[SearchResultItem]:
        phrases, words = self._parse_query(query)

        results: list[SearchResultItem] = []
        for entry in self._entries:
            if project_id and entry.project_id != project_id:
                continue
            if role and entry.role != role:
                continue

            text = entry.text_lower

            if phrases and not all(p in text for p in phrases):
                continue
            if words and not all(w in text for w in words):
                continue
            if not phrases and not words:
                continue

            snippet = self._generate_snippet(
                entry.text_original, phrases, words
            )
            match_count = sum(text.count(w) for w in words)
            match_count += sum(text.count(p) for p in phrases)

            results.append(SearchResultItem(
                session_id=entry.session_id,
                project_id=entry.project_id,
                project_name=entry.project_name,
                message_uuid=entry.message_uuid,
                role=entry.role,
                snippet=snippet,
                timestamp=entry.timestamp,
                match_count=max(1, match_count),
            ))

            if len(results) >= limit:
                break

        results.sort(
            key=lambda r: (-r.match_count, -(r.timestamp.timestamp() if r.timestamp else 0))
        )
        return results[:limit]

    def _parse_query(self, query: str) -> tuple[list[str], list[str]]:
        phrases: list[str] = []
        remaining = query
        for match in re.finditer(r'"([^"]+)"', query):
            phrases.append(match.group(1).lower())
            remaining = remaining.replace(match.group(0), " ")
        words = [w.lower() for w in remaining.split() if w.strip()]
        return phrases, words

    def _generate_snippet(
        self, original_text: str, phrases: list[str], words: list[str]
    ) -> str:
        text_lower = original_text.lower()
        half_ctx = self._snippet_chars // 2
        search_terms = phrases + words

        first_pos = len(text_lower)
        matched_term = ""
        for term in search_terms:
            pos = text_lower.find(term)
            if pos != -1 and pos < first_pos:
                first_pos = pos
                matched_term = term

        if first_pos >= len(text_lower):
            return original_text[:self._snippet_chars]

        start = max(0, first_pos - half_ctx)
        end = min(len(original_text), first_pos + len(matched_term) + half_ctx)
        snippet = original_text[start:end]

        if start > 0:
            snippet = "..." + snippet
        if end < len(original_text):
            snippet = snippet + "..."

        for term in search_terms:
            pattern = re.compile(re.escape(term), re.IGNORECASE)
            snippet = pattern.sub(lambda m: f"<<hl>>{m.group(0)}<</hl>>", snippet)

        return snippet


# ═══════════════════════════════════════════════════════════════════════════════
# Session Cache (LRU)
# ═══════════════════════════════════════════════════════════════════════════════


class SessionCache:
    """LRU cache for fully-parsed sessions, invalidated by mtime."""

    def __init__(self, max_size: int = 200):
        self._cache: OrderedDict[str, tuple[float, Conversation]] = OrderedDict()
        self._max_size = max_size

    def get(self, session_id: str, file_mtime: float) -> Conversation | None:
        if session_id in self._cache:
            cached_mtime, conversation = self._cache[session_id]
            if cached_mtime >= file_mtime:
                self._cache.move_to_end(session_id)
                return conversation
            else:
                del self._cache[session_id]
        return None

    def put(self, session_id: str, file_mtime: float, conversation: Conversation) -> None:
        if session_id in self._cache:
            self._cache.move_to_end(session_id)
        self._cache[session_id] = (file_mtime, conversation)
        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)

    def invalidate(self, session_id: str) -> None:
        self._cache.pop(session_id, None)


# ═══════════════════════════════════════════════════════════════════════════════
# Services
# ═══════════════════════════════════════════════════════════════════════════════


class ProjectService:
    """Manages project metadata."""

    def __init__(self, projects_dir: Path):
        self.projects_dir = projects_dir
        self._projects: dict[str, ProjectModel] = {}

    @property
    def project_count(self) -> int:
        return len(self._projects)

    def build_index(
        self, sessions_map: dict[str, list[Path]]
    ) -> None:
        """Build project index from discovered sessions."""
        # Include all project dirs, even those without sessions
        try:
            for entry in os.scandir(self.projects_dir):
                if not entry.is_dir():
                    continue
                project_id = entry.name
                decoded_path = decode_project_path(project_id)
                short_name = get_short_name(decoded_path)

                session_paths = sessions_map.get(project_id, [])
                total_size = sum(p.stat().st_size for p in session_paths if p.exists())

                last_active = None
                for p in session_paths:
                    try:
                        mtime = datetime.fromtimestamp(
                            p.stat().st_mtime, tz=timezone.utc
                        )
                        if last_active is None or mtime > last_active:
                            last_active = mtime
                    except OSError:
                        pass

                self._projects[project_id] = ProjectModel(
                    id=project_id,
                    display_name=decoded_path,
                    short_name=short_name,
                    path=decoded_path,
                    session_count=len(session_paths),
                    last_active=last_active,
                    total_size_bytes=total_size,
                )
        except (OSError, PermissionError) as e:
            logger.error(f"Cannot scan projects: {e}")

    def get_project(self, project_id: str) -> ProjectModel | None:
        return self._projects.get(project_id)

    def list_projects(
        self, sort_by: str = "last_active", sort_order: str = "desc"
    ) -> list[ProjectModel]:
        projects = list(self._projects.values())

        def sort_key(p: ProjectModel) -> Any:
            if sort_by == "last_active":
                return p.last_active or datetime.min.replace(tzinfo=timezone.utc)
            elif sort_by == "name":
                return p.short_name.lower()
            elif sort_by == "session_count":
                return p.session_count
            return p.last_active or datetime.min.replace(tzinfo=timezone.utc)

        projects.sort(key=sort_key, reverse=(sort_order == "desc"))
        return projects

    def update_project_session_count(
        self, project_id: str, delta: int = 1
    ) -> None:
        if project_id in self._projects:
            p = self._projects[project_id]
            self._projects[project_id] = p.model_copy(
                update={"session_count": p.session_count + delta}
            )


class SessionService:
    """Manages session metadata and file lookups."""

    def __init__(self, projects_dir: Path, max_cache_size: int = 200):
        self.projects_dir = projects_dir
        self._session_index: dict[str, tuple[str, Path]] = {}
        self._session_meta: dict[str, SessionSummary] = {}
        self._cache = SessionCache(max_size=max_cache_size)

    @property
    def session_count(self) -> int:
        return len(self._session_index)

    def build_initial_index(
        self, sessions_map: dict[str, list[Path]]
    ) -> None:
        """Build session index and extract metadata."""
        for project_id, paths in sessions_map.items():
            for path in paths:
                session_id = path.stem
                self._session_index[session_id] = (project_id, path)

                meta = extract_session_metadata(path, project_id)
                if meta:
                    self._session_meta[session_id] = meta

    def find_session(self, session_id: str) -> tuple[str, Path]:
        if session_id not in self._session_index:
            raise HTTPException(
                status_code=404,
                detail=f"Session {session_id} not found"
            )
        return self._session_index[session_id]

    def get_session_meta(self, session_id: str) -> SessionSummary | None:
        return self._session_meta.get(session_id)

    def list_sessions(
        self,
        project_id: str,
        sort_by: str = "start_time",
        sort_order: str = "desc",
        limit: int = 100,
        offset: int = 0,
    ) -> list[SessionSummary]:
        sessions = [
            meta for meta in self._session_meta.values()
            if meta.project_id == project_id
        ]

        def sort_key(s: SessionSummary) -> Any:
            if sort_by == "start_time":
                return s.start_time or datetime.min.replace(tzinfo=timezone.utc)
            elif sort_by == "duration":
                return s.duration_seconds or 0
            elif sort_by == "message_count":
                return s.message_count
            elif sort_by == "file_size":
                return s.file_size_bytes
            return s.start_time or datetime.min.replace(tzinfo=timezone.utc)

        sessions.sort(key=sort_key, reverse=(sort_order == "desc"))
        return sessions[offset:offset + limit]

    def get_conversation(
        self,
        session_id: str,
        include_thinking: bool = True,
        include_tool_results: bool = True,
        include_sidechain: bool = False,
    ) -> Conversation:
        project_id, path = self.find_session(session_id)

        # Check cache
        try:
            mtime = path.stat().st_mtime
        except OSError:
            raise HTTPException(status_code=404, detail="Session file not found")

        cached = self._cache.get(session_id, mtime)
        if cached:
            messages = cached.messages
        else:
            messages = parse_session(path, project_id)
            meta = self._session_meta.get(session_id)
            if not meta:
                meta = extract_session_metadata(path, project_id)
                if meta:
                    self._session_meta[session_id] = meta
            if not meta:
                meta = SessionSummary(
                    id=session_id,
                    project_id=project_id,
                    first_message="",
                    message_count=len(messages),
                    start_time=None,
                    end_time=None,
                    duration_seconds=None,
                    model=None,
                    version=None,
                    cwd=None,
                    git_branch=None,
                    file_size_bytes=0,
                )
            conv = Conversation(
                session_id=session_id,
                project_id=project_id,
                messages=messages,
                metadata=meta,
            )
            self._cache.put(session_id, mtime, conv)

        # Apply filters
        filtered: list[Message] = []
        for msg in messages:
            if not include_sidechain and msg.is_sidechain:
                continue
            if not include_thinking:
                msg = msg.model_copy(update={
                    "content": [
                        b for b in msg.content
                        if not isinstance(b, ThinkingBlock)
                    ]
                })
            if not include_tool_results and msg.type == MessageType.TOOL_RESULT:
                continue
            filtered.append(msg)

        meta = self._session_meta.get(session_id)
        if not meta:
            meta = SessionSummary(
                id=session_id,
                project_id=project_id,
                first_message="",
                message_count=len(filtered),
                start_time=None,
                end_time=None,
                duration_seconds=None,
                model=None,
                version=None,
                cwd=None,
                git_branch=None,
                file_size_bytes=0,
            )

        return Conversation(
            session_id=session_id,
            project_id=project_id,
            messages=filtered,
            metadata=meta,
        )

    def register_session(
        self, session_id: str, project_id: str, path: Path
    ) -> None:
        self._session_index[session_id] = (project_id, path)

    def update_session_meta(
        self, session_id: str, meta: SessionSummary
    ) -> None:
        self._session_meta[session_id] = meta
        self._cache.invalidate(session_id)

    def populate_search_index(self, search_index: SearchIndex) -> None:
        """Populate search index with first messages from all sessions (lightweight)."""
        for session_id, meta in self._session_meta.items():
            if meta.first_message and meta.first_message != "(no user message)":
                project_name = get_short_name(decode_project_path(meta.project_id))
                search_index.add_entry(SearchEntry(
                    session_id=session_id,
                    project_id=meta.project_id,
                    project_name=project_name,
                    message_uuid="first",
                    role="user",
                    text_lower=meta.first_message.lower(),
                    text_original=meta.first_message,
                    timestamp=meta.start_time,
                ))

    async def background_full_index(self, search_index: SearchIndex) -> None:
        """Gradually index all sessions in background."""

        def _safe_file_size(p: Path) -> int:
            try:
                return p.stat().st_size
            except OSError:
                return 0

        # Sort by file size descending to index content-rich sessions first
        sessions = sorted(
            self._session_index.items(),
            key=lambda x: _safe_file_size(x[1][1]),
            reverse=True,
        )

        count = 0
        for session_id, (project_id, path) in sessions:
            if search_index.is_session_indexed(session_id):
                continue
            try:
                messages = await asyncio.to_thread(parse_session, path, project_id)
                project_name = get_short_name(decode_project_path(project_id))
                search_index.add_session_messages(
                    session_id, project_id, project_name, messages
                )
                count += 1
                # Yield to event loop every 5 files
                if count % 5 == 0:
                    await asyncio.sleep(0.01)
            except asyncio.CancelledError:
                logger.info(f"Background indexing cancelled after {count} sessions")
                return
            except Exception as e:
                logger.warning(f"Error indexing session {session_id}: {e}")
                continue

        logger.info(f"Background indexing complete: {count} sessions indexed, "
                     f"{search_index.entry_count} total entries")


# ═══════════════════════════════════════════════════════════════════════════════
# WebSocket Connection Manager
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class ClientSubscription:
    websocket: WebSocket
    session_ids: set[str] = field(default_factory=set)
    project_ids: set[str] = field(default_factory=set)
    include_messages: bool = True


class ConnectionManager:
    def __init__(self):
        self._clients: dict[WebSocket, ClientSubscription] = {}

    def add(self, ws: WebSocket) -> None:
        self._clients[ws] = ClientSubscription(websocket=ws)

    def remove(self, ws: WebSocket) -> None:
        self._clients.pop(ws, None)

    async def broadcast(self, event: dict) -> None:
        event_type = event.get("type")
        data = event.get("data", {})
        session_id = data.get("session_id")
        project_id = data.get("project_id")

        disconnected: list[WebSocket] = []
        for ws, sub in self._clients.items():
            if sub.session_ids and session_id and session_id not in sub.session_ids:
                continue
            if sub.project_ids and project_id and project_id not in sub.project_ids:
                continue
            if event_type == "new_message" and not sub.include_messages:
                continue
            try:
                await ws.send_json(event)
            except Exception:
                disconnected.append(ws)

        for ws in disconnected:
            self.remove(ws)

    @property
    def client_count(self) -> int:
        return len(self._clients)


# ═══════════════════════════════════════════════════════════════════════════════
# File Watcher
# ═══════════════════════════════════════════════════════════════════════════════


class SessionFileWatcher:
    """Watches ~/.claude/projects/ for JSONL file changes using watchfiles."""

    def __init__(
        self,
        projects_dir: Path,
        connection_manager: ConnectionManager,
        session_service: SessionService,
        project_service: ProjectService,
        search_index: SearchIndex,
        debounce_ms: int = 500,
    ):
        self.projects_dir = projects_dir
        self.manager = connection_manager
        self.session_service = session_service
        self.project_service = project_service
        self.search_index = search_index
        self.debounce_ms = debounce_ms
        self._running = False
        self._file_offsets: dict[str, int] = {}
        self._known_files: set[str] = set()
        self._known_dirs: set[str] = set()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        self._running = True
        self._init_known_state()
        self._task = asyncio.create_task(self._watch_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def _init_known_state(self) -> None:
        try:
            for entry in os.scandir(self.projects_dir):
                if entry.is_dir():
                    self._known_dirs.add(str(entry.path))
                    try:
                        for f in os.scandir(entry.path):
                            if f.is_file() and is_valid_session_file(f.name):
                                path_str = str(f.path)
                                self._known_files.add(path_str)
                                try:
                                    self._file_offsets[path_str] = f.stat().st_size
                                except OSError:
                                    self._file_offsets[path_str] = 0
                    except (OSError, PermissionError):
                        pass
        except (OSError, PermissionError):
            pass

    async def _watch_loop(self) -> None:
        try:
            from watchfiles import Change, awatch

            async for changes in awatch(
                self.projects_dir,
                debounce=self.debounce_ms,
                recursive=True,
                step=100,
            ):
                if not self._running:
                    break
                await self._process_changes(changes)
        except asyncio.CancelledError:
            return
        except ImportError:
            logger.warning("watchfiles not installed, file watching disabled")
        except Exception as e:
            logger.error(f"File watcher error: {e}")
            now = datetime.now(tz=timezone.utc).isoformat()
            await self.manager.broadcast({
                "type": "error",
                "timestamp": now,
                "data": {"code": "WATCH_ERROR", "message": str(e)},
            })

    async def _process_changes(self, changes: set) -> None:
        from watchfiles import Change

        for change_type, path_str in changes:
            path = Path(path_str)

            # Check for new project directory
            if path.is_dir() and str(path.parent) == str(self.projects_dir):
                if str(path) not in self._known_dirs:
                    self._known_dirs.add(str(path))
                    await self._emit_new_project(path)
                continue

            # Skip non-JSONL and resource fork files
            if path.suffix != ".jsonl" or path.name.startswith("._"):
                continue

            if change_type == Change.added:
                await self._handle_new_session(path)
            elif change_type == Change.modified:
                await self._handle_session_update(path)
            elif change_type == Change.deleted:
                self._known_files.discard(path_str)
                self._file_offsets.pop(path_str, None)

    async def _handle_new_session(self, path: Path) -> None:
        path_str = str(path)
        self._known_files.add(path_str)

        project_id = path.parent.name
        session_id = path.stem

        self.session_service.register_session(session_id, project_id, path)
        self.project_service.update_project_session_count(project_id, 1)

        meta = extract_session_metadata(path, project_id)
        if meta:
            self.session_service.update_session_meta(session_id, meta)

        try:
            self._file_offsets[path_str] = path.stat().st_size
        except OSError:
            self._file_offsets[path_str] = 0

        now = datetime.now(tz=timezone.utc).isoformat()
        await self.manager.broadcast({
            "type": "new_session",
            "timestamp": now,
            "data": {
                "session_id": session_id,
                "project_id": project_id,
                "project_name": get_short_name(decode_project_path(project_id)),
                "first_message": meta.first_message if meta else "",
                "start_time": meta.start_time.isoformat() if meta and meta.start_time else None,
                "model": meta.model if meta else None,
                "version": meta.version if meta else None,
            },
        })

    async def _handle_session_update(self, path: Path) -> None:
        path_str = str(path)
        last_offset = self._file_offsets.get(path_str, 0)

        try:
            current_size = path.stat().st_size
        except OSError:
            return

        if current_size <= last_offset:
            return

        new_messages: list[dict] = []
        try:
            with open(path, "rb") as f:
                f.seek(last_offset)
                raw = f.read()
                self._file_offsets[path_str] = f.tell()
            new_content = raw.decode("utf-8", errors="replace")

            for line in new_content.strip().split("\n"):
                if not line:
                    continue
                try:
                    obj = json.loads(line, strict=False)
                    if obj.get("type") in ("user", "assistant"):
                        msg_data = obj.get("message", {})
                        content = msg_data.get("content", "")
                        msg_info: dict[str, Any] = {
                            "uuid": obj.get("uuid", ""),
                            "type": obj.get("type"),
                            "role": msg_data.get("role", obj.get("type")),
                            "content_text": _extract_text_preview(content, max_len=200),
                            "tool_name": None,
                            "timestamp": obj.get("timestamp"),
                        }
                        if isinstance(content, list):
                            for block in content:
                                if isinstance(block, dict) and block.get("type") == "tool_use":
                                    msg_info["tool_name"] = block.get("name")
                                    break
                        new_messages.append(msg_info)
                except json.JSONDecodeError:
                    continue
        except (OSError, UnicodeDecodeError):
            return

        session_id = path.stem
        project_id = path.parent.name

        now = datetime.now(tz=timezone.utc).isoformat()
        for msg in new_messages:
            await self.manager.broadcast({
                "type": "new_message",
                "timestamp": now,
                "data": {
                    "session_id": session_id,
                    "project_id": project_id,
                    "message": msg,
                },
            })

        await self.manager.broadcast({
            "type": "session_updated",
            "timestamp": now,
            "data": {
                "session_id": session_id,
                "project_id": project_id,
                "new_message_count": len(new_messages),
                "end_time": new_messages[-1]["timestamp"] if new_messages else None,
                "file_size_bytes": current_size,
            },
        })

        # Invalidate cache so next fetch reparses
        self.session_service._cache.invalidate(session_id)

    async def _emit_new_project(self, path: Path) -> None:
        project_id = path.name
        now = datetime.now(tz=timezone.utc).isoformat()
        await self.manager.broadcast({
            "type": "new_project",
            "timestamp": now,
            "data": {
                "id": project_id,
                "display_name": decode_project_path(project_id),
                "short_name": get_short_name(decode_project_path(project_id)),
                "session_count": 0,
            },
        })


# ═══════════════════════════════════════════════════════════════════════════════
# Export Formatters
# ═══════════════════════════════════════════════════════════════════════════════


def format_markdown(conversation: Conversation) -> str:
    """Format a conversation as readable Markdown."""
    meta = conversation.metadata
    lines: list[str] = []

    lines.append(f"# Session: {conversation.session_id}")
    if meta.slug:
        lines.append(f"**Slug**: {meta.slug}")
    lines.append(f"**Project**: {get_short_name(decode_project_path(meta.project_id))}")

    start_str = meta.start_time.strftime("%Y-%m-%d %H:%M:%S") if meta.start_time else "N/A"
    end_str = meta.end_time.strftime("%Y-%m-%d %H:%M:%S") if meta.end_time else "N/A"
    lines.append(f"**Date**: {start_str} ~ {end_str} ({meta.duration_display})")

    if meta.model:
        lines.append(f"**Model**: {meta.model}")
    if meta.version:
        lines.append(f"**Version**: {meta.version}")
    if meta.cwd:
        lines.append(f"**Working Directory**: {meta.cwd}")
    if meta.git_branch:
        lines.append(f"**Git Branch**: {meta.git_branch}")

    lines.append("")
    lines.append("---")
    lines.append("")

    for msg in conversation.messages:
        ts_str = msg.timestamp.strftime("%H:%M:%S") if msg.timestamp else ""

        if msg.type == MessageType.USER and not msg.is_meta:
            lines.append(f"## User {ts_str}")
            lines.append("")
            for block in msg.content:
                if isinstance(block, TextBlock):
                    lines.append(block.text)
                elif isinstance(block, ToolResultBlock):
                    lines.append(f"### Tool Result (`{block.tool_use_id[:12]}...`)")
                    if block.is_error:
                        lines.append("**Error:**")
                    lines.append("```")
                    lines.append(block.content[:5000])
                    lines.append("```")
            lines.append("")

        elif msg.type == MessageType.ASSISTANT:
            model_tag = f" [{msg.model}]" if msg.model and msg.model != "<synthetic>" else ""
            lines.append(f"## Assistant{model_tag} {ts_str}")
            lines.append("")
            for block in msg.content:
                if isinstance(block, TextBlock):
                    lines.append(block.text)
                elif isinstance(block, ThinkingBlock):
                    lines.append("<details><summary>Thinking</summary>")
                    lines.append("")
                    lines.append(block.text[:3000])
                    lines.append("")
                    lines.append("</details>")
                elif isinstance(block, ToolUseBlock):
                    lines.append(f"### Tool: {block.name}")
                    lang = _tool_lang(block.name)
                    lines.append(f"```{lang}")
                    lines.append(_format_tool_input(block.name, block.input))
                    lines.append("```")
            if msg.tool_result:
                lines.append("### Result")
                lines.append("```")
                result_text = msg.tool_result.stdout or msg.tool_result.content or ""
                lines.append(result_text[:5000])
                if msg.tool_result.stderr:
                    lines.append(f"\nSTDERR: {msg.tool_result.stderr[:1000]}")
                lines.append("```")
            lines.append("")

        elif msg.type == MessageType.TOOL_RESULT:
            # Tool result messages are shown inline with tool use
            continue

        elif msg.type == MessageType.SYSTEM:
            lines.append(f"> **System** {ts_str}: {msg.content_text}")
            lines.append("")

        lines.append("---")
        lines.append("")

    return "\n".join(lines)


def _tool_lang(tool_name: str) -> str:
    """Get a suitable code block language for a tool."""
    if tool_name in ("Bash",):
        return "bash"
    elif tool_name in ("Read", "Write", "Edit", "Glob", "Grep"):
        return ""
    elif tool_name.startswith("mcp__"):
        return "json"
    return "json"


def _format_tool_input(tool_name: str, tool_input: dict) -> str:
    """Format tool input for display."""
    if tool_name == "Bash":
        cmd = tool_input.get("command", "")
        desc = tool_input.get("description", "")
        if desc:
            return f"# {desc}\n{cmd}"
        return cmd
    elif tool_name == "Read":
        fp = tool_input.get("file_path", "")
        extra = ""
        if tool_input.get("offset"):
            extra += f" (offset={tool_input['offset']}"
            if tool_input.get("limit"):
                extra += f", limit={tool_input['limit']}"
            extra += ")"
        return f"{fp}{extra}"
    elif tool_name == "Write":
        fp = tool_input.get("file_path", "")
        content = tool_input.get("content", "")
        return f"# Write to: {fp}\n{content[:2000]}"
    elif tool_name == "Edit":
        fp = tool_input.get("file_path", "")
        old = tool_input.get("old_string", "")
        new = tool_input.get("new_string", "")
        return f"# Edit: {fp}\n- old: {old[:500]}\n+ new: {new[:500]}"
    elif tool_name == "Glob":
        return tool_input.get("pattern", str(tool_input))
    elif tool_name == "Grep":
        parts = [f"pattern: {tool_input.get('pattern', '')}"]
        if tool_input.get("path"):
            parts.append(f"path: {tool_input['path']}")
        if tool_input.get("glob"):
            parts.append(f"glob: {tool_input['glob']}")
        return "\n".join(parts)
    else:
        return json.dumps(tool_input, indent=2, ensure_ascii=False)[:3000]


def generate_share_html(conversation: Conversation) -> str:
    """Generate a self-contained shareable HTML file with dark theme."""
    meta = conversation.metadata
    project_name = get_short_name(decode_project_path(meta.project_id))
    title = f"CC LOG - {project_name} - {meta.slug or meta.id[:8]}"

    start_str = meta.start_time.strftime("%Y-%m-%d %H:%M:%S") if meta.start_time else "N/A"
    end_str = meta.end_time.strftime("%Y-%m-%d %H:%M:%S") if meta.end_time else "N/A"

    # Build message HTML
    messages_html = []
    for msg in conversation.messages:
        if msg.is_sidechain:
            continue
        ts = msg.timestamp.strftime("%H:%M:%S") if msg.timestamp else ""

        if msg.type == MessageType.USER and not msg.is_meta:
            content_html = _msg_content_to_html(msg)
            messages_html.append(f'''
<div class="msg msg-user">
  <div class="msg-header"><span class="role role-user">User</span><span class="ts">{ts}</span></div>
  <div class="msg-body">{content_html}</div>
</div>''')

        elif msg.type == MessageType.ASSISTANT:
            model_tag = f' <span class="model">{_esc(msg.model)}</span>' if msg.model and msg.model != "<synthetic>" else ""
            content_html = _msg_content_to_html(msg)
            messages_html.append(f'''
<div class="msg msg-assistant">
  <div class="msg-header"><span class="role role-assistant">Assistant</span>{model_tag}<span class="ts">{ts}</span></div>
  <div class="msg-body">{content_html}</div>
</div>''')

        elif msg.type == MessageType.SYSTEM:
            messages_html.append(f'''
<div class="msg msg-system">
  <div class="msg-header"><span class="role role-system">System</span><span class="ts">{ts}</span></div>
  <div class="msg-body"><em>{_esc(msg.content_text)}</em></div>
</div>''')

    messages_joined = "\n".join(messages_html)

    return f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{_esc(title)}</title>
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
  background: #0d1117; color: #c9d1d9; line-height: 1.6; padding: 20px;
  max-width: 960px; margin: 0 auto;
}}
h1 {{ color: #58a6ff; font-size: 1.4em; margin-bottom: 8px; }}
.meta {{ color: #8b949e; font-size: 0.85em; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #21262d; }}
.meta span {{ margin-right: 16px; }}
.msg {{ margin-bottom: 16px; border: 1px solid #21262d; border-radius: 8px; overflow: hidden; }}
.msg-header {{
  padding: 8px 16px; background: #161b22; display: flex; align-items: center; gap: 8px;
  font-size: 0.85em; border-bottom: 1px solid #21262d;
}}
.msg-body {{ padding: 12px 16px; white-space: pre-wrap; word-break: break-word; font-size: 0.9em; }}
.role {{ font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 0.8em; }}
.role-user {{ background: #1f6feb33; color: #58a6ff; }}
.role-assistant {{ background: #23863633; color: #3fb950; }}
.role-system {{ background: #58585833; color: #8b949e; }}
.model {{ color: #8b949e; font-size: 0.8em; }}
.ts {{ margin-left: auto; color: #484f58; font-size: 0.8em; }}
.thinking {{
  background: #161b22; border-left: 3px solid #8957e5; padding: 8px 12px;
  margin: 8px 0; border-radius: 4px; color: #8b949e; font-size: 0.85em;
}}
.thinking summary {{ cursor: pointer; color: #8957e5; font-weight: 500; }}
.tool-use {{
  background: #161b22; border-left: 3px solid #d29922; padding: 8px 12px;
  margin: 8px 0; border-radius: 4px;
}}
.tool-use summary {{ cursor: pointer; color: #d29922; font-weight: 500; font-size: 0.85em; }}
.tool-result {{
  background: #0d1117; border: 1px solid #21262d; padding: 8px 12px;
  margin: 4px 0; border-radius: 4px; font-size: 0.85em;
}}
.tool-result.error {{ border-color: #f85149; }}
pre {{ background: #0d1117; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 0.85em; border: 1px solid #21262d; }}
code {{ font-family: 'SF Mono', 'Fira Code', monospace; }}
a {{ color: #58a6ff; }}
.footer {{ margin-top: 32px; padding-top: 16px; border-top: 1px solid #21262d; color: #484f58; font-size: 0.8em; text-align: center; }}
@media (max-width: 640px) {{
  body {{ padding: 12px; }}
  .msg-body {{ padding: 8px 12px; }}
}}
</style>
</head>
<body>
<h1>{_esc(title)}</h1>
<div class="meta">
  <span>Project: {_esc(project_name)}</span>
  <span>Time: {start_str} ~ {end_str} ({meta.duration_display})</span>
  {f'<span>Model: {_esc(meta.model)}</span>' if meta.model else ''}
  {f'<span>Branch: {_esc(meta.git_branch)}</span>' if meta.git_branch else ''}
  <span>Messages: {len(conversation.messages)}</span>
</div>

{messages_joined}

<div class="footer">
  Generated by CC LOG | Session {conversation.session_id}
</div>
</body>
</html>'''


def _esc(text: str | None) -> str:
    """HTML-escape text."""
    if text is None:
        return ""
    return html_module.escape(str(text))


def _msg_content_to_html(msg: Message) -> str:
    """Convert message content blocks to HTML."""
    parts: list[str] = []
    for block in msg.content:
        if isinstance(block, TextBlock):
            parts.append(f"<div>{_esc(block.text)}</div>")
        elif isinstance(block, ThinkingBlock):
            text = block.text[:3000]
            parts.append(
                f'<details class="thinking"><summary>Thinking</summary>'
                f'<pre>{_esc(text)}</pre></details>'
            )
        elif isinstance(block, ToolUseBlock):
            input_str = _format_tool_input(block.name, block.input)
            parts.append(
                f'<details class="tool-use"><summary>Tool: {_esc(block.name)}</summary>'
                f'<pre><code>{_esc(input_str)}</code></pre></details>'
            )
        elif isinstance(block, ToolResultBlock):
            err_class = " error" if block.is_error else ""
            parts.append(
                f'<div class="tool-result{err_class}">'
                f'<pre>{_esc(block.content[:5000])}</pre></div>'
            )

    # Add tool result if paired
    if msg.tool_result:
        result = msg.tool_result
        content = result.stdout or result.content or ""
        err_class = " error" if result.is_error else ""
        parts.append(
            f'<div class="tool-result{err_class}">'
            f'<pre>{_esc(content[:5000])}</pre></div>'
        )
        if result.stderr:
            parts.append(
                f'<div class="tool-result error">'
                f'<pre>STDERR: {_esc(result.stderr[:1000])}</pre></div>'
            )

    return "\n".join(parts)


def format_json_export(conversation: Conversation) -> str:
    """Export conversation as formatted JSON."""
    return conversation.model_dump_json(indent=2)


# ═══════════════════════════════════════════════════════════════════════════════
# Application Error Handler
# ═══════════════════════════════════════════════════════════════════════════════


class AppError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        self.status_code = status_code
        self.code = code
        self.message = message


# ═══════════════════════════════════════════════════════════════════════════════
# FastAPI Application + Routes
# ═══════════════════════════════════════════════════════════════════════════════


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifecycle: startup and shutdown."""
    start_time = time.monotonic()

    settings = Settings.from_env()
    projects_dir = settings.get_projects_dir()

    # Validate
    if not projects_dir.exists():
        logger.error(f"Projects directory not found: {projects_dir}")
        raise RuntimeError(f"Claude projects directory not found: {projects_dir}")

    logger.info(f"Scanning {projects_dir} ...")

    # Discover sessions
    sessions_map = discover_sessions(projects_dir)

    # Build project index
    project_service = ProjectService(projects_dir)
    project_service.build_index(sessions_map)

    # Build session index
    session_service = SessionService(
        projects_dir, max_cache_size=settings.max_session_cache_size
    )
    session_service.build_initial_index(sessions_map)

    logger.info(
        f"Found {project_service.project_count} projects, "
        f"{session_service.session_count} sessions "
        f"in {time.monotonic() - start_time:.1f}s"
    )

    # Initialize search index
    search_index = SearchIndex(snippet_chars=settings.search_snippet_chars)
    session_service.populate_search_index(search_index)
    logger.info(f"Search index: {search_index.entry_count} initial entries")

    # Start background full indexing
    bg_indexer = asyncio.create_task(
        session_service.background_full_index(search_index)
    )

    # Connection manager & file watcher
    connection_manager = ConnectionManager()
    watcher = None
    if settings.watch_enabled:
        watcher = SessionFileWatcher(
            projects_dir=projects_dir,
            connection_manager=connection_manager,
            session_service=session_service,
            project_service=project_service,
            search_index=search_index,
            debounce_ms=settings.watch_debounce_ms,
        )
        await watcher.start()
        logger.info("File watcher started")

    # Store in app state
    app.state.settings = settings
    app.state.project_service = project_service
    app.state.session_service = session_service
    app.state.search_index = search_index
    app.state.connection_manager = connection_manager
    app.state.watcher = watcher
    app.state.start_time = start_time

    yield

    # Shutdown
    logger.info("Shutting down...")
    if watcher:
        await watcher.stop()
    bg_indexer.cancel()
    try:
        await bg_indexer
    except asyncio.CancelledError:
        pass
    logger.info("Shutdown complete")


app = FastAPI(
    lifespan=lifespan,
    title="CC LOG",
    description="Claude Code Session Log Viewer",
    version="1.0.0",
)

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Error handler
@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


# ── Helper accessors ─────────────────────────────────────────────────────────

def _project_svc(request: Request) -> ProjectService:
    return request.app.state.project_service


def _session_svc(request: Request) -> SessionService:
    return request.app.state.session_service


def _search_idx(request: Request) -> SearchIndex:
    return request.app.state.search_index


# ── Projects ──────────────────────────────────────────────────────────────────

@app.get("/api/projects", response_model=ProjectListResponse)
async def list_projects(
    request: Request,
    sort_by: str = Query("last_active", enum=["last_active", "name", "session_count"]),
    sort_order: str = Query("desc", enum=["asc", "desc"]),
):
    svc = _project_svc(request)
    projects = svc.list_projects(sort_by, sort_order)
    return ProjectListResponse(projects=projects, total_count=len(projects))


@app.get("/api/projects/{project_id}", response_model=ProjectModel)
async def get_project(request: Request, project_id: str):
    svc = _project_svc(request)
    project = svc.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")
    return project


@app.get("/api/projects/{project_id}/sessions", response_model=SessionListResponse)
async def list_sessions(
    request: Request,
    project_id: str,
    sort_by: str = Query("start_time", enum=["start_time", "duration", "message_count", "file_size"]),
    sort_order: str = Query("desc", enum=["asc", "desc"]),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    p_svc = _project_svc(request)
    s_svc = _session_svc(request)

    project = p_svc.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project {project_id} not found")

    sessions = s_svc.list_sessions(project_id, sort_by, sort_order, limit, offset)
    return SessionListResponse(
        sessions=sessions, project=project, total_count=project.session_count
    )


# ── Sessions ──────────────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_id}")
async def get_session(
    request: Request,
    session_id: str,
    include_thinking: bool = Query(True),
    include_tool_results: bool = Query(True),
    include_sidechain: bool = Query(False),
):
    svc = _session_svc(request)
    search = _search_idx(request)

    conversation = svc.get_conversation(
        session_id, include_thinking, include_tool_results, include_sidechain
    )

    # Index the session for search if not already done
    if not search.is_session_indexed(session_id):
        project_name = get_short_name(
            decode_project_path(conversation.project_id)
        )
        search.add_session_messages(
            session_id, conversation.project_id, project_name,
            conversation.messages,
        )

    return conversation


@app.get("/api/sessions/{session_id}/messages")
async def get_session_messages(
    request: Request,
    session_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=1000),
):
    svc = _session_svc(request)
    conversation = svc.get_conversation(session_id)
    messages = conversation.messages[offset:offset + limit]
    return {
        "messages": [m.model_dump() for m in messages],
        "total": len(conversation.messages),
        "offset": offset,
        "limit": limit,
    }


# ── Export ────────────────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_id}/export")
async def export_session(
    request: Request,
    session_id: str,
    format: ExportFormat = Query(ExportFormat.MARKDOWN),
):
    svc = _session_svc(request)
    conversation = svc.get_conversation(session_id)
    slug = conversation.metadata.slug or session_id[:8]

    if format == ExportFormat.JSON:
        content = format_json_export(conversation)
        return Response(
            content=content,
            media_type="application/json",
            headers={
                "Content-Disposition": f'attachment; filename="cclog-{slug}.json"'
            },
        )
    elif format == ExportFormat.MARKDOWN:
        content = format_markdown(conversation)
        return Response(
            content=content,
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="cclog-{slug}.md"'
            },
        )
    elif format == ExportFormat.HTML:
        content = generate_share_html(conversation)
        return Response(
            content=content,
            media_type="text/html; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="cclog-{slug}.html"'
            },
        )


@app.post("/api/sessions/batch-export")
async def batch_export_sessions(
    request: Request,
    body: BatchExportRequest,
):
    svc = _session_svc(request)

    if not body.session_ids:
        raise HTTPException(status_code=400, detail="No session IDs provided")
    if len(body.session_ids) > 100:
        raise HTTPException(status_code=400, detail="Maximum 100 sessions per batch")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for sid in body.session_ids:
            try:
                conversation = svc.get_conversation(sid)
                slug = conversation.metadata.slug or sid[:8]
                # Use session ID prefix to avoid filename collisions in zip
                filename = f"cclog-{slug}-{sid[:8]}"

                if body.format == ExportFormat.JSON:
                    content = format_json_export(conversation)
                    ext = "json"
                elif body.format == ExportFormat.HTML:
                    content = generate_share_html(conversation)
                    ext = "html"
                else:
                    content = format_markdown(conversation)
                    ext = "md"

                zf.writestr(f"{filename}.{ext}", content)
            except HTTPException:
                # Skip sessions that can't be found
                continue
            except Exception as e:
                logger.warning(f"Error exporting session {sid}: {e}")
                continue

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="cclog-export.zip"'
        },
    )


# ── Share ─────────────────────────────────────────────────────────────────────

@app.get("/api/sessions/{session_id}/share")
async def share_session(request: Request, session_id: str):
    """Generate a standalone shareable HTML file for a session."""
    svc = _session_svc(request)
    conversation = svc.get_conversation(session_id)
    html_content = generate_share_html(conversation)
    return HTMLResponse(content=html_content)


# ── Search ────────────────────────────────────────────────────────────────────

@app.get("/api/search", response_model=SearchResponse)
async def search(
    request: Request,
    q: str = Query(..., min_length=1, max_length=200),
    project_id: str | None = Query(None),
    role: str | None = Query(None, enum=["user", "assistant"]),
    limit: int = Query(50, ge=1, le=200),
):
    search_index = _search_idx(request)
    t0 = time.monotonic()
    results = search_index.search(q, project_id=project_id, role=role, limit=limit)
    elapsed = (time.monotonic() - t0) * 1000

    return SearchResponse(
        query=q,
        total_results=len(results),
        results=results,
        search_time_ms=round(elapsed, 2),
    )


# ── Stats ─────────────────────────────────────────────────────────────────────

@app.get("/api/stats", response_model=StatsResponse)
async def get_stats(request: Request):
    p_svc = _project_svc(request)
    s_svc = _session_svc(request)

    projects = p_svc.list_projects()
    total_size = sum(p.total_size_bytes for p in projects)
    total_msgs = sum(
        m.message_count for m in s_svc._session_meta.values()
    )

    all_starts = [
        m.start_time for m in s_svc._session_meta.values()
        if m.start_time
    ]
    oldest = min(all_starts) if all_starts else None
    newest = max(all_starts) if all_starts else None

    return StatsResponse(
        total_projects=p_svc.project_count,
        total_sessions=s_svc.session_count,
        total_messages_estimated=total_msgs,
        total_size_bytes=total_size,
        oldest_session=oldest,
        newest_session=newest,
    )


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check(request: Request):
    start = request.app.state.start_time
    settings = request.app.state.settings
    p_svc = _project_svc(request)
    s_svc = _session_svc(request)
    search = _search_idx(request)
    mgr = request.app.state.connection_manager

    return {
        "status": "ok",
        "uptime_seconds": round(time.monotonic() - start, 1),
        "projects_loaded": p_svc.project_count,
        "sessions_indexed": s_svc.session_count,
        "search_entries": search.entry_count,
        "websocket_clients": mgr.client_count,
        "watcher_active": settings.watch_enabled and request.app.state.watcher is not None,
    }


# ── WebSocket ─────────────────────────────────────────────────────────────────

@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    """WebSocket endpoint for real-time log updates."""
    await websocket.accept()
    mgr: ConnectionManager = websocket.app.state.connection_manager
    mgr.add(websocket)

    try:
        while True:
            try:
                data = await websocket.receive_json()
            except (json.JSONDecodeError, ValueError):
                # Malformed JSON from client -- ignore and continue
                continue

            msg_type = data.get("type") if isinstance(data, dict) else None

            if msg_type == "subscribe":
                sub_data = data.get("data", {})
                sub = mgr._clients.get(websocket)
                if sub:
                    if sub_data.get("session_ids"):
                        sub.session_ids = set(sub_data["session_ids"])
                    if sub_data.get("project_ids"):
                        sub.project_ids = set(sub_data["project_ids"])
                    if "include_messages" in sub_data:
                        sub.include_messages = sub_data["include_messages"]

            elif msg_type == "unsubscribe":
                sub_data = data.get("data", {})
                sub = mgr._clients.get(websocket)
                if sub:
                    for sid in sub_data.get("session_ids", []):
                        sub.session_ids.discard(sid)
                    for pid in sub_data.get("project_ids", []):
                        sub.project_ids.discard(pid)

            elif msg_type == "pong":
                pass  # Keepalive response

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.warning("WebSocket error", exc_info=True)
    finally:
        mgr.remove(websocket)


# ── Static files & SPA fallback ──────────────────────────────────────────────

# Mount static files
_static_dir = Path(__file__).parent / "static"
if _static_dir.exists():
    app.mount("/static", StaticFiles(directory=str(_static_dir)), name="static")

    @app.get("/", response_class=HTMLResponse)
    async def serve_index():
        index_path = _static_dir / "index.html"
        if index_path.exists():
            return HTMLResponse(content=index_path.read_text(encoding="utf-8"))
        return HTMLResponse(
            content="<h1>CC LOG</h1><p>Frontend not built yet. API is available at /api/</p>",
            status_code=200,
        )
else:
    @app.get("/", response_class=HTMLResponse)
    async def serve_index_fallback():
        return HTMLResponse(
            content=(
                "<h1>CC LOG</h1>"
                "<p>Static directory not found. API is available at <a href='/docs'>/docs</a></p>"
            ),
            status_code=200,
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Entry Point
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    settings = Settings.from_env()
    uvicorn.run(
        "src.server:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        log_level="info",
    )
