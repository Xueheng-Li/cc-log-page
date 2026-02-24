/**
 * CC LOG - Claude Code Session Log Viewer
 * Client-side Application JavaScript
 *
 * Three-panel layout: Projects | Sessions | Messages
 * Chinese UI (Simplified Chinese)
 */

// ============================================================================
// i18n - Chinese UI strings
// ============================================================================

const i18n = {
  loading: '加载中...',
  noProjects: '未找到项目',
  noProjectsHint: 'CC LOG 读取 ~/.claude/projects/ 目录',
  noSessions: '暂无会话',
  noSessionsHint: '该项目没有 JSONL 会话日志',
  selectProject: '请选择一个项目',
  selectProjectHint: '从左侧面板选择一个项目以查看会话',
  selectSession: '请选择一个会话',
  selectSessionHint: '从中间面板选择一个会话以查看对话',
  searchPlaceholder: '搜索项目、会话、消息...',
  filterProjects: '筛选项目...',
  filterSessions: '筛选会话...',
  copied: '已复制到剪贴板',
  copiedResumeCmd: 'Resume 命令已复制',
  exportSuccess: '导出成功',
  exportFailed: '导出失败',
  connected: '已连接',
  disconnected: '已断开',
  reconnecting: '重连中...',
  messages: '条消息',
  sessions: '个会话',
  projects: '个项目',
  you: '你',
  assistant: 'Claude',
  system: '系统',
  thinking: '思考中...',
  thinkingLabel: '思考过程',
  toolCall: '工具调用',
  toolResult: '执行结果',
  showMore: '显示更多',
  showLess: '收起',
  expandAll: '全部展开',
  collapseAll: '全部折叠',
  copyMessage: '复制消息',
  copyCode: '复制代码',
  copyResumeCmd: '复制 Resume 命令',
  copySessionId: '复制会话 ID',
  exportAs: '导出为',
  exportJson: '导出 JSON',
  exportMarkdown: '导出 Markdown',
  share: '分享',
  shareSession: '分享会话',
  searchInSession: '会话内搜索',
  newMessages: '有新消息',
  recentFirst: '最近优先',
  oldestFirst: '最早优先',
  mostMessages: '消息最多',
  selectAll: '全选',
  deselectAll: '取消全选',
  batchExport: '批量导出',
  error: '错误',
  result: '结果',
  success: '成功',
  failed: '失败',
  interrupted: '已中断',
  imageContent: '[图片内容]',
  noResults: '未找到结果',
  searchResults: '搜索结果',
  ago: '前',
  justNow: '刚刚',
  minutesAgo: '分钟前',
  hoursAgo: '小时前',
  daysAgo: '天前',
  version: '版本',
};

// ============================================================================
// Application State
// ============================================================================

const state = {
  projects: [],
  sessions: [],
  messages: [],
  conversationMetadata: null,
  selectedProjectId: null,
  selectedSessionId: null,
  searchQuery: '',
  searchResults: [],
  sessionFilter: '',
  projectFilter: '',
  batchSelectedIds: new Set(),
  batchMode: false,
  panelWidths: { left: 250, middle: 350 },
  focusedPanel: 'project',
  wsConnected: false,
  wsReconnectAttempts: 0,
  loading: { projects: false, sessions: false, messages: false },
  collapsedBlocks: {},
  isAutoScrollEnabled: true,
  isSearchModalOpen: false,
  sessionSearchQuery: '',
  sessionSearchMatches: [],
  sessionSearchCurrentIndex: -1,
  stats: null,
};

// ============================================================================
// Utility Functions
// ============================================================================

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function truncate(str, len = 200) {
  if (!str) return '';
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

function formatTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    // Format in Beijing time (UTC+8)
    return d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return String(iso);
  }
}

function formatShortTimestamp(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return '';
  }
}

function formatRelativeTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);
    if (diffMin < 1) return i18n.justNow;
    if (diffMin < 60) return `${diffMin}${i18n.minutesAgo}`;
    if (diffHr < 24) return `${diffHr}${i18n.hoursAgo}`;
    if (diffDay < 30) return `${diffDay}${i18n.daysAgo}`;
    return formatShortTimestamp(iso);
  } catch {
    return '';
  }
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}小时${mins}分钟`;
  if (mins > 0) return `${mins}分${secs}秒`;
  return `${secs}秒`;
}

function formatDurationShort(seconds) {
  if (!seconds || seconds <= 0) return '';
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `<1m`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

function decodeProjectName(dirName) {
  if (!dirName || dirName === '-') return '/';
  return dirName.replace(/-/g, '/');
}

function getShortProjectName(project) {
  if (project.short_name) return project.short_name;
  const decoded = project.display_name || decodeProjectName(project.id);
  const parts = decoded.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || '/';
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).then(() => {
    showToast(i18n.copied, 'success');
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(i18n.copied, 'success');
    } catch {
      showToast('复制失败', 'error');
    }
    document.body.removeChild(ta);
  });
}

function downloadFile(content, filename, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

// ============================================================================
// Toast Notifications
// ============================================================================

function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const iconSvg = type === 'success'
    ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
    : type === 'error'
    ? '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
    : '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  toast.innerHTML = `
    <span class="toast-icon">${iconSvg}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => toast.classList.add('toast-show'));

  const dismiss = () => {
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 300);
  };

  const autoDismiss = type === 'error' ? 5000 : duration;
  setTimeout(dismiss, autoDismiss);
  toast.addEventListener('click', dismiss);
}

// ============================================================================
// API Client
// ============================================================================

const api = {
  async request(url, options = {}) {
    try {
      const response = await fetch(url, {
        headers: { 'Content-Type': 'application/json', ...options.headers },
        ...options,
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `HTTP ${response.status}`);
      }
      return response;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      console.error(`API Error: ${url}`, err);
      throw err;
    }
  },

  async fetchProjects(sortBy = 'last_active', sortOrder = 'desc') {
    const res = await this.request(`/api/projects?sort_by=${sortBy}&sort_order=${sortOrder}`);
    return res.json();
  },

  async fetchSessions(projectId, sortBy = 'start_time', sortOrder = 'desc', limit = 100, offset = 0) {
    const res = await this.request(
      `/api/projects/${encodeURIComponent(projectId)}/sessions?sort_by=${sortBy}&sort_order=${sortOrder}&limit=${limit}&offset=${offset}`
    );
    return res.json();
  },

  async fetchMessages(sessionId) {
    const res = await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`);
    return res.json();
  },

  async searchGlobal(query, projectId = null, limit = 50) {
    let url = `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
    if (projectId) url += `&project_id=${encodeURIComponent(projectId)}`;
    const res = await this.request(url);
    return res.json();
  },

  async exportSession(sessionId, format = 'markdown') {
    const res = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`
    );
    return res;
  },

  async batchExport(sessionIds, format = 'markdown') {
    const res = await this.request('/api/sessions/batch-export', {
      method: 'POST',
      body: JSON.stringify({ session_ids: sessionIds, format: format }),
    });
    return res;
  },

  async shareSession(sessionId) {
    const res = await this.request(
      `/api/sessions/${encodeURIComponent(sessionId)}/export?format=html`
    );
    return res;
  },

  async fetchStats() {
    const res = await this.request('/api/stats');
    return res.json();
  },
};

// ============================================================================
// WebSocket Client
// ============================================================================

const ws = {
  socket: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  maxReconnectDelay: 30000,
  pingInterval: null,

  connect() {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws/live`;

    try {
      this.socket = new WebSocket(url);
    } catch (err) {
      console.error('WebSocket creation failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.socket.onopen = () => {
      console.log('WebSocket connected');
      state.wsConnected = true;
      state.wsReconnectAttempts = 0;
      this.reconnectDelay = 1000;
      updateConnectionStatus();

      // Start keepalive ping
      this.pingInterval = setInterval(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'pong' }));
        }
      }, 30000);
    };

    this.socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (err) {
        console.error('WebSocket message parse error:', err);
      }
    };

    this.socket.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      state.wsConnected = false;
      clearInterval(this.pingInterval);
      updateConnectionStatus();
      if (event.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = (err) => {
      console.error('WebSocket error:', err);
      state.wsConnected = false;
      updateConnectionStatus();
    };
  },

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    state.wsReconnectAttempts++;
    updateConnectionStatus();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  },

  handleMessage(msg) {
    switch (msg.type) {
      case 'new_session':
        this.handleNewSession(msg.data);
        break;
      case 'new_message':
        this.handleNewMessage(msg.data);
        break;
      case 'session_updated':
        this.handleSessionUpdated(msg.data);
        break;
      case 'new_project':
        this.handleNewProject(msg.data);
        break;
      case 'ping':
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'pong' }));
        }
        break;
      case 'error':
        console.error('Server error:', msg.data);
        showToast(`${i18n.error}: ${msg.data.message || msg.data.code}`, 'error');
        break;
    }
  },

  handleNewSession(data) {
    if (state.selectedProjectId && data.project_id === state.selectedProjectId) {
      // Prepend to session list
      const newSession = {
        id: data.session_id,
        project_id: data.project_id,
        first_message: data.first_message || '',
        message_count: 1,
        start_time: data.start_time,
        end_time: data.start_time,
        duration_seconds: 0,
        duration_display: '',
        model: data.model,
        version: data.version,
        file_size_bytes: 0,
        is_live: true,
      };
      state.sessions = [newSession, ...state.sessions];
      renderSessions(state.sessions);
    }
    // Update project session count
    const project = state.projects.find(p => p.id === data.project_id);
    if (project) {
      project.session_count = (project.session_count || 0) + 1;
      renderProjects(state.projects);
    }
  },

  handleNewMessage(data) {
    if (state.selectedSessionId && data.session_id === state.selectedSessionId) {
      // If we have message data, append it
      if (data.message) {
        state.messages.push(data.message);
        appendMessage(data.message);
        if (state.isAutoScrollEnabled) {
          scrollMessagesToBottom();
        } else {
          showNewMessagesBadge();
        }
      }
    }
    // Mark session as live
    const session = state.sessions.find(s => s.id === data.session_id);
    if (session) {
      session.is_live = true;
    }
  },

  handleSessionUpdated(data) {
    const session = state.sessions.find(s => s.id === data.session_id);
    if (session) {
      if (data.message_count !== undefined) session.message_count = data.message_count;
      if (data.end_time !== undefined) session.end_time = data.end_time;
      if (data.file_size_bytes !== undefined) session.file_size_bytes = data.file_size_bytes;
      renderSessionItem(session);
    }
  },

  handleNewProject(data) {
    const exists = state.projects.find(p => p.id === data.id);
    if (!exists) {
      state.projects.push(data);
      renderProjects(state.projects);
    }
  },

  subscribe(sessionIds = null, projectIds = null) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({
        type: 'subscribe',
        data: {
          session_ids: sessionIds,
          project_ids: projectIds,
          include_messages: true,
        },
      }));
    }
  },

  disconnect() {
    clearInterval(this.pingInterval);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.socket) {
      this.socket.close(1000);
      this.socket = null;
    }
  },
};

