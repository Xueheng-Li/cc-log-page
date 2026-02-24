"""
Test copy button behavior for Claude (assistant) messages.

Tests that the copy button copies ALL content including tool uses and results,
not just the first text block.

Usage:
    pytest tests/test_copy_button.py -v
"""

import json
import os
import signal
import subprocess
import sys
import time

import pytest
from playwright.sync_api import sync_playwright, expect

SERVER_PORT = 15173  # Use non-default port to avoid conflicts
SERVER_URL = f"http://localhost:{SERVER_PORT}"


@pytest.fixture(scope="module")
def tmp_claude_dir(tmp_path_factory):
    """Create a temporary Claude directory with test JSONL data."""
    base = tmp_path_factory.mktemp("claude")
    projects_dir = base / "projects"

    # Create a project directory (simulates ~/.claude/projects/-Users-test-myproject/)
    project_dir = projects_dir / "-Users-test-myproject"
    project_dir.mkdir(parents=True)

    session_id = "test-session-001"
    jsonl_file = project_dir / f"{session_id}.jsonl"

    # Write test JSONL with various message types
    messages = [
        # User message
        {
            "type": "user",
            "uuid": "msg-user-001",
            "timestamp": "2026-02-24T10:00:00Z",
            "message": {"role": "user", "content": "Please list the files and tell me what you find."},
        },
        # Assistant message with text + tool_use + text (the key test case)
        {
            "type": "assistant",
            "uuid": "msg-assistant-001",
            "timestamp": "2026-02-24T10:00:05Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I'll list the files for you."},
                    {
                        "type": "tool_use",
                        "id": "tool-001",
                        "name": "Bash",
                        "input": {"command": "ls -la /tmp"},
                    },
                    {"type": "text", "text": "Here are the files I found."},
                ],
            },
        },
        # Tool result
        {
            "type": "tool_result",
            "uuid": "msg-result-001",
            "timestamp": "2026-02-24T10:00:06Z",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool-001",
                        "content": "total 0\ndrwxr-xr-x  2 user user 40 Feb 24 10:00 .\ndrwxr-xr-x  3 user user 60 Feb 24 09:00 ..",
                    }
                ],
            },
        },
        # Assistant message with ONLY tool_use (no text blocks)
        {
            "type": "assistant",
            "uuid": "msg-assistant-002",
            "timestamp": "2026-02-24T10:00:10Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "tool-002",
                        "name": "Read",
                        "input": {"file_path": "/tmp/test.txt"},
                    },
                ],
            },
        },
        # Assistant message with thinking + text
        {
            "type": "assistant",
            "uuid": "msg-assistant-003",
            "timestamp": "2026-02-24T10:00:15Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "Let me analyze the results carefully."},
                    {"type": "text", "text": "Based on the analysis, everything looks good."},
                ],
            },
        },
    ]

    with open(jsonl_file, "w") as f:
        for msg in messages:
            f.write(json.dumps(msg) + "\n")

    return base


@pytest.fixture(scope="module")
def server(tmp_claude_dir):
    """Start the CC LOG server with test data."""
    env = os.environ.copy()
    env["CCLOG_CLAUDE_DIR"] = str(tmp_claude_dir)
    env["PORT"] = str(SERVER_PORT)  # run.py uses PORT, not CCLOG_PORT
    env["CCLOG_WATCH_ENABLED"] = "false"

    proc = subprocess.Popen(
        [sys.executable, "run.py", "--no-browser"],
        cwd="/Users/xueheng/PythonProjects/cc-log",
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    # Wait for server to be ready
    import urllib.request
    for _ in range(30):
        try:
            urllib.request.urlopen(f"{SERVER_URL}/api/health", timeout=1)
            break
        except Exception:
            time.sleep(0.5)
    else:
        proc.terminate()
        stdout, stderr = proc.communicate(timeout=5)
        pytest.fail(f"Server failed to start.\nstdout: {stdout.decode()}\nstderr: {stderr.decode()}")

    yield proc

    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="module")
def browser_context(server):
    """Create a Playwright browser context with clipboard permissions."""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            permissions=["clipboard-read", "clipboard-write"],
        )
        yield context
        context.close()
        browser.close()


def navigate_to_session(page):
    """Navigate to the test session in the app."""
    page.goto(SERVER_URL, wait_until="domcontentloaded")
    page.wait_for_selector(".project-item", timeout=10000)

    # Click the first (and only) project
    page.click(".project-item")
    page.wait_for_selector(".session-item", timeout=10000)

    # Click the first session
    page.click(".session-item")
    page.wait_for_selector(".message-assistant", timeout=10000)


