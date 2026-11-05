# AGENTS.md

写给在本仓库工作的 AI agent 与贡献者的规则。项目是 `dsh-connect-codebuddy-cli`：
一个 DSH bundle 插件，把本机 CodeBuddy CLI 的模型接进 DSH 的模型选择器。
背景与目录职责见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 规则一：每次修改必须同步更新文档

**任何改动代码的提交，必须在同一次修改里更新受影响的文档。** 这不是建议：
`npm test` 会运行 `scripts/check-docs.mjs`，文档与代码不同步时测试直接失败。

改了什么 → 必须动哪些文档：

| 改动 | 必须同步 |
|---|---|
| 用户可感知的行为变化（新功能、行为调整、修复） | [CHANGELOG.md](CHANGELOG.md) 的 `[未发布]` 段落，按 Keep a Changelog 分类 |
| 新增 / 移动 / 删除文件，模块职责变化 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 的目录树与"改动落在哪里"表 |
| 新增或删除断言（测试数量变化） | [docs/DETAILS.md](docs/DETAILS.md) 对应 suite 的"（N 项"计数，**以及** `scripts/check-docs.mjs` 里的 `RUNTIME_COUNTS` |
| 用户可见的功能、安装、设置说明 | [README.md](README.md) |
| `src/`、`scripts/`、`docs/`、`assets/`、`locale/` 下任何新文件 | [package.json](package.json) 的 `files` 必须能匹配到它，否则 docs 检查报"exists but is not matched" |

原则：文档写的是"现在是什么样"，不是"改了什么"。直接改文档到新状态，
不要在里面留"最近改了 XX"之类的过时叙述——那类内容只进 CHANGELOG。

## 硬性约束

这些约定来自 docs/ARCHITECTURE.md，违反即视为缺陷：

- **依赖方向单向**：`index.js → host/ → adapter/ → bridge/ → cli/ → account/`；
  `conversation/`、`config/` 与 `account/` 是叶子，不 import 任何上层。
  `adapter/turn.js` 与 `adapter/adapter.js` 互不 import。
- **纯 ESM，无构建步骤**：DSH 直接加载源码，`node --check` 是唯一静态门。
- **公开面只在包根**：`index.js` 汇总导出；内部模块之间直接相对导入。
- **客户端单文件**：`src/client/index.js` 不能拆分成多文件。
- **JSDoc**：每个导出都有描述与 `@param`——这是唯一的"类型"来源。
- **无凭据**：令牌只在 `account/session.js` 内部使用，永不进入页面数据或日志。

## 测试与验证

```bash
npm test        # 语法检查 → 文档一致性 → 离线套件（假 CLI + 假 Host，不调模型不联网）
npm run check   # 只跑语法检查
npm run test:live   # 真实 CLI 套件（会花积分），仅明确要求时运行
```

- 默认只跑离线套件；不要为了验证而擅自跑 `test:live`。
- `test/matrix.mjs` 是依赖账号与网络的活体套件，文档里只提名字，不固定计数。
- 改动落在哪里：按 docs/ARCHITECTURE.md 的"改动落在哪里"表找文件，不要猜。

## 提交前自查

1. `npm test` 通过（尤其注意 docs 检查的输出）。
2. 对照上面那张表：这次的改动，每个"必须同步"都真的改了吗？
3. CHANGELOG 写的是行为变化，不是实现流水账。