// ============================================================================
// DOM Element References
// ============================================================================

function $(selector) {
  return document.querySelector(selector);
}

function $$(selector) {
  return document.querySelectorAll(selector);
}

/** Re-initialize Lucide icons in a container after dynamic rendering */
function refreshIcons(container) {
  if (typeof lucide !== 'undefined' && container) {
    lucide.createIcons({ nodes: container.querySelectorAll('[data-lucide]') });
  }
}

// ============================================================================
// Rendering: Projects
// ============================================================================

function renderProjects(projects) {
  const list = $('#project-list');
  if (!list) return;

  // Update project count badge
  const countBadge = $('#project-count-badge');
  if (countBadge) countBadge.textContent = projects.length;

  // Apply filter
  let filtered = projects;
  if (state.projectFilter) {
    const q = state.projectFilter.toLowerCase();
    filtered = projects.filter(p => {
      const name = getShortProjectName(p).toLowerCase();
      const fullPath = (p.display_name || p.path || '').toLowerCase();
      return name.includes(q) || fullPath.includes(q);
    });
  }

  if (state.loading.projects) {
    list.innerHTML = renderSkeletonItems(5, 'project');
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg></div>
        <div class="empty-title">${state.projectFilter ? i18n.noResults : i18n.noProjects}</div>
        <div class="empty-hint">${state.projectFilter ? '' : i18n.noProjectsHint}</div>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(project => {
    const isActive = state.selectedProjectId === project.id;
    const name = getShortProjectName(project);
    const sessionCount = project.session_count || 0;
    const lastActive = project.last_active ? formatRelativeTime(project.last_active) : '';

    return `
      <div class="project-item${isActive ? ' active' : ''}"
           data-project-id="${escapeHtml(project.id)}"
           tabindex="0"
           role="option"
           aria-selected="${isActive}">
        <div class="project-name" title="${escapeHtml(project.display_name || project.path || '')}">${escapeHtml(name)}</div>
        <div class="project-meta">
          <span class="meta-badge" title="${sessionCount}${i18n.sessions}">
            <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
            ${sessionCount}
          </span>
          ${lastActive ? `<span class="meta-time" title="${formatTimestamp(project.last_active)}">${lastActive}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers
  list.querySelectorAll('.project-item').forEach(el => {
    el.addEventListener('click', () => selectProject(el.dataset.projectId));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectProject(el.dataset.projectId);
      }
    });
  });
}

// ============================================================================
// Rendering: Sessions
// ============================================================================