class TestCopyButtonAssistantMessages:
    """Test that copy button on assistant messages copies full content."""

    def test_copy_includes_tool_use(self, browser_context):
        """Copy button on assistant message with text+tool_use should include tool content."""
        page = browser_context.new_page()
        navigate_to_session(page)

        # Find the first assistant message (has text + tool_use + text)
        msg = page.locator(".message-assistant").first
        msg.hover()

        # Click copy button
        copy_btn = msg.locator(".btn-copy-msg")
        copy_btn.click()

        # Read clipboard
        clipboard = page.evaluate("() => navigator.clipboard.readText()")

        # Should contain both text blocks
        assert "I'll list the files for you" in clipboard
        assert "Here are the files I found" in clipboard
        # Should contain tool use info
        assert "Bash" in clipboard
        assert "ls -la /tmp" in clipboard

        page.close()

    def test_copy_tool_only_message(self, browser_context):
        """Copy button on assistant message with only tool_use (no text) should still work."""
        page = browser_context.new_page()
        navigate_to_session(page)

        # Second assistant message has only tool_use
        msg = page.locator(".message-assistant").nth(1)
        msg.hover()

        copy_btn = msg.locator(".btn-copy-msg")
        copy_btn.click()

        clipboard = page.evaluate("() => navigator.clipboard.readText()")

        # Should contain tool info even without text blocks
        assert "Read" in clipboard
        assert "/tmp/test.txt" in clipboard

        page.close()

    def test_copy_thinking_and_text(self, browser_context):
        """Copy button on message with thinking+text should include both."""
        page = browser_context.new_page()
        navigate_to_session(page)

        # Third assistant message has thinking + text
        msg = page.locator(".message-assistant").nth(2)
        msg.hover()

        copy_btn = msg.locator(".btn-copy-msg")
        copy_btn.click()

        clipboard = page.evaluate("() => navigator.clipboard.readText()")

        # Should contain the thinking block
        assert "analyze the results" in clipboard
        # Should contain the text block
        assert "everything looks good" in clipboard

        page.close()

    def test_copy_user_message_still_works(self, browser_context):
        """Copy button on user messages should still work correctly."""
        page = browser_context.new_page()
        navigate_to_session(page)

        msg = page.locator(".message-user").first
        msg.hover()

        copy_btn = msg.locator(".btn-copy-msg")
        copy_btn.click()

        clipboard = page.evaluate("() => navigator.clipboard.readText()")

        assert "list the files" in clipboard

        page.close()

    def test_toast_shown_on_copy(self, browser_context):
        """Verify toast notification appears after copying."""
        page = browser_context.new_page()
        navigate_to_session(page)

        msg = page.locator(".message-assistant").first
        msg.hover()

        copy_btn = msg.locator(".btn-copy-msg")
        copy_btn.click()

        # Toast should appear
        toast = page.locator(".toast")
        expect(toast).to_be_visible(timeout=3000)

        page.close()


class TestGetMessageCopyTextUnit:
    """Unit-level tests for getMessageCopyText via page.evaluate."""

    def test_extracts_all_text_blocks(self, browser_context):
        """getMessageCopyText should join all text blocks."""
        page = browser_context.new_page()
        page.goto(SERVER_URL, wait_until="domcontentloaded")
        page.wait_for_selector(".project-item", timeout=10000)

        result = page.evaluate("""() => {
            // Set up mock state
            state.messages = [{
                content: [
                    { type: 'text', text: 'First paragraph.' },
                    { type: 'text', text: 'Second paragraph.' },
                ]
            }];

            // Create a mock message element
            const el = document.createElement('div');
            el.dataset.index = '0';
            el.classList.add('message');

            return getMessageCopyText(el);
        }""")

        assert "First paragraph." in result
        assert "Second paragraph." in result

        page.close()

    def test_extracts_tool_use(self, browser_context):
        """getMessageCopyText should include tool use blocks."""
        page = browser_context.new_page()
        page.goto(SERVER_URL, wait_until="domcontentloaded")
        page.wait_for_selector(".project-item", timeout=10000)

        result = page.evaluate("""() => {
            state.messages = [{
                content: [
                    { type: 'text', text: 'Let me check.' },
                    { type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } },
                ]
            }];

            const el = document.createElement('div');
            el.dataset.index = '0';
            el.classList.add('message');

            return getMessageCopyText(el);
        }""")

        assert "Let me check." in result
        assert "Bash" in result
        assert "echo hello" in result

        page.close()

    def test_extracts_tool_result(self, browser_context):
        """getMessageCopyText should include tool result blocks."""
        page = browser_context.new_page()
        page.goto(SERVER_URL, wait_until="domcontentloaded")
        page.wait_for_selector(".project-item", timeout=10000)

        result = page.evaluate("""() => {
            state.messages = [{
                content: [
                    { type: 'tool_result', content: 'file1.txt\\nfile2.txt', is_error: false },
                ]
            }];

            const el = document.createElement('div');
            el.dataset.index = '0';
            el.classList.add('message');

            return getMessageCopyText(el);
        }""")

        assert "Result" in result
        assert "file1.txt" in result

        page.close()

    def test_fallback_for_string_content(self, browser_context):
        """getMessageCopyText should handle plain string content."""
        page = browser_context.new_page()
        page.goto(SERVER_URL, wait_until="domcontentloaded")
        page.wait_for_selector(".project-item", timeout=10000)

        result = page.evaluate("""() => {
            state.messages = [{
                content: 'Simple text message'
            }];

            const el = document.createElement('div');
            el.dataset.index = '0';
            el.classList.add('message');

            return getMessageCopyText(el);
        }""")

        assert result == "Simple text message"

        page.close()

    def test_fallback_when_no_message_data(self, browser_context):
        """getMessageCopyText should fall back to DOM text when no message data."""
        page = browser_context.new_page()
        page.goto(SERVER_URL, wait_until="domcontentloaded")
        page.wait_for_selector(".project-item", timeout=10000)

        result = page.evaluate("""() => {
            state.messages = [];

            const el = document.createElement('div');
            el.dataset.index = '999';
            el.classList.add('message');

            const body = document.createElement('div');
            body.className = 'message-body';

            const header = document.createElement('div');
            header.className = 'message-header';
            header.textContent = 'Claude 10:00';

            const content = document.createElement('div');
            content.className = 'message-content';
            content.textContent = 'Fallback content from DOM';

            body.appendChild(header);
            body.appendChild(content);
            el.appendChild(body);

            return getMessageCopyText(el);
        }""")

        assert "Fallback content from DOM" in result
        # Header text should NOT be included
        assert "Claude 10:00" not in result

        page.close()
