# @jsmart/jsmart-desktop

JSmart 桌面应用 — 基于 Electron 的多会话 AI 编程助手。

直接使用 `@jsmart/jsmart-harness` 构建，与 `@jsmart/jsmart-coding-agent` CLI 共享配置和模型文件。

## 功能

- **多会话并行** — 同时打开多个项目，各自独立运行，切换不中断
- **流式 Markdown 渲染** — 代理输出实时解析，代码语法高亮
- **历史会话管理** — 按工作空间分组，会话标题可编辑，持久化到本地
- **折叠详情** — 工具调用、思考过程、中间输出折叠，只展示最终结果
- **可缩放侧边栏** — 拖拽调节宽度，工作空间可折叠
- **自适应布局** — 窗口任意缩放，对话区域自动适配

## 快速开始

### 前置条件

- Node.js >= 20
- 已配置 `~/.jsmart-coding/settings.json` 和 `~/.jsmart-coding/models.json`
  （与 CLI 共用，参考 `@jsmart/jsmart-coding-agent` 文档）

### 开发模式

```bash
cd packages/desktop
npm run dev
```

会自动：
1. 构建 main / preload / renderer 三个 bundle
2. 启动 Vite dev server（HMR 热更新）
3. 打开 Electron 窗口

### 打包

```bash
npm run dist:mac     # macOS .dmg
npm run dist:win     # Windows .exe
npm run dist:linux   # Linux .AppImage
```

输出在 `release/` 目录。

## 架构

```
┌─────────────────────────────────────────────────┐
│  Main Process (Node.js)                         │
│                                                 │
│  ┌───────────────┐  ┌─────────────────────────┐ │
│  │ ConfigLoader  │  │ SessionManager          │ │
│  │               │  │                         │ │
│  │ ~/.jsmart-    │  │ sessions: Map<          │ │
│  │   coding/     │  │   id → AgentSession     │ │
│  │   settings    │  │ >                       │ │
│  │   models      │  │                         │ │
│  └───────┬───────┘  └───────────┬─────────────┘ │
│          │                      │               │
│  ┌───────┴──────────────────────┴─────────────┐ │
│  │ IpcHandlers (ipcMain.handle)               │ │
│  │ session:create / :delete / :prompt         │ │
│  │ session:abort / :changeModel               │ │
│  │ app:listSessions / :loadHistory            │ │
│  │ app:updateTitle / :selectProject           │ │
│  │ session:event → webContents.send           │ │
│  └──────────────────────┬──────────────────────┘ │
└─────────────────────────┼────────────────────────┘
                          │ contextBridge
┌─────────────────────────┼────────────────────────┐
│  Preload (preload.ts)   │                        │
│  window.jsmart.session.*│                        │
│  window.jsmart.app.*    │                        │
└─────────────────────────┼────────────────────────┘
                          │
┌─────────────────────────┼────────────────────────┐
│  Renderer (React 19)    │                        │
│                         │                        │
│  ┌──────────┬──────────────────────────────┐    │
│  │ Sidebar  │ ChatView                     │    │
│  │ 工作空间  │ • MarkdownRenderer            │    │
│  │  └ 会话  │ • ToolCard (折叠)             │    │
│  │          │ • InputBox (悬浮)             │    │
│  └──────────┴──────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### 进程职责

| 进程 | 框架 | 职责 |
|---|---|---|
| **Main** | Node.js | 管理 `AgentSession` 实例，IPC 处理，文件系统访问 |
| **Preload** | Node.js | `contextBridge` 暴露安全 API 给 Renderer |
| **Renderer** | React 19 + Vite | UI 渲染，事件接收，状态管理 |

### 数据流

```
用户点击发送
  → ipc session:prompt(sessionId, text)
  → Main: agentSession.prompt(text)
  → AgentSession 流式事件
  → Main: webContents.send("session:event", ...)
  → Renderer: onEvent callback → 更新会话状态 → React 重渲染
```

## 会话存储

```
~/.jsmart-coding/
├── settings.json              # 全局配置（共享）
├── models.json                # 模型配置（共享）
├── sessions.json              # 会话索引
└── sessions/
    └── <project-hash>/
        └── <session-id>.jsonl # 会话消息
```

### sessions.json 结构

```json
{
  "workspaces": {
    "/Users/lijie/work/my-project": [
      {
        "id": "uuid",
        "title": "重构 auth 模块",
        "mtime": 1718000000000
      }
    ]
  }
}
```

### 与 CLI 的关系

- 共享 `~/.jsmart-coding/settings.json` 和 `models.json`
- 共享 `~/.jsmart-coding/skills/` 技能目录
- 桌面应用的会话文件存储在 `~/.jsmart-coding/sessions/`，CLI 的存储在项目 `.jsmart/sessions/`，**互不冲突**

## 依赖

| 包 | 用途 |
|---|---|
| `@jsmart/jsmart-harness` | AgentSession, 工具, 配置, SessionManager |
| `@jsmart/jsmart-ai` | 类型定义 |
| `electron` | 桌面框架 |
| `electron-vite` | 构建工具链 |
| `react` / `react-dom` | UI 框架 |
| `react-markdown` | Markdown 渲染 |
| `remark-gfm` | GFM 扩展（表格、任务列表） |
| `rehype-highlight` + `highlight.js` | 代码语法高亮 |
| `electron-builder` | 打包分发 |

## 目录结构

```
packages/desktop/
├── src/
│   ├── main/                     # Main Process
│   │   ├── index.ts              # Electron 入口，窗口管理
│   │   ├── config.ts             # 配置加载 & 会话索引管理
│   │   ├── agent-factory.ts      # 组装 AgentSession
│   │   ├── session-manager.ts    # 多会话生命周期
│   │   └── ipc-handlers.ts       # IPC 注册
│   ├── preload/
│   │   └── index.ts              # contextBridge API
│   └── renderer/
│       ├── index.html            # HTML shell
│       └── src/
│           ├── main.tsx          # React 入口
│           ├── App.tsx           # 主组件 & 事件处理
│           ├── App.css           # 全局样式
│           ├── global.d.ts       # window.jsmart 类型
│           ├── components/
│           │   ├── MarkdownRenderer.tsx
│           │   ├── ToolCard.tsx
│           │   └── ToolCard.css
│           └── lib/
│               └── types.ts      # UI 类型定义
├── resources/                    # 应用图标
├── electron.vite.config.ts       # electron-vite 配置
├── electron-builder.yml          # 打包配置
├── package.json
├── tsconfig.json
├── tsconfig.node.json
└── tsconfig.web.json
```

## License

MIT