function renderSessions(sessions) {
  const list = $('#session-list');
  if (!list) return;

  // Update session panel header
  updateSessionPanelHeader();

  // Apply filter
  let filtered = sessions;
  if (state.sessionFilter) {
    const q = state.sessionFilter.toLowerCase();
    filtered = sessions.filter(s => {
      const preview = (s.first_message || '').toLowerCase();
      const id = (s.id || '').toLowerCase();
      const slug = (s.slug || '').toLowerCase();
      return preview.includes(q) || id.includes(q) || slug.includes(q);
    });
  }

  if (state.loading.sessions) {
    list.innerHTML = renderSkeletonItems(6, 'session');
    return;
  }

  if (!state.selectedProjectId) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="15 18 9 12 15 6"></polyline></svg></div>
        <div class="empty-title">${i18n.selectProject}</div>
        <div class="empty-hint">${i18n.selectProjectHint}</div>
      </div>
    `;
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></div>
        <div class="empty-title">${state.sessionFilter ? i18n.noResults : i18n.noSessions}</div>
        <div class="empty-hint">${state.sessionFilter ? '' : i18n.noSessionsHint}</div>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map(session => renderSessionItemHtml(session)).join('');

  // Attach handlers
  list.querySelectorAll('.session-item').forEach(el => {
    const sid = el.dataset.sessionId;

    el.addEventListener('click', (e) => {
      // Don't select if clicking on checkbox or action buttons
      if (e.target.closest('.session-checkbox') || e.target.closest('.session-actions')) return;
      selectSession(sid);
    });

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectSession(sid);
      }
    });

    // Checkbox for batch selection
    const checkbox = el.querySelector('.session-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        toggleBatchSelect(sid, e);
      });
    }

    // Action buttons
    el.querySelector('.btn-copy-resume')?.addEventListener('click', (e) => {
      e.stopPropagation();
      copyToClipboard(`claude --resume ${sid}`);
      showToast(i18n.copiedResumeCmd, 'success');
    });

    el.querySelector('.btn-export-session')?.addEventListener('click', (e) => {
      e.stopPropagation();
      exportSingleSession(sid, 'markdown');
    });
  });
}

function renderSessionItemHtml(session) {
  const isActive = state.selectedSessionId === session.id;
  const isSelected = state.batchSelectedIds.has(session.id);
  const preview = truncate(session.first_message || session.slug || session.id, 100);
  const dateStr = formatShortTimestamp(session.start_time);
  const duration = formatDurationShort(session.duration_seconds);
  const msgCount = session.message_count || 0;
  const isLive = session.is_live;

  return `
    <div class="session-item${isActive ? ' active' : ''}${isLive ? ' live' : ''}"
         data-session-id="${escapeHtml(session.id)}"
         tabindex="0"
         role="option"
         aria-selected="${isActive}">
      <div class="session-row-top">
        <input type="checkbox" class="session-checkbox" ${isSelected ? 'checked' : ''} aria-label="选择会话" />
        <span class="session-date">${dateStr}</span>
        ${isLive ? '<span class="live-dot" title="实时更新中"></span>' : ''}
      </div>
      <div class="session-preview" title="${escapeHtml(session.first_message || '')}">${escapeHtml(preview)}</div>
      <div class="session-meta">
        ${duration ? `<span class="meta-badge meta-duration"><svg class="icon icon-xs inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> ${duration}</span>` : ''}
        <span class="meta-badge meta-msgs"><svg class="icon icon-xs inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> ${msgCount}</span>
        ${session.model ? `<span class="meta-badge meta-model" title="${escapeHtml(session.model)}">${escapeHtml(truncate(session.model, 20))}</span>` : ''}
      </div>
      <div class="session-actions">
        <button class="btn-icon btn-copy-resume" title="${i18n.copyResumeCmd}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
        <button class="btn-icon btn-export-session" title="${i18n.exportMarkdown}">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
        </button>
      </div>
    </div>
  `;
}

function renderSessionItem(session) {
  const el = document.querySelector(`.session-item[data-session-id="${session.id}"]`);
  if (!el) return;
  // Update message count badge in-place (preserve the SVG icon)
  const metaMsgs = el.querySelector('.meta-msgs');
  if (metaMsgs) {
    const svg = metaMsgs.querySelector('svg');
    const svgHtml = svg ? svg.outerHTML : '';
    metaMsgs.innerHTML = `${svgHtml} ${session.message_count || 0}`;
  }
}

function updateSessionPanelHeader() {
  const headerText = $('#session-project-name');
  if (headerText && state.selectedProjectId) {
    const project = state.projects.find(p => p.id === state.selectedProjectId);
    if (project) {
      headerText.textContent = getShortProjectName(project);
      headerText.title = project.display_name || '';
    }
  }
}

// ============================================================================
// Rendering: Messages (Detail Panel)
// ============================================================================

function renderMessages(conversation) {
  const container = $('#message-list');
  if (!container) return;

  if (state.loading.messages) {
    container.innerHTML = renderSkeletonItems(8, 'message');
    return;
  }

  if (!state.selectedSessionId) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></div>
        <div class="empty-title">${i18n.selectSession}</div>
        <div class="empty-hint">${i18n.selectSessionHint}</div>
      </div>
    `;
    return;
  }

  const messages = conversation.messages || conversation || [];
  if (messages.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg class="w-12 h-12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><line x1="9" y1="10" x2="15" y2="10"></line></svg></div>
        <div class="empty-title">${i18n.noSessions}</div>
      </div>
    `;
    return;
  }

  container.innerHTML = messages.map((msg, idx) => renderMessageHtml(msg, idx)).join('');
  updateDetailHeader(conversation);
  updateDetailFooter(messages);
  attachMessageHandlers(container);

  // Scroll to bottom
  requestAnimationFrame(() => scrollMessagesToBottom());
}

function renderMessageHtml(msg, index) {
  const type = msg.type || (msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system');

  switch (type) {
    case 'user':
      return renderUserMessage(msg, index);
    case 'assistant':
      return renderAssistantMessage(msg, index);
    case 'tool_result':
      return renderToolResultMessage(msg, index);
    case 'system':
      return renderSystemMessage(msg, index);
    default:
      return renderSystemMessage(msg, index);
  }
}

function renderUserMessage(msg, index) {
  const timestamp = formatTimestamp(msg.timestamp);
  const content = getMessageTextContent(msg);

  return `
    <div class="message message-user" data-uuid="${escapeHtml(msg.uuid || '')}" data-index="${index}">
      <div class="message-avatar avatar-user" title="${i18n.you}">U</div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-role role-user">${i18n.you}</span>
          <span class="message-time">${timestamp}</span>
          <button class="btn-icon btn-copy-msg" title="${i18n.copyMessage}">
            <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>
        <div class="message-content">${renderTextContent(content)}</div>
      </div>
    </div>
  `;
}

function renderAssistantMessage(msg, index) {
  const timestamp = formatTimestamp(msg.timestamp);
  const blocks = msg.content || [];
  let html = '';

  // Render each content block
  for (const block of blocks) {
    if (block.type === 'thinking') {
      html += renderThinkingBlock(block, msg.uuid || index);
    } else if (block.type === 'tool_use') {
      html += renderToolUseBlock(block, msg.uuid || index);
    } else if (block.type === 'text') {
      html += `<div class="message-content">${renderMarkdown(block.text || '')}</div>`;
    } else if (block.type === 'tool_result') {
      html += renderToolResultBlock(block, msg.uuid || index);
    }
  }

  // If content is just a string
  if (blocks.length === 0 && msg.content_text) {
    html = `<div class="message-content">${renderMarkdown(msg.content_text)}</div>`;
  }

  const modelBadge = msg.model ? `<span class="meta-badge meta-model-sm">${escapeHtml(truncate(msg.model, 30))}</span>` : '';
  const durationBadge = msg.duration_ms ? `<span class="meta-badge">${(msg.duration_ms / 1000).toFixed(1)}s</span>` : '';

  return `
    <div class="message message-assistant${msg.is_compact_summary ? ' compact-summary' : ''}" data-uuid="${escapeHtml(msg.uuid || '')}" data-index="${index}">
      <div class="message-avatar avatar-assistant" title="${i18n.assistant}">A</div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-role role-assistant">${i18n.assistant}</span>
          ${modelBadge}
          ${durationBadge}
          <span class="message-time">${timestamp}</span>
          <button class="btn-icon btn-copy-msg" title="${i18n.copyMessage}">
            <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>
        ${html}
      </div>
    </div>
  `;
}

function renderThinkingBlock(block, parentId) {
  const blockId = `thinking-${parentId}-${generateId()}`;
  const isCollapsed = state.collapsedBlocks[blockId] !== false; // collapsed by default
  state.collapsedBlocks[blockId] = isCollapsed;

  const thinkingText = block.thinking || block.text || '';
  const preview = truncate(thinkingText, 80);

  return `
    <div class="collapsible-block thinking-block${isCollapsed ? ' collapsed' : ''}" data-block-id="${blockId}">
      <div class="collapsible-header" data-toggle="${blockId}">
        <span class="collapse-icon">${isCollapsed ? '▶' : '▼'}</span>
        <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"></path><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"></path></svg>
        <span class="collapsible-label">${i18n.thinkingLabel}</span>
        ${isCollapsed ? `<span class="collapsible-preview">${escapeHtml(preview)}</span>` : ''}
      </div>
      <div class="collapsible-content${isCollapsed ? ' hidden' : ''}">
        <div class="thinking-content">${renderMarkdown(thinkingText)}</div>
      </div>
    </div>
  `;
}

function renderToolUseBlock(block, parentId) {
  const blockId = `tool-${parentId}-${block.tool_use_id || generateId()}`;
  const isCollapsed = state.collapsedBlocks[blockId] !== false;
  state.collapsedBlocks[blockId] = isCollapsed;

  const toolName = block.name || '未知工具';
  const toolInput = block.input || {};
  const summary = getToolSummary(toolName, toolInput);

  let inputDisplay = '';
  if (toolName === 'Bash' && toolInput.command) {
    inputDisplay = `<pre class="code-block code-shell"><code>${escapeHtml(toolInput.command)}</code></pre>`;
  } else if ((toolName === 'Read' || toolName === 'Write' || toolName === 'Edit') && toolInput.file_path) {
    inputDisplay = `<div class="tool-file-path"><svg class="icon icon-xs inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> ${escapeHtml(toolInput.file_path)}</div>`;
    if (toolName === 'Edit' && toolInput.old_string !== undefined) {
      inputDisplay += `
        <div class="diff-block">
          <div class="diff-old"><span class="diff-label">-</span><pre><code>${escapeHtml(truncateLong(toolInput.old_string, 500))}</code></pre></div>
          <div class="diff-new"><span class="diff-label">+</span><pre><code>${escapeHtml(truncateLong(toolInput.new_string || '', 500))}</code></pre></div>
        </div>
      `;
    } else if (toolName === 'Write' && toolInput.content) {
      inputDisplay += `<pre class="code-block"><code>${escapeHtml(truncateLong(toolInput.content, 1000))}</code></pre>`;
    }
  } else if (toolName === 'Glob' || toolName === 'Grep') {
    const pattern = toolInput.pattern || toolInput.glob || '';
    const path = toolInput.path || '';
    inputDisplay = `<div class="tool-file-path">${escapeHtml(toolName)}: ${escapeHtml(pattern)}${path ? ` in ${escapeHtml(path)}` : ''}</div>`;
    if (Object.keys(toolInput).length > 2) {
      inputDisplay += `<pre class="code-block code-json"><code>${escapeHtml(JSON.stringify(toolInput, null, 2))}</code></pre>`;
    }
  } else {
    inputDisplay = `<pre class="code-block code-json"><code>${escapeHtml(JSON.stringify(toolInput, null, 2))}</code></pre>`;
  }

  return `
    <div class="collapsible-block tool-use-block${isCollapsed ? ' collapsed' : ''}" data-block-id="${blockId}">
      <div class="collapsible-header" data-toggle="${blockId}">
        <span class="collapse-icon">${isCollapsed ? '▶' : '▼'}</span>
        <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>
        <span class="tool-name">${escapeHtml(toolName)}</span>
        <span class="collapsible-label">${i18n.toolCall}</span>
        ${isCollapsed ? `<span class="collapsible-preview">${escapeHtml(summary)}</span>` : ''}
        <button class="btn-icon btn-copy-code" title="${i18n.copyCode}">
          <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>
      <div class="collapsible-content${isCollapsed ? ' hidden' : ''}">
        ${inputDisplay}
      </div>
    </div>
  `;
}

