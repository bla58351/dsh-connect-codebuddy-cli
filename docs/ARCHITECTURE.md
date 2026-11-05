# 代码结构

本插件是一个 DSH bundle：一个 `package.json`、一层 `cordis.patch.yml`，加上分成职责模块的
`src/`。这份文档说明每个目录为什么存在、改动应该落在哪里。

## 目录

```text
dsh-connect-codebuddy-cli/
├── package.json          # 包清单：exports / files / dsh.bundle / dsh.client
├── cordis.patch.yml      # bundle 层：插入一行插件条目（id = connect-codebuddy-cli）
├── index.js              # 入口：只做装配，并把公开导出汇总成包的门面
├── AGENTS.md             # agent 与贡献者规则：改代码必须同步改文档等
├── src/
│   ├── adapter/          # LLM 协议侧：把一次 CLI 调用讲成 DSH 的流
│   │   ├── adapter.js    #   provider 路由：模型列表、倍率、会话保活、账号切换
│   │   └── turn.js       #   一次 CLI 调用的帧翻译与 turn 级安全重试标记
│   ├── bridge/           # 两条桥：DSH 工具给模型用，模型工具调用给界面看
│   │   ├── mcp.js        #   loopback MCP 服务（HTTP）
│   │   ├── shim.mjs      #   stdio MCP 外壳，CLI 作为子进程拉起它
│   │   ├── tools.js      #   把勾选的 DSH 工具暴露出去，并执行回来
│   │   ├── cards.js      #   把 CLI 已执行的调用渲染成原生卡片（不重放）
│   │   └── builtin-tools.js # 内置工具名清单，用于标注"非内置"
│   ├── cli/              # 与本机 CodeBuddy CLI 的进程契约
│   │   ├── session.js    #   spawn/argv/权限应答/进程回收/转录路径/私有临时文件
│   │   └── catalog.js    #   模型目录、部署清单、倍率标签解析
│   ├── account/          # 账号与计费
│   │   ├── session.js    #   读取当前登录、积分、CLI 状态（令牌不出模块）
│   │   ├── readiness.js  #   不可用原因的文案（缺 CLI / 未登录 / 过期）
│   │   └── pool.js       #   多账号池：隔离家目录、登录命令、积分探测、冷却与选人
│   ├── conversation/     # 对话本身
│   │   ├── messages.js   #   谁是"人类这一轮"、历史指纹（回退检测）
│   │   └── digest.js     #   跨模型交接 / 回退后的上下文重建摘要
│   ├── host/             # 与 DSH 宿主打交道
│   │   ├── page.js       #   插件页的 RPC 通道、端点与保存处理器
│   │   ├── readiness.js  #   转发 account/readiness（host 侧导入点）
│   │   └── attachments.js#   把附件服务交给适配器，用于读用户图片
│   ├── config/           # 本插件自己的持久化
│   │   ├── store.js      #   settings.json / histories.json（原子写）
│   │   └── prompt.js     #   三种提示词来源与自定义文本上限
│   └── client/
│       └── index.js      # 浏览器侧单文件 bundle（window.__ModuleLoader__）
├── locale/               # 插件显示名与描述（en/zh）
├── assets/icon.svg       # 插件图标
├── docs/
│   ├── ARCHITECTURE.md   # 本文件
│   └── DETAILS.md        # 实现细节、设计取舍、已知边界
├── test/                 # 离线套件（假 CLI + 假 Host）与真实 CLI 套件
└── scripts/
    ├── check.mjs         # 全量语法检查
    ├── check-docs.mjs    # 文档一致性检查（测试计数 / 目录树 / 发布清单）
    └── test.mjs          # 测试入口（默认只跑离线套件）
```

## 依赖方向

分层只有一个方向，反向依赖视为缺陷：

```text
index.js ──> host/ ──> adapter/ ──> bridge/ ──> cli/ ──> account/
                 │          │           │          │
                 └──────────┴───────────┴──────────┴──> conversation/, config/
```

`conversation/` 与 `config/` 是叶子：它们不 import 上层，任何一层都可以用它们。
`account/` 也是任何层都可以用的叶子（readiness 文案与登录读取都在那里，适配器的
起飞前检查要与页面共用同一份答案）。
`adapter/turn.js` 不 import `adapter/adapter.js`，反之亦然——适配器持有 turn，turn 不知道适配器存在。

## 改动落在哪里

| 想改的东西 | 落点 |
|---|---|
| CLI 参数、启动环境、临时提示词文件 | `src/cli/session.js` |
| 权限模式推导与 CLI 权限请求的应答 | `src/cli/session.js`（`permissionModeFor` / `#answerControlRequest`）；转发到 DSH 审批在 `src/adapter/adapter.js`（`#permissionFor` / `#askApproval`） |
| 模型列表/倍率/部署清单 | `src/cli/catalog.js` |
| 一轮对话的流式翻译、工具卡渲染 | `src/adapter/turn.js` |
| 保活、账号切换、会话缓冲 | `src/adapter/adapter.js` |
| 插件页任何控件与保存逻辑 | `src/host/page.js`（宿主侧）+ `src/client/index.js`（界面） |
| 新设置项 | `src/config/store.js` 读写 + `src/host/page.js` 端点 + 页面控件 |
| 提示词文本与来源 | `src/config/prompt.js`、`adapter` 的 `#systemPromptText` |
| 交接摘要/回退重建 | `src/conversation/digest.js` |
| 回退检测 | `src/conversation/messages.js` |
| 不可用原因文案（缺 CLI / 未登录 / 过期） | `src/account/readiness.js`（`host/readiness.js` 只是转发） |
| 账号池、家目录隔离、冷却与失败分类 | `src/account/pool.js`、`adapter` 的 `#noteAccountOutcome` |

## 约定

- **纯 ESM，无构建步骤**：DSH 直接加载源码，`node --check` 是唯一静态门。
- **公开面只在包根**：`index.js` 汇总导出 `apply`、`Config`、`PROVIDER_ID` 与测试用的纯函数；
  内部模块之间直接相对导入。
- **客户端单文件**：`src/client/index.js` 由 Host 通过 `exports["./client"]` 加载，不能拆成多文件。
- **JSDoc**：每个导出都有描述与 `@param`，因为这是唯一的"类型"来源。
- **无凭据**：令牌只在 `account/session.js` 内部使用，永不进入页面数据或日志。