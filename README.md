# wechat-site — 本地增强聊天功能（Option A）

此仓库演示如何在纯前端 Chat 页面中添加：

- 启动导入历史聊天（从 `.txt` 恢复）或开始新会话的弹窗。
- 导出会话为 `.txt`（通用下载或使用 File System Access API 在 Chromium/Brave 中持久保存）。
- 自动保存（自动下载或使用持久文件句柄）与 IndexedDB 备份（临时防丢失）。
- 记忆压缩占位逻辑：默认保留最近 N=25 条对话为即时上下文；超过部分定期调用 `/api/summarize`（示例 Worker）生成 memory chunk，并对 memory chunk 做简单管理（合并/裁剪）。
- 导入/导出格式：文本文件包含 header JSON + 分隔符 `----CHAT-JSON----` + 聊天数组 JSON，便于恢复和跨设备迁移。

注意：此实现为前端优先的最小可行版本（Option A），真实使用时建议：

- 在 Cloudflare Worker（或其他后端）中实现真实的 summarization、embedding、语义检索与 TTS 生成功能，并把 API key 放在后端。仓库中提供了 `workers/example_worker.js` 作为占位示例。
- File System Access API 目前仅在 Chromium 系列（包括 Brave）支持。Firefox 不支持持久文件句柄。

快速运行和部署提示：

1. 将项目部署为静态站点（Cloudflare Pages / GitHub Pages / Netlify 等）。
2. 若使用 Cloudflare Workers 部署后端，请把 `workers/example_worker.js` 的占位逻辑替换为真实的 Claude/Anthropic 调用，并把密钥放在 Worker 的环境变量中。

文件说明：
- `index.html` — 主页面（已集成前端 UI 与设置）。
- `static/chat.js` — 负责导入/导出、IndexedDB 备份、File System Access 持久写入、记忆 chunk 管理与 summarize 占位调用。
- `workers/example_worker.js` — Cloudflare Worker 示例，提供 `/api/summarize` 占位接口。

导出/导入格式示例：

文件头部（JSON）示例：

{"version":1,"exportedAt":"2025-10-31T12:00:00Z","length":42}
----CHAT-JSON----
[ {"role":"user","text":"你好","ts":123456 }, ... ]

兼容性说明：
- 自动写入持久文件需要用户首次授权并仅在 Chromium/Brave 可用。作为回退，本实现会触发浏览器下载，文件保存在用户下载文件夹（不占浏览器存储）。
- IndexedDB 用作临时备份，避免在未授权文件写入时丢失会话。

下步建议：
- 在 Worker 中实现 embedding + 向量检索（例如使用 Pinecone / Milvus / Supabase vector）以替换前端的朴素匹配，并在每次用户消息时检索 top-k chunk 附加到 prompt。
- 把 TTS（mp3）实现放到后端以避免在浏览器端转码开销。