function renderToolResultMessage(msg, index) {
  const timestamp = formatTimestamp(msg.timestamp);
  const toolResult = msg.tool_result || {};
  const content = msg.content || [];

  let resultHtml = '';

  // Check toolResult data
  if (toolResult.stdout || toolResult.stderr || toolResult.content) {
    resultHtml += renderToolResultData(toolResult, msg.uuid || index);
  }

  // Check content blocks for tool_result type
  for (const block of content) {
    if (block.type === 'tool_result') {
      resultHtml += renderToolResultBlock(block, msg.uuid || index);
    } else if (block.type === 'text' && block.text) {
      // Some tool_result messages also have text content
      resultHtml += `<div class="message-content">${renderTextContent(block.text)}</div>`;
    }
  }

  if (!resultHtml && msg.content_text) {
    resultHtml = `<div class="message-content">${renderTextContent(msg.content_text)}</div>`;
  }

  return `
    <div class="message message-tool-result" data-uuid="${escapeHtml(msg.uuid || '')}" data-index="${index}">
      <div class="message-indent">
        <div class="message-body">
          ${resultHtml}
        </div>
      </div>
    </div>
  `;
}

function renderToolResultBlock(block, parentId) {
  const blockId = `result-${parentId}-${block.tool_use_id || generateId()}`;
  const isError = block.is_error;
  const content = block.content || '';
  const lines = content.split('\n');
  const isLong = lines.length > 5;
  const isCollapsed = isLong && state.collapsedBlocks[blockId] !== false;
  if (isLong) state.collapsedBlocks[blockId] = isCollapsed;

  const statusClass = isError ? 'error' : 'success';
  const statusLabel = isError ? i18n.failed : i18n.success;

  return `
    <div class="collapsible-block tool-result-block ${statusClass}${isCollapsed ? ' collapsed' : ''}" data-block-id="${blockId}">
      <div class="collapsible-header" data-toggle="${blockId}">
        <span class="collapse-icon">${isCollapsed ? '▶' : '▼'}</span>
        <span class="result-status-icon">${isError ? '<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' : '<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'}</span>
        <span class="collapsible-label">${i18n.toolResult}</span>
        <span class="result-status ${statusClass}">${statusLabel}</span>
        ${isCollapsed ? `<span class="collapsible-preview">${escapeHtml(truncate(content, 60))}</span>` : ''}
      </div>
      <div class="collapsible-content${isCollapsed ? ' hidden' : ''}">
        <pre class="code-block code-output ${statusClass}"><code>${escapeHtml(truncateLong(content, 5000))}</code></pre>
        ${content.length > 5000 ? `<button class="btn-show-more" data-full-content="${blockId}">${i18n.showMore}</button>` : ''}
      </div>
    </div>
  `;
}

function renderToolResultData(toolResult, parentId) {
  const blockId = `result-data-${parentId}-${generateId()}`;
  const isError = toolResult.is_error;
  const stdout = toolResult.stdout || '';
  const stderr = toolResult.stderr || '';
  const content = toolResult.content || '';
  const interrupted = toolResult.interrupted;

  const output = stdout || content || '';
  const combinedLength = output.length + stderr.length;
  const isLong = output.split('\n').length > 5 || stderr.split('\n').length > 3;
  const isCollapsed = isLong && state.collapsedBlocks[blockId] !== false;
  if (isLong) state.collapsedBlocks[blockId] = isCollapsed;

  let statusLabel = isError ? i18n.failed : i18n.success;
  if (interrupted) statusLabel = i18n.interrupted;
  const statusClass = isError || interrupted ? 'error' : 'success';

  let outputHtml = '';
  if (output) {
    outputHtml += `<pre class="code-block code-output"><code>${escapeHtml(truncateLong(output, 5000))}</code></pre>`;
  }
  if (stderr) {
    outputHtml += `<pre class="code-block code-stderr"><code>${escapeHtml(truncateLong(stderr, 2000))}</code></pre>`;
  }
  if (toolResult.file_path) {
    outputHtml = `<div class="tool-file-path"><svg class="icon icon-xs inline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg> ${escapeHtml(toolResult.file_path)}</div>` + outputHtml;
  }

  return `
    <div class="collapsible-block tool-result-block ${statusClass}${isCollapsed ? ' collapsed' : ''}" data-block-id="${blockId}">
      <div class="collapsible-header" data-toggle="${blockId}">
        <span class="collapse-icon">${isCollapsed ? '▶' : '▼'}</span>
        <span class="result-status-icon">${(isError || interrupted) ? '<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>' : '<svg class="icon icon-xs" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'}</span>
        <span class="collapsible-label">${i18n.toolResult}</span>
        <span class="result-status ${statusClass}">${statusLabel}</span>
        ${isCollapsed ? `<span class="collapsible-preview">${escapeHtml(truncate(output || stderr, 60))}</span>` : ''}
      </div>
      <div class="collapsible-content${isCollapsed ? ' hidden' : ''}">
        ${outputHtml}
      </div>
    </div>
  `;
}

function renderSystemMessage(msg, index) {
  const text = msg.content_text || getMessageTextContent(msg);
  return `
    <div class="message message-system" data-uuid="${escapeHtml(msg.uuid || '')}" data-index="${index}">
      <div class="system-divider">
        <span class="system-text">${escapeHtml(truncate(text, 100))}</span>
      </div>
    </div>
  `;
}

function appendMessage(msg) {
  const container = $('#message-list');
  if (!container) return;
  const index = state.messages.length - 1;
  const html = renderMessageHtml(msg, index);
  container.insertAdjacentHTML('beforeend', html);

  // Attach handlers to new message
  const newEl = container.lastElementChild;
  if (newEl) attachMessageHandlersToElement(newEl);

  // Update footer
  updateDetailFooter(state.messages);
}

// ============================================================================
// Message Content Helpers
// ============================================================================

function getMessageTextContent(msg) {
  if (msg.content_text) return msg.content_text;
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  return '';
}

function renderTextContent(text) {
  if (!text) return '';
  return renderMarkdown(text);
}

function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML first
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="code-block${lang ? ` code-${lang}` : ''}"><div class="code-header"><span class="code-lang">${lang || 'code'}</span><button class="btn-icon btn-copy-code" title="${i18n.copyCode}"><svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></div><code>${code}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>');

  // Bold (**...**)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic (*...*)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // Links - already escaped, so match escaped version
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Auto-linkify URLs
  html = html.replace(
    /(?<!["\'>])(https?:\/\/[^\s<&]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Newlines to <br> (but not inside pre/code blocks)
  html = html.replace(/\n/g, '<br>');

  return html;
}

function getToolSummary(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Bash':
      return truncate(input.command || '', 60);
    case 'Read':
      return input.file_path || '';
    case 'Write':
      return input.file_path || '';
    case 'Edit':
      return input.file_path || '';
    case 'Glob':
      return `${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`;
    case 'Grep':
      return `${input.pattern || ''}${input.path ? ` in ${input.path}` : ''}`;
    case 'WebFetch':
      return input.url || '';
    case 'WebSearch':
      return input.query || '';
    default:
      return truncate(JSON.stringify(input), 60);
  }
}

function truncateLong(str, maxLen = 5000) {
  if (!str || str.length <= maxLen) return str;
  const halfLen = Math.floor(maxLen / 2);
  return str.slice(0, halfLen) + `\n\n... (${str.length - maxLen} 个字符已省略) ...\n\n` + str.slice(-halfLen);
}

// ============================================================================
// Skeleton Loaders
// ============================================================================

function renderSkeletonItems(count, type) {
  const items = [];
  for (let i = 0; i < count; i++) {
    if (type === 'project') {
      items.push(`
        <div class="skeleton-item skeleton-project">
          <div class="skeleton-line" style="width: ${60 + Math.random() * 30}%"></div>
          <div class="skeleton-line skeleton-sm" style="width: ${30 + Math.random() * 20}%"></div>
        </div>
      `);
    } else if (type === 'session') {
      items.push(`
        <div class="skeleton-item skeleton-session">
          <div class="skeleton-line skeleton-xs" style="width: 40%"></div>
          <div class="skeleton-line" style="width: ${70 + Math.random() * 25}%"></div>
          <div class="skeleton-line skeleton-sm" style="width: ${40 + Math.random() * 30}%"></div>
        </div>
      `);
    } else {
      const isUser = i % 3 === 0;
      items.push(`
        <div class="skeleton-item skeleton-message ${isUser ? 'skeleton-user' : 'skeleton-assistant'}">
          <div class="skeleton-avatar"></div>
          <div class="skeleton-body">
            <div class="skeleton-line skeleton-xs" style="width: 20%"></div>
            <div class="skeleton-line" style="width: ${50 + Math.random() * 40}%"></div>
            ${!isUser ? `<div class="skeleton-line" style="width: ${40 + Math.random() * 50}%"></div>` : ''}
          </div>
        </div>
      `);
    }
  }
  return items.join('');
}

// ============================================================================
// Event Handlers
// ============================================================================

function attachMessageHandlers(container) {
  container.querySelectorAll('.message').forEach(el => attachMessageHandlersToElement(el));
}

function attachMessageHandlersToElement(el) {
  // Copy message button
  el.querySelectorAll('.btn-copy-msg').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const msgEl = btn.closest('.message');
      const contentEl = msgEl?.querySelector('.message-content');
      if (contentEl) {
        copyToClipboard(contentEl.textContent || contentEl.innerText);
      }
    });
  });

  // Copy code buttons
  el.querySelectorAll('.btn-copy-code').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const codeEl = btn.closest('.code-block')?.querySelector('code')
        || btn.closest('.collapsible-block')?.querySelector('code');
      if (codeEl) {
        copyToClipboard(codeEl.textContent || codeEl.innerText);
      }
    });
  });

  // Collapsible toggles
  el.querySelectorAll('.collapsible-header[data-toggle]').forEach(header => {
    header.addEventListener('click', (e) => {
      // Don't toggle if clicking copy button
      if (e.target.closest('.btn-copy-code')) return;

      const blockId = header.dataset.toggle;
      const block = header.closest('.collapsible-block');
      if (!block) return;

      const isCollapsed = block.classList.contains('collapsed');
      state.collapsedBlocks[blockId] = !isCollapsed;

      block.classList.toggle('collapsed');
      const content = block.querySelector('.collapsible-content');
      const icon = block.querySelector('.collapse-icon');
      const preview = block.querySelector('.collapsible-preview');

      if (content) content.classList.toggle('hidden');
      if (icon) icon.textContent = isCollapsed ? '▼' : '▶';
      if (preview) preview.style.display = isCollapsed ? 'none' : '';
    });
  });
}

