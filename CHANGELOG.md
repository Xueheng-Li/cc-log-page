# Changelog

All notable changes to CC LOG will be documented in this file.

## [1.0.0] - 2026-02-24

### Added
- 三栏式布局：项目面板、会话面板、详情面板
- FastAPI 后端：12 个 REST 端点 + WebSocket 实时推送
- JSONL 解析器：支持 7 种消息类型（user、assistant、system、progress、summary 等）
- 全局搜索（`⌘K`）：跨项目全文搜索，毫秒级响应
- 会话导出：JSONL / Markdown / HTML 三种格式
- 批量导出：多会话打包 ZIP 下载
- 会话分享：生成独立可分享 HTML 页面
- 会话内搜索：Ctrl+F 风格，支持上下导航
- 会话 ID 一键复制（方便 `claude --resume`）
- WebSocket 实时同步：新会话、新消息自动推送
- 文件监听（watchfiles）：自动发现新日志文件
- 键盘快捷键：方向键导航、Alt+1/2/3 切换面板
- 可拖拽面板宽度，自动保存到 localStorage
- 项目/会话筛选过滤
- 工具调用和思考过程块可展开/折叠
- 暗色主题：开发者工具风格
- 全中文界面