// ============================================================================
// Selection & Navigation
// ============================================================================

async function selectProject(projectId) {
  if (state.selectedProjectId === projectId) return;

  state.selectedProjectId = projectId;
  state.selectedSessionId = null;
  state.sessions = [];
  state.messages = [];
  state.batchSelectedIds.clear();
  state.sessionFilter = '';

  // Update UI
  renderProjects(state.projects);
  renderMessages([]);
  clearDetailHeader();

  // Fetch sessions
  state.loading.sessions = true;
  renderSessions(state.sessions);

  try {
    const data = await api.fetchSessions(projectId);
    state.sessions = data.sessions || [];
    state.loading.sessions = false;
    renderSessions(state.sessions);

    // Save state
    saveState();
  } catch (err) {
    state.loading.sessions = false;
    showToast(`加载会话失败: ${err.message}`, 'error');
    renderSessions([]);
  }
}

async function selectSession(sessionId) {
  if (state.selectedSessionId === sessionId) return;

  state.selectedSessionId = sessionId;
  state.messages = [];
  state.collapsedBlocks = {};
  state.sessionSearchQuery = '';
  state.sessionSearchMatches = [];

  // Update UI
  renderSessions(state.sessions);

  // Fetch messages
  state.loading.messages = true;
  renderMessages([]);

  try {
    const data = await api.fetchMessages(sessionId);
    state.messages = data.messages || [];
    state.conversationMetadata = data.metadata || null;
    state.loading.messages = false;
    renderMessages(data);

    // Subscribe to WebSocket updates for this session
    ws.subscribe([sessionId]);

    // Save state
    saveState();
  } catch (err) {
    state.loading.messages = false;
    showToast(`加载消息失败: ${err.message}`, 'error');
    renderMessages([]);
  }
}

// ============================================================================
// Detail Panel Header & Footer
// ============================================================================

function updateDetailHeader(conversation) {
  const header = $('#detail-header');
  if (!header) return;

  const meta = conversation.metadata || state.conversationMetadata;
  if (!meta) return;

  const sessionIdShort = (meta.id || state.selectedSessionId || '').slice(0, 8);
  const startTime = formatTimestamp(meta.start_time);
  const endTime = formatTimestamp(meta.end_time);
  const slug = meta.slug || '';

  // Update the left section of the detail header
  const leftSection = header.querySelector('.min-w-0');
  if (leftSection) {
    leftSection.innerHTML = `
      <span class="text-xs font-mono text-cta">${escapeHtml(slug || sessionIdShort)}</span>
      ${startTime ? `<span class="text-2xs text-text-tertiary font-sans">${startTime}${endTime && endTime !== startTime ? ` - ${endTime}` : ''}</span>` : ''}
    `;
  }
}

function clearDetailHeader() {
  const header = $('#detail-header');
  if (!header) return;
  const leftSection = header.querySelector('.min-w-0');
  if (leftSection) {
    leftSection.innerHTML = `
      <span class="text-xs font-mono text-text-tertiary">--</span>
    `;
  }
}

function updateDetailFooter(messages) {
  const footer = $('#detail-footer');
  if (!footer) return;

  const count = messages.length;
  const meta = state.conversationMetadata;
  const startTime = meta?.start_time ? formatTimestamp(meta.start_time) : '';
  const endTime = meta?.end_time ? formatTimestamp(meta.end_time) : '';

  footer.innerHTML = `
    <span>${count} ${i18n.messages}</span>
    ${startTime ? `<span>${startTime}${endTime ? ` - ${endTime}` : ''}</span>` : ''}
  `;
}

// ============================================================================
// Auto-Scroll
// ============================================================================

function scrollMessagesToBottom() {
  const container = $('#message-list');
  if (!container) return;
  container.scrollTop = container.scrollHeight;
}

function checkAutoScroll() {
  const container = $('#message-list');
  if (!container) return;

  const threshold = 100;
  const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < threshold;
  state.isAutoScrollEnabled = isAtBottom;

  // Toggle new messages badge
  const badge = $('#new-messages-badge');
  if (badge) {
    badge.style.display = isAtBottom ? 'none' : '';
  }

  // Toggle scroll-to-bottom button
  const scrollBtn = $('#scroll-to-bottom');
  if (scrollBtn) {
    scrollBtn.classList.toggle('hidden', isAtBottom);
    scrollBtn.classList.toggle('flex', !isAtBottom);
  }
}

function showNewMessagesBadge() {
  let badge = $('#new-messages-badge');
  if (!badge) {
    const container = $('#panel-detail');
    if (!container) return;
    badge = document.createElement('div');
    badge.id = 'new-messages-badge';
    badge.className = 'new-messages-badge';
    badge.textContent = i18n.newMessages;
    badge.addEventListener('click', () => {
      scrollMessagesToBottom();
      badge.style.display = 'none';
    });
    container.appendChild(badge);
  }
  badge.style.display = 'flex';
}

// ============================================================================
// Batch Selection
// ============================================================================

function toggleBatchSelect(sessionId, event) {
  if (state.batchSelectedIds.has(sessionId)) {
    state.batchSelectedIds.delete(sessionId);
  } else {
    state.batchSelectedIds.add(sessionId);
  }

  // Shift+Click for range select
  if (event && event.shiftKey && state.batchSelectedIds.size > 0) {
    const sessionEls = Array.from($$('.session-item'));
    const ids = sessionEls.map(el => el.dataset.sessionId);
    const currentIdx = ids.indexOf(sessionId);
    const selectedIndices = ids
      .map((id, i) => state.batchSelectedIds.has(id) ? i : -1)
      .filter(i => i >= 0);

    if (selectedIndices.length > 0) {
      const minIdx = Math.min(...selectedIndices, currentIdx);
      const maxIdx = Math.max(...selectedIndices, currentIdx);
      for (let i = minIdx; i <= maxIdx; i++) {
        state.batchSelectedIds.add(ids[i]);
      }
    }
  }

  updateBatchUI();
}

function updateBatchUI() {
  // Update checkboxes
  $$('.session-item').forEach(el => {
    const checkbox = el.querySelector('.session-checkbox');
    if (checkbox) {
      checkbox.checked = state.batchSelectedIds.has(el.dataset.sessionId);
    }
  });

  // Show/hide batch action bar
  const bar = $('#batch-action-bar');
  if (bar) {
    if (state.batchSelectedIds.size > 0) {
      bar.style.display = 'flex';
      const countEl = bar.querySelector('#batch-count');
      if (countEl) countEl.textContent = `${state.batchSelectedIds.size} ${i18n.sessions}`;
    } else {
      bar.style.display = 'none';
    }
  }
}

function selectAllSessions() {
  state.sessions.forEach(s => state.batchSelectedIds.add(s.id));
  updateBatchUI();
}

function deselectAllSessions() {
  state.batchSelectedIds.clear();
  updateBatchUI();
}

// ============================================================================
// Export
// ============================================================================

async function exportSingleSession(sessionId, format = 'markdown') {
  try {
    const res = await api.exportSession(sessionId, format);
    const contentDisposition = res.headers.get('Content-Disposition');
    let filename = `session-${sessionId.slice(0, 8)}.${format === 'json' ? 'json' : format === 'html' ? 'html' : 'md'}`;

    if (contentDisposition) {
      const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
      if (match) filename = match[1].replace(/['"]/g, '');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(i18n.exportSuccess, 'success');
  } catch (err) {
    showToast(`${i18n.exportFailed}: ${err.message}`, 'error');
  }
}

async function batchExportSessions(format = 'markdown') {
  if (state.batchSelectedIds.size === 0) return;

  try {
    const sessionIds = Array.from(state.batchSelectedIds);
    const res = await api.batchExport(sessionIds, format);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sessions-export-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(`${i18n.exportSuccess} (${sessionIds.length}${i18n.sessions})`, 'success');
  } catch (err) {
    showToast(`${i18n.exportFailed}: ${err.message}`, 'error');
  }
}

async function shareSession(sessionId) {
  try {
    const res = await api.shareSession(sessionId || state.selectedSessionId);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${(sessionId || state.selectedSessionId || '').slice(0, 8)}-share.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    showToast(i18n.exportSuccess, 'success');
  } catch (err) {
    showToast(`${i18n.exportFailed}: ${err.message}`, 'error');
  }
}

// ============================================================================
// Search
// ============================================================================

function openSearchModal() {
  state.isSearchModalOpen = true;
  const modal = $('#modal-search');
  if (!modal) return;

  // Wire up handlers once
  if (!modal._searchBound) {
    modal._searchBound = true;

    // Close on backdrop click
    $$('[data-action="close-search-modal"]').forEach(el => {
      el.addEventListener('click', closeSearchModal);
    });

    // Search input handler
    const input = $('#modal-search-input');
    if (input) {
      input.addEventListener('input', debounce(async (e) => {
        const query = e.target.value.trim();
        if (query.length < 1) {
          $('#modal-search-results').innerHTML = '';
          return;
        }
        await performGlobalSearch(query);
      }, 300));

      // Keyboard nav in search results
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          closeSearchModal();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          navigateSearchResults(e.key === 'ArrowDown' ? 1 : -1);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          selectSearchResult();
          return;
        }
      });
    }
  }

  modal.classList.remove('hidden');
  requestAnimationFrame(() => {
    const input = $('#modal-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
  });
}

function closeSearchModal() {
  state.isSearchModalOpen = false;
  const modal = $('#modal-search');
  if (modal) {
    modal.classList.add('hidden');
  }
}

async function performGlobalSearch(query) {
  const resultsContainer = $('#modal-search-results');
  if (!resultsContainer) return;

  resultsContainer.innerHTML = `<div class="search-loading">${i18n.loading}</div>`;

  try {
    const data = await api.searchGlobal(query);
    state.searchResults = data.results || [];

    if (state.searchResults.length === 0) {
      resultsContainer.innerHTML = `<div class="search-no-results">${i18n.noResults}</div>`;
      return;
    }

    // Group results by session
    const grouped = {};
    for (const result of state.searchResults) {
      const key = result.session_id;
      if (!grouped[key]) {
        grouped[key] = {
          session_id: result.session_id,
          project_id: result.project_id,
          project_name: result.project_name,
          items: [],
        };
      }
      grouped[key].items.push(result);
    }

    let html = `<div class="search-meta">${data.total_results} ${i18n.searchResults} (${data.search_time_ms?.toFixed(0) || 0}ms)</div>`;

    for (const [sessionId, group] of Object.entries(grouped)) {
      html += `
        <div class="search-group">
          <div class="search-group-header">
            <span class="search-project-name">${escapeHtml(group.project_name || '')}</span>
            <span class="search-session-id">${escapeHtml(sessionId.slice(0, 8))}</span>
          </div>
          ${group.items.map((item, idx) => `
            <div class="search-result-item" data-session-id="${escapeHtml(item.session_id)}" data-project-id="${escapeHtml(item.project_id)}" data-message-uuid="${escapeHtml(item.message_uuid || '')}" tabindex="0">
              <span class="search-result-role role-${item.role || 'user'}">${item.role === 'assistant' ? 'A' : 'U'}</span>
              <span class="search-result-snippet">${renderSearchSnippet(item.snippet || '')}</span>
              ${item.timestamp ? `<span class="search-result-time">${formatShortTimestamp(item.timestamp)}</span>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }

    resultsContainer.innerHTML = html;

    // Attach click handlers
    resultsContainer.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const projectId = el.dataset.projectId;
        const sessionId = el.dataset.sessionId;
        const msgUuid = el.dataset.messageUuid;
        closeSearchModal();
        navigateToMessage(projectId, sessionId, msgUuid);
      });
    });
  } catch (err) {
    resultsContainer.innerHTML = `<div class="search-error">${i18n.error}: ${escapeHtml(err.message)}</div>`;
  }
}

function renderSearchSnippet(snippet) {
  // Convert <<hl>> markers (from server) to <mark> tags
  return escapeHtml(snippet)
    .replace(/&lt;&lt;hl&gt;&gt;/g, '<mark>')
    .replace(/&lt;&lt;\/hl&gt;&gt;/g, '</mark>');
}

function navigateSearchResults(direction) {
  const items = Array.from($$('.search-result-item'));
  if (items.length === 0) return;

  const current = document.querySelector('.search-result-item.focused');
  let idx = current ? items.indexOf(current) : -1;
  idx += direction;
  if (idx < 0) idx = items.length - 1;
  if (idx >= items.length) idx = 0;

  items.forEach(el => el.classList.remove('focused'));
  items[idx].classList.add('focused');
  items[idx].scrollIntoView({ block: 'nearest' });
}

function selectSearchResult() {
  const focused = document.querySelector('.search-result-item.focused');
  if (focused) focused.click();
}

async function navigateToMessage(projectId, sessionId, messageUuid) {
  // Select project if needed
  if (state.selectedProjectId !== projectId) {
    await selectProject(projectId);
  }
  // Select session
  if (state.selectedSessionId !== sessionId) {
    await selectSession(sessionId);
  }
  // Scroll to message
  if (messageUuid) {
    requestAnimationFrame(() => {
      const msgEl = document.querySelector(`.message[data-uuid="${messageUuid}"]`);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.classList.add('highlight-flash');
        setTimeout(() => msgEl.classList.remove('highlight-flash'), 2000);
      }
    });
  }
}

// ============================================================================
// In-Session Search
// ============================================================================

function performSessionSearch(query) {
  state.sessionSearchQuery = query;
  state.sessionSearchMatches = [];
  state.sessionSearchCurrentIndex = -1;

  clearSessionSearchHighlights();

  if (!query) {
    updateSessionSearchCount();
    return;
  }

  const container = $('#message-list');
  if (!container) return;

  const messages = container.querySelectorAll('.message');
  const lowerQuery = query.toLowerCase();

  messages.forEach(el => {
    const text = el.textContent || el.innerText || '';
    if (text.toLowerCase().includes(lowerQuery)) {
      state.sessionSearchMatches.push(el);
    }
  });

  updateSessionSearchCount();

  if (state.sessionSearchMatches.length > 0) {
    navigateSessionSearch(1);
  }
}

function navigateSessionSearch(direction) {
  if (state.sessionSearchMatches.length === 0) return;

  // Remove highlight from current
  if (state.sessionSearchCurrentIndex >= 0 && state.sessionSearchCurrentIndex < state.sessionSearchMatches.length) {
    state.sessionSearchMatches[state.sessionSearchCurrentIndex].classList.remove('highlight-flash');
  }

  state.sessionSearchCurrentIndex += direction;
  if (state.sessionSearchCurrentIndex >= state.sessionSearchMatches.length) {
    state.sessionSearchCurrentIndex = 0;
  }
  if (state.sessionSearchCurrentIndex < 0) {
    state.sessionSearchCurrentIndex = state.sessionSearchMatches.length - 1;
  }

  const el = state.sessionSearchMatches[state.sessionSearchCurrentIndex];
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('highlight-flash');
  setTimeout(() => el.classList.remove('highlight-flash'), 2000);

  updateSessionSearchCount();
}

function clearSessionSearchHighlights() {
  state.sessionSearchMatches.forEach(el => {
    el.classList.remove('highlight-flash');
  });
  state.sessionSearchMatches = [];
  state.sessionSearchCurrentIndex = -1;
  state.sessionSearchQuery = '';
  updateSessionSearchCount();
}

function updateSessionSearchCount() {
  const countEl = $('#session-search-count');
  if (!countEl) return;
  const total = state.sessionSearchMatches.length;
  const current = total > 0 ? state.sessionSearchCurrentIndex + 1 : 0;
  countEl.textContent = `${current}/${total}`;
}

// ============================================================================
// Panel Resize
// ============================================================================

function initPanelResize() {
  const handles = $$('.resize-handle');
  handles.forEach(handle => {
    let startX, startLeftWidth, startMiddleWidth;
    const isLeftHandle = handle.dataset.panels === 'project,session';

    const onMouseDown = (e) => {
      e.preventDefault();
      startX = e.clientX;
      startLeftWidth = state.panelWidths.left;
      startMiddleWidth = state.panelWidths.middle;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    const onMouseMove = (e) => {
      const delta = e.clientX - startX;
      if (isLeftHandle) {
        const newLeft = Math.max(200, Math.min(400, startLeftWidth + delta));
        state.panelWidths.left = newLeft;
        applyPanelWidths();
      } else {
        const newMiddle = Math.max(280, Math.min(500, startMiddleWidth + delta));
        state.panelWidths.middle = newMiddle;
        applyPanelWidths();
      }
    };

    const onMouseUp = () => {
      handle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      savePanelWidths();
    };

    handle.addEventListener('mousedown', onMouseDown);
  });

  // Restore saved widths
  restorePanelWidths();
  applyPanelWidths();
}

function applyPanelWidths() {
  const projectPanel = $('#panel-projects');
  const sessionPanel = $('#panel-sessions');
  if (projectPanel) projectPanel.style.width = `${state.panelWidths.left}px`;
  if (sessionPanel) sessionPanel.style.width = `${state.panelWidths.middle}px`;
}

function savePanelWidths() {
  try {
    localStorage.setItem('cclog:panelWidths', JSON.stringify(state.panelWidths));
  } catch {}
}

function restorePanelWidths() {
  try {
    const saved = localStorage.getItem('cclog:panelWidths');
    if (saved) {
      const widths = JSON.parse(saved);
      state.panelWidths.left = widths.left || 250;
      state.panelWidths.middle = widths.middle || 350;
    }
  } catch {}
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Cmd+K / Ctrl+K → open search modal
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      if (state.isSearchModalOpen) {
        closeSearchModal();
      } else {
        openSearchModal();
      }
      return;
    }

    // Escape → close modals
    if (e.key === 'Escape') {
      if (state.isSearchModalOpen) {
        closeSearchModal();
        return;
      }
      // Close export/share modals
      closeExportModal();
      closeShareModal();
      return;
    }

    // Don't handle shortcuts if input is focused
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
      return;
    }

    // Arrow navigation in lists
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      handleArrowNavigation(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    // Enter to select
    if (e.key === 'Enter') {
      handleEnterSelect();
      return;
    }

    // Arrow left/right to switch panels
    if (e.key === 'ArrowLeft') {
      if (state.focusedPanel === 'session') setFocusedPanel('project');
      else if (state.focusedPanel === 'detail') setFocusedPanel('session');
      return;
    }
    if (e.key === 'ArrowRight') {
      if (state.focusedPanel === 'project') setFocusedPanel('session');
      else if (state.focusedPanel === 'session') setFocusedPanel('detail');
      return;
    }

    // Alt+1/2/3 → focus panels
    if (e.altKey && e.key === '1') { setFocusedPanel('project'); return; }
    if (e.altKey && e.key === '2') { setFocusedPanel('session'); return; }
    if (e.altKey && e.key === '3') { setFocusedPanel('detail'); return; }

    // Home/End in message list
    if (e.key === 'Home' && state.focusedPanel === 'detail') {
      const container = $('#message-list');
      if (container) container.scrollTop = 0;
      return;
    }
    if (e.key === 'End' && state.focusedPanel === 'detail') {
      scrollMessagesToBottom();
      return;
    }
  });
}

function handleArrowNavigation(direction) {
  if (state.focusedPanel === 'project') {
    navigateList('#project-list .project-item', direction, (el) => {
      selectProject(el.dataset.projectId);
    });
  } else if (state.focusedPanel === 'session') {
    navigateList('#session-list .session-item', direction, (el) => {
      selectSession(el.dataset.sessionId);
    });
  }
}

function handleEnterSelect() {
  if (state.focusedPanel === 'project') {
    const active = document.querySelector('#project-list .project-item.active');
    if (active) {
      setFocusedPanel('session');
    }
  } else if (state.focusedPanel === 'session') {
    const active = document.querySelector('#session-list .session-item.active');
    if (active) {
      setFocusedPanel('detail');
    }
  }
}

function navigateList(selector, direction, onSelect) {
  const items = Array.from($$(selector));
  if (items.length === 0) return;

  const activeIdx = items.findIndex(el => el.classList.contains('active'));
  let newIdx = activeIdx + direction;
  if (newIdx < 0) newIdx = 0;
  if (newIdx >= items.length) newIdx = items.length - 1;

  if (newIdx !== activeIdx) {
    items[newIdx].scrollIntoView({ block: 'nearest' });
    onSelect(items[newIdx]);
  }
}

function setFocusedPanel(panel) {
  state.focusedPanel = panel;
  $$('.panel-focused').forEach(el => el.classList.remove('panel-focused'));
  const panelMap = { project: '#panel-projects', session: '#panel-sessions', detail: '#panel-detail' };
  const panelEl = $(panelMap[panel]);
  if (panelEl) panelEl.classList.add('panel-focused');
}

// ============================================================================
// Connection Status
// ============================================================================

function updateConnectionStatus() {
  const statusDot = $('#status-dot');
  const statusTextEl = $('#status-text');
  const headerDot = $('#header-connection-dot');

  let statusText, dotColor;
  if (state.wsConnected) {
    statusText = i18n.connected;
    dotColor = 'bg-cta';
  } else if (state.wsReconnectAttempts > 0) {
    statusText = `${i18n.reconnecting} (${state.wsReconnectAttempts})`;
    dotColor = 'bg-accent-amber';
  } else {
    statusText = i18n.disconnected;
    dotColor = 'bg-accent-red';
  }

  if (statusDot) {
    statusDot.className = `w-1.5 h-1.5 rounded-full ${dotColor}`;
  }
  if (statusTextEl) {
    statusTextEl.textContent = statusText;
  }
  if (headerDot) {
    headerDot.className = `w-2 h-2 rounded-full ${dotColor} ml-2`;
    headerDot.title = statusText;
  }
}

function updateStatsDisplay() {
  if (!state.stats) return;
  const projectsEl = $('#stat-projects');
  const sessionsEl = $('#stat-sessions');
  if (projectsEl) projectsEl.textContent = `${state.stats.total_projects || 0} ${i18n.projects}`;
  if (sessionsEl) sessionsEl.textContent = `${state.stats.total_sessions || 0} ${i18n.sessions}`;
}

// ============================================================================
// Local State Persistence
// ============================================================================

function saveState() {
  try {
    localStorage.setItem('cclog_state', JSON.stringify({
      selectedProjectId: state.selectedProjectId,
      selectedSessionId: state.selectedSessionId,
    }));
  } catch {}
}

function restoreState() {
  try {
    const saved = localStorage.getItem('cclog_state');
    if (saved) {
      const { selectedProjectId, selectedSessionId } = JSON.parse(saved);
      if (selectedProjectId) {
        selectProject(selectedProjectId).then(() => {
          if (selectedSessionId) {
            selectSession(selectedSessionId);
          }
        });
      }
    }
  } catch {}
}

// ============================================================================
// Panel Filter Inputs
// ============================================================================

function initFilterInputs() {
  // Project filter
  const projectSearch = $('#project-filter');
  if (projectSearch) {
    projectSearch.addEventListener('input', debounce((e) => {
      state.projectFilter = e.target.value.trim();
      renderProjects(state.projects);
    }, 200));
  }

  // Session filter
  const sessionSearch = $('#session-filter');
  if (sessionSearch) {
    sessionSearch.addEventListener('input', debounce((e) => {
      state.sessionFilter = e.target.value.trim();
      renderSessions(state.sessions);
    }, 200));
  }
}

// ============================================================================
// Detail Panel Action Buttons
// ============================================================================

function initDetailActions() {
  // Use data-action attribute delegation for detail panel buttons
  // This matches the HTML which uses data-action="..." instead of IDs

  // Export detail button (opens export modal or direct export)
  $$('[data-action="export-detail"]').forEach(el => {
    el.addEventListener('click', () => {
      if (state.selectedSessionId) {
        openExportModal();
      }
    });
  });

  // Share button
  $$('[data-action="share-session"]').forEach(el => {
    el.addEventListener('click', () => {
      if (state.selectedSessionId) {
        openShareModal();
      }
    });
  });

  // Copy session ID button
  $$('[data-action="copy-session-id"]').forEach(el => {
    el.addEventListener('click', () => {
      if (state.selectedSessionId) {
        copyToClipboard(state.selectedSessionId);
      }
    });
  });

  // Expand/Collapse all
  $$('[data-action="expand-all"]').forEach(el => {
    el.addEventListener('click', () => {
      $$('.collapsible-block.collapsed').forEach(block => {
        const header = block.querySelector('.collapsible-header');
        if (header) header.click();
      });
    });
  });

  $$('[data-action="collapse-all"]').forEach(el => {
    el.addEventListener('click', () => {
      $$('.collapsible-block:not(.collapsed)').forEach(block => {
        const header = block.querySelector('.collapsible-header');
        if (header) header.click();
      });
    });
  });

  // Search in session
  $$('[data-action="search-in-session"]').forEach(el => {
    el.addEventListener('click', () => {
      const bar = $('#session-search-bar');
      if (bar) {
        const isHidden = bar.classList.contains('hidden');
        bar.classList.toggle('hidden', !isHidden);
        bar.classList.toggle('flex', isHidden);
        if (isHidden) {
          const input = $('#session-search-input');
          if (input) input.focus();
        }
      }
    });
  });

  $$('[data-action="close-session-search"]').forEach(el => {
    el.addEventListener('click', () => {
      const bar = $('#session-search-bar');
      if (bar) {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
      }
      clearSessionSearchHighlights();
    });
  });

  // In-session search input
  const sessionSearchInput = $('#session-search-input');
  if (sessionSearchInput) {
    sessionSearchInput.addEventListener('input', debounce((e) => {
      performSessionSearch(e.target.value.trim());
    }, 200));
    sessionSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          navigateSessionSearch(-1);
        } else {
          navigateSessionSearch(1);
        }
      }
      if (e.key === 'Escape') {
        const bar = $('#session-search-bar');
        if (bar) {
          bar.classList.add('hidden');
          bar.classList.remove('flex');
        }
        clearSessionSearchHighlights();
      }
    });
  }

  // Search prev/next
  $$('[data-action="search-prev"]').forEach(el => {
    el.addEventListener('click', () => navigateSessionSearch(-1));
  });
  $$('[data-action="search-next"]').forEach(el => {
    el.addEventListener('click', () => navigateSessionSearch(1));
  });

  // Sort dropdown
  const btnSort = $('#btn-sort');
  const sortDropdown = $('#sort-dropdown');
  if (btnSort && sortDropdown) {
    btnSort.addEventListener('click', (e) => {
      e.stopPropagation();
      sortDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', () => sortDropdown.classList.add('hidden'));

    // Sort options
    sortDropdown.querySelectorAll('[data-sort]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const sortType = el.dataset.sort;
        sortDropdown.classList.add('hidden');
        applySortOrder(sortType);
      });
    });
  }

  // Batch toggle
  const batchToggle = $('#btn-batch-toggle');
  const batchBar = $('#batch-action-bar');
  if (batchToggle && batchBar) {
    batchToggle.addEventListener('click', () => {
      state.batchMode = !state.batchMode;
      batchBar.classList.toggle('hidden', !state.batchMode);
      batchBar.classList.toggle('flex', state.batchMode);
      // Re-render sessions to show/hide checkboxes
      renderSessions(state.sessions);
    });
  }

  // Batch action bar buttons (select-all, deselect-all, batch-export)
  $$('[data-action="select-all"]').forEach(el => {
    el.addEventListener('click', selectAllSessions);
  });
  $$('[data-action="deselect-all"]').forEach(el => {
    el.addEventListener('click', deselectAllSessions);
  });
  $$('[data-action="batch-export"]').forEach(el => {
    el.addEventListener('click', () => {
      batchExportSessions('markdown');
    });
  });

  // Export modal format buttons
  $$('[data-export-format]').forEach(el => {
    el.addEventListener('click', () => {
      const format = el.dataset.exportFormat;
      if (state.selectedSessionId) {
        if (format === 'html') {
          shareSession(state.selectedSessionId);
        } else {
          exportSingleSession(state.selectedSessionId, format);
        }
        closeExportModal();
      }
    });
  });

  // Close export modal
  $$('[data-action="close-export-modal"]').forEach(el => {
    el.addEventListener('click', closeExportModal);
  });

  // Close share modal
  $$('[data-action="close-share-modal"]').forEach(el => {
    el.addEventListener('click', closeShareModal);
  });

  // Generate share button
  $$('[data-action="generate-share"]').forEach(el => {
    el.addEventListener('click', () => {
      if (state.selectedSessionId) {
        shareSession(state.selectedSessionId);
        closeShareModal();
      }
    });
  });

  // Auto-scroll check
  const messageList = $('#message-list');
  if (messageList) {
    messageList.addEventListener('scroll', debounce(checkAutoScroll, 100));
  }

  // Header search trigger
  const headerSearch = $('#global-search-trigger');
  if (headerSearch) {
    headerSearch.addEventListener('click', openSearchModal);
  }

  // Scroll to bottom button
  const scrollBtn = $('#scroll-to-bottom');
  if (scrollBtn) {
    scrollBtn.addEventListener('click', () => {
      scrollMessagesToBottom();
    });
  }

  // Filter clear buttons
  initFilterClearButtons();
}

// Sort order handler
function applySortOrder(sortType) {
  if (!state.sessions || state.sessions.length === 0) return;

  switch (sortType) {
    case 'date-desc':
      state.sessions.sort((a, b) => new Date(b.start_time || 0) - new Date(a.start_time || 0));
      break;
    case 'date-asc':
      state.sessions.sort((a, b) => new Date(a.start_time || 0) - new Date(b.start_time || 0));
      break;
    case 'messages':
      state.sessions.sort((a, b) => (b.message_count || 0) - (a.message_count || 0));
      break;
  }
  renderSessions(state.sessions);
}

// Export modal
function openExportModal() {
  const modal = $('#modal-export');
  if (modal) modal.classList.remove('hidden');
}

function closeExportModal() {
  const modal = $('#modal-export');
  if (modal) modal.classList.add('hidden');
}

// Share modal
function openShareModal() {
  const modal = $('#modal-share');
  if (modal) modal.classList.remove('hidden');
}

function closeShareModal() {
  const modal = $('#modal-share');
  if (modal) modal.classList.add('hidden');
}

// Filter clear buttons
function initFilterClearButtons() {
  const projectFilter = $('#project-filter');
  const projectClear = $('#project-filter-clear');
  if (projectFilter && projectClear) {
    projectFilter.addEventListener('input', () => {
      projectClear.classList.toggle('hidden', !projectFilter.value);
    });
    projectClear.addEventListener('click', () => {
      projectFilter.value = '';
      projectClear.classList.add('hidden');
      state.projectFilter = '';
      renderProjects(state.projects);
      projectFilter.focus();
    });
  }

  const sessionFilter = $('#session-filter');
  const sessionClear = $('#session-filter-clear');
  if (sessionFilter && sessionClear) {
    sessionFilter.addEventListener('input', () => {
      sessionClear.classList.toggle('hidden', !sessionFilter.value);
    });
    sessionClear.addEventListener('click', () => {
      sessionFilter.value = '';
      sessionClear.classList.add('hidden');
      state.sessionFilter = '';
      renderSessions(state.sessions);
      sessionFilter.focus();
    });
  }
}

// ============================================================================
// Initialization
// ============================================================================

async function loadProjects() {
  state.loading.projects = true;
  renderProjects(state.projects);

  try {
    const data = await api.fetchProjects();
    state.projects = data.projects || [];
    state.loading.projects = false;
    renderProjects(state.projects);
  } catch (err) {
    state.loading.projects = false;
    showToast(`加载项目失败: ${err.message}`, 'error');
    renderProjects([]);
  }
}

async function loadStats() {
  try {
    state.stats = await api.fetchStats();
    updateStatsDisplay();
  } catch {}
}

function initWebSocket() {
  ws.connect();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Clean up demo/static content from HTML
  cleanupDemoContent();

  // Initialize all components
  initPanelResize();
  initKeyboardShortcuts();
  initFilterInputs();
  initDetailActions();
  initWebSocket();

  // Load initial data
  await loadProjects();
  loadStats();

  // Restore previously selected project/session
  restoreState();

  // Set initial focused panel
  setFocusedPanel('project');

  console.log('CC LOG initialized');
});

function cleanupDemoContent() {
  // Remove demo toasts from the toast container
  const toastContainer = $('#toast-container');
  if (toastContainer) {
    toastContainer.innerHTML = '';
  }

  // Clear demo content from search modal results
  const searchResults = $('#modal-search-results');
  if (searchResults) {
    searchResults.innerHTML = '';
  }
}
