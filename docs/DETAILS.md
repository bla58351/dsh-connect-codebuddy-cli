# dsh-connect-codebuddy-cli

把 CodeBuddy 的模型接进 DSH 的模型选择器。选中 CodeBuddy 模型后，这一轮推理由本机已登录的 CodeBuddy CLI 真正执行，DSH 只负责显示与传输。

这里没有 API key，也没有新的登录流程：插件直接复用你已经登录的 CodeBuddy CLI。

## 它做什么

插件注册一个 provider 路由 `codebuddy`，把本机 CodeBuddy CLI 能用的模型列进 DSH 的模型选择器。选中其中一个模型发消息时，DSH 把这一轮的**最新一条用户消息**交给 CLI，CLI 用自己的登录、自己的模型、自己的上下文窗口完成推理，插件再把 CLI 的输出流翻译成 DSH 能显示的文本、思考过程和用量。

对话记录、界面、历史都由 DSH 负责；插件只替换「这一轮的 token 从哪来」。

## 前置条件

1. 已安装 CodeBuddy CLI（`npm i -g @tencent-ai/codebuddy-code`）。
2. 已经用它登录过一次（`codebuddy` 然后按提示登录）。插件不读取、也不保存任何凭据。

## 安装

```bash
dsh plugin --profile <你的 profile> add link:E:/path/to/dsh-connect-codebuddy-cli
```

或者在插件管理界面里添加这个 bundle。装好后重启 DSH，模型选择器里会出现 **CodeBuddy** 分组。

## 配置

全部可选。默认自动探测 CLI、列出它声明支持的所有模型。

```yaml
- id: connect-codebuddy-cli
  name: dsh-connect-codebuddy-cli
  config:
    # CLI 的 JS 入口绝对路径；留空则自动探测。
    binary: ''
    # 只暴露这些模型；留空表示全部。
    models: []
    # 交给 CLI 的工作目录；留空表示用会话自己的。
    cwd: ''
    # 单次 CLI 调用里模型最多可以思考几步；留空/0 用 200（CLI 自己的默认值）。
    maxTurns: 0
```

`binary` 在 Windows 上必须是包内的 JS 入口（`…/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy`），不能指向 `.cmd` 包装：运行 `.cmd` 要经过 `cmd.exe`，它会把 `--model`、`--session-id` 当成命令重新解释。插件会拒绝这种路径而不是冒险运行。

`maxTurns` 对应 CLI 的 `--max-turns`，**计的是模型调用次数，不是工具调用次数**：同一步里并行发出的多个工具调用只算一步，而"等上一个结果再决定下一步"的任务每步都要花一次。所以一个正常的长任务（例如逐个处理一份清单）很容易超过 30，撞上就会整轮报 `Max turns (N) exceeded` 并把这一轮判为失败。插件因此采用 CLI 自己的默认值 200，而不是更紧的数字；确实想限制时再往下调。

## 后端保活

CLI 以 `--input-format stream-json` 启动，**不是一次性的**：它报完 `result` 之后会停在 stdin 上等下一条消息（CLI 自己那套 `streamJsonDrainTrigger` 长轮询就是这么用的）。插件利用这一点把进程留下来：

- **每条消息跑完后**，进程按保活时长继续保留（默认 5 分钟，可在插件页设置；0 表示跑完就关）。
- 保留期间，**同一个会话且启动参数完全一致**的再发消息会直接写进这个进程，省掉一次约 3 秒的启动；模型、思考档位、工作目录或账号任一变化都会换新进程，不能复用旧配置。
- 超时、会话被替换、插件卸载时关闭进程（`dispose` 会收掉所有进程）。POSIX 先给进程组 `SIGTERM`，宽限期后仍存活则补 `SIGKILL`；Windows 等待强制 `taskkill` 完成，避免子进程越过取消或卸载继续运行。
- 即便这一轮以失败告终（例如被限流），只要 CLI 正常回了 `result`，进程仍然会留下——配额恢复后的重试不必再付一次启动成本。

保活时长存在 `$DSH_HOME/dsh-connect-codebuddy-cli/settings.json` 的 `keepAliveSeconds` 里，上限 3600 秒。

**打开插件页会启动后端**：`overview` 之后页面立刻发一次 `warm`。预热需要一个具体会话——CLI 的历史是按 session id 存的——所以优先用本进程最近服务过的会话，还没有任何会话时退到磁盘上最近修改的 DSH 会话记录；两者都没有就如实说"先发一条消息"。预热会继承该会话绑定的账号及其部署清单，不会暗中改用默认账号；绑定失效时才重新从账号池选择。

## 模型列表从哪来

成员资格来自 CLI 自己的 `--help` 里 `--model` 那段声明——那是唯一不联网、不登录、也不用逐个试探就能确定的答案。

`product.json` 只用来补充展示信息（显示名、上下文窗口、是否支持图片、默认思考档位）。它**不**决定成员资格，因为它还列着这个账号根本调不动的模型。所以最终列出的，是「CLI 声明支持」且「账号实际可用」的交集。

模型列表由服务端控制，CLI 升级后可能变化，所以会重新读 `--help`；但读的是同步 spawn（会阻塞事件循环），因此按入口缓存 10 分钟，避免每次模型清单读取、开页、预热都冻结宿主。

## 思考等级

选中模型后，模型选择器里会有一个四档思考等级菜单：**低 / 中 / 高 / 最高**（对应 CLI 的 `--effort low|medium|high|max`）。选中的档位会原样传给 CLI，CLI 用它的深度来推理。默认不传 `--effort`，让 CodeBuddy 用它自己声明的档位。

CLI 其实接受六档（`--effort` 的 help 里是 minimal/low/medium/high/xhigh/max），菜单只列四档：实测 `minimal` 和 `xhigh` 并没有带来相邻档位之外的额外深度，而且让所有模型共用同一份档位表，选择器就不会在不同模型之间变来变去。

这里有两个坑，都是实测踩出来的：

**菜单必须由 `listModels` 返回，不能只靠 `resolveModel`。** 模型选择器读的是模型目录 RPC 里 `groups[].models[].reasoning`，也就是 `listModels` 的返回（`model-selection-client.js:755` 把它存进 `this.reasoning`，`:1203` 再取出来渲染）。最初 `availableModels` 只返回 `provider/id/name/description` 四字段，于是选择器里**所有模型**都没有思考菜单——而 `resolveModel` 单独看是完全正常的。现在 `availableModels` 直接复用 `modelInfoFor`，两条路径不会再分叉。

**`product.json` 不能当作「这个模型支不支持 effort」的依据。** CLI `--help` 宣告 16 个模型，`product.json` 只覆盖其中 7 个。按 manifest 有没有声明来开菜单，另外 9 个（包括 `deepseek-v4-pro` 这个最强的推理模型）就完全没有菜单。实测证明这是错的：`deepseek-v4-pro` 同一道算术题在 `low` 下思考 61 字符、在 `max` 下 242 字符；`step-5-preview`、`minimax-m3.1-flash`、`minimax-m2.7`、`mimo-v2.6-pro`、`kimi-k3.1-pro`、`kimi-k3-1`、`hy3-x` 也都响应 `--effort`。manifest 里没有条目只说明「厂商没公布档位表」，不代表模型忽略 `--effort`。所以现在每个模型都给同一份四档菜单；manifest 只在两处仍被采用——声明 `supportsReasoning: false` 的模型不给菜单，声明了 `defaultEffort` 的模型用它做预选值。

## 一个 DSH 会话怎么对应一次 CLI 调用

CodeBuddy CLI 自己把对话历史存在磁盘上（`~/.codebuddy/projects/<cwd-slug>/<session-id>.jsonl`；目录根按 CLI 的解析顺序 `CODEBUDDY_CONFIG_DIR` → `CODEBUDDY_HOME` → `~/.codebuddy`）。默认账号按宿主环境的这个顺序解析；池账号则把该账号自己的 configDir 显式传给回退删除和交接检查，不能因为子进程环境不同而误用默认账号的路径。所以插件不为每一轮重放 DSH 的历史，而是：

1. 把 DSH 的 session id 映射成一个**文件名安全**的 CLI session id（DSH 的 id 里可能有 `:`、大写字母，这些在 CLI 那边是非法文件名）；
2. 每轮只把**最新一条用户消息**发给 CLI；
3. CLI 用同一个 session id 接上它自己那份历史；
4. 这一次 CLI 调用**跨多个 DSH step** 交付：CLI 每产出一条助手消息，就是 DSH 的一步（见下一节）。

于是两边的历史只需要在「当前这条消息」上一致，其余各自管理。实测：同一个 DSH 会话连问两轮，第二轮仍能答出第一轮说过的名字；换一个 session id 就问不出来。没有 DSH session id 的调用是一次性请求：每个新请求使用随机 CLI session id，不写共享的历史指纹、不保活，也不会复用其他匿名请求的转录；它自己的续步仍由内存中的同一个 turn 接续。

### 对话回退（`/rewind`）会被接住

DSH 侧回退一段对话时，删掉的是 **DSH 的历史**，CLI 磁盘上那份转录不会跟着变——如果不管，模型下一轮还会"记得"你已经撤销的内容。

插件每一轮都记下这次对话的**指纹**（只有对话本身：人类消息、助手回答、工具结果，注入的运行时提醒与回退标记都不算），下一次开新轮时比对：

- **是前缀（正常增长）** → 什么都不做，热进程照用；
- **变短，或中途分叉** → 判定为回退/改写：立刻丢弃保温进程与正在跑的 turn（还活着的 CLI 可能在退出时重写文件），**删除**这个派生会话的转录文件，然后用**幸存下来的历史**重建一份上下文随下一条消息发过去。

重建用的预算比跨模型交接宽得多（最多 40 条、每条 2000 字符、总计 24000 字符），因为回退是"从头重建"而不是"打个招呼"。指纹持久化在 `~/.dsh/dsh-connect-codebuddy-cli/histories.json`，所以**回退后重启过 DSH 也照样能认出来**。

### 旁路请求（会话标题）单独走一条路

DSH 还会用同一个 provider、同一个 session id **并发**发一条"生成会话标题"的请求（`options.purpose` 有值，消息来源是 `dsh-session-title-llm`）。它不是用户那一轮：如果让它占用会话的 turn 槽位，它会把正在跑的 CLI 进程关掉，真实回答就永远不来了——现象是整轮报 `CodeBuddy CLI turn was cancelled`。所以这类请求拿一个**不被登记**的临时 turn，并且用自己独立的 CLI session id（`<会话id>#<purpose>` 再哈希），否则标题提示词会被写进用户自己的 CodeBuddy 历史。

## 一步 = 一条 CLI 助手消息

一次 CLI 调用只跑一个进程，但它产生的助手消息是一条一条交付给 DSH 的：CLI 的 `message_stop` 就是 DSH 的 step 边界。

这不是拆得好看，而是 DSH 的渲染方式逼出来的。DSH 的对话流里，**一条助手消息是一行**，行位置锚定在这条消息的第一个文本增量上，消息里的文字全部在这一行里渲染；工具卡是另一行，锚在自己那条 `tool-call` 增量上，所以永远排在那条消息之后。把一整轮塞进一条消息，结果就是：

- **卡片全堆在输出末尾**。哪怕模型是先说一句、再调工具、再接着说，后面的文字也会渲染在整段文字里，卡片只能落到它后面。
- **最终输出被折叠**。DSH 只把「最新一步、且这一步的块里没有 tool-call」的那条消息认作答案（`latestAnswer`）；一条既带文字又带 tool-call 的消息不满足条件，整轮就没有答案，于是所有内容都成了「过程」，被折进可展开的过程组里。

拆成多条消息之后，两条症状一起消失：每条消息的文字在本行，卡片紧跟其后、位于下一条消息之前；最后一条消息只有文字，DSH 认得出它是答案，展开着显示。

实现上，停在 `message_stop` 之后并不立刻放手：插件继续把 CLI 的帧读下来，直到这条消息里**所有**工具调用的结果都到齐，才交出这一步——DSH 在这步一结算就立刻派发卡片，结果还没记下来，卡片展开就是空的。CLI 一定在开下一条消息之前报回结果，所以这个等待是有界的；真到了结果已到、下一步还没来的那一小段，CLI 只是在自己跑工具，没人读它的输出也不会丢内容（管道缓冲满了它等一下就是了）。

如果 CLI 在工具调用之后就不再说话（`--max-turns` 用尽、内部报错），DSH 仍会要一步；这一步回一个空 step 就结束了，**不会**再起一个 CLI 进程——那会把同一个问题回答两遍。

## 注入内容与工具调用

DSH 会在用户消息之后插入几段 `role: 'user'` 的上下文（运行时快照、技能目录、时间戳等）。如果直接取「最后一条 user 消息」，交给 CLI 的就是系统提醒而不是用户的问题——模型会去回答提醒。

判断「哪条是人写的」用的是**白名单**而不是黑名单：人发的消息 `source.kind` 就是 `'user'`，其余一律是机器注入，直接跳过。这一点很关键：`@deepseek-ai/dsh-time-context`（只在 GUI 的 agent preset 里启用，headless 没有）会在人类消息**之后**再追加一条 `role: 'user'`、`source.kind` 为 `'time-context'` 的消息，内容是「Time sampled while preparing turn 3, step 1: …」这样的纯时间戳。按位置取最后一条就会把它当成用户输入，模型于是答「I don't see a request in that message — it only contains a timing stamp」。

用黑名单（把已知的注入 kind 一个个列出来）也能修，但每出一个新插件就要再补一条；白名单只需要认准人这一侧。

### 工具：由 CLI 执行，界面显示成原生工具卡

CLI 以 `--tools default --permission-mode <由 DSH 设置推导> --max-turns 200` 运行，**工具真的会被执行**：读文件、写文件、跑命令都在插件启动的那个 CLI 进程里完成，一轮之内可以连续调用多次。

界面里这些调用显示成 DSH **原生的工具卡**（可展开、能看到参数和结果），和你在 DSH 里直接调工具时看到的一样。这里有个必须绕开的陷阱：DSH 收到 `tool-call` 块会交给它自己的工具注册表去执行，而 CLI 已经执行过了——直接翻译就会让同一个写文件动作发生两次。

解法是给卡片配一个**只回放的执行器**：插件在 `tools/execute` 里看到某个调用带着 CLI 的 call id，就为**发起调用的那个 agent** 临时注册一个同名工具，它的 `execute` 不碰文件系统，只把 CLI 在 `user` 帧里报回的真实结果、或终端 `result.permission_denials` 里的拒绝原因原样返回。这样卡片有了可解析的执行体（DSH 的 `normalizeDispatchResult` 要求工具能被解析出来，光返回一个值是不够的），CLI 也不会被第二次调用。注册在卡片结算后立刻撤销，否则它会漏进该 agent 后续请求的工具列表。作用域按注册表对象身份区分（WeakMap 分配 id），两个 agent 的同名卡不会互相覆盖；同一 agent 内用引用计数等待最后一张卡。执行器自身抛错只向外传播并清理，绝不会因此再调用一次 `next()`。

这个执行器**不结束这一轮**：它返回结果后 DSH 会接着跑下一步，而那一步正是 CLI 的下一条助手消息——这正是「卡片在文字之前」的来源（见上一节）。

这个执行器是**按 agent 作用域**注册的，并且只对自己上报过的 call id 生效：真实同名工具（比如 DSH 自带的 `Bash`）不会被遮蔽，`run_code`（ptc 传输工具）永远不碰。只有不认识的 call id 才原样放行给真正的执行器；凡是 CLI 已上报的调用，即使结果缺失也只显示一条防重放错误，绝不把被拒绝或结果不明的操作交给 DSH 再执行一次。

卡片摘要的坑：通用卡片取的是参数对象里**第一个字符串值**，而 CodeBuddy 自己的序列化顺序是 `{"content":"...","file_path":"..."}`——直接用会把整份文件内容当成卡片标题。所以插件在拼 `arguments` 时把 `file_path` / `command` 这类**标识性参数排到最前面**，卡片就显示路径而不是正文。

### 权限：CLI 提问，DSH 作答

CLI 和 DSH 是两个进程，各自有一套权限判断。两边必须说同一件事，否则要么 DSH 已经定下的结论被 CLI 重新打开，要么 CLI 自己替用户做了决定。所以 `--permission-mode` 不写死，而是从 DSH 已经解析出的设置推导（`permissionModeFor`）：

| DSH 沙箱 / 审批 | CLI 模式 | 理由 |
|---|---|---|
| `read-only` | `dontAsk` | CLI 在进程内直接拒绝写和命令，这正是只读的含义，没有留给人的问题 |
| `danger-full-access` + `never` | `bypassPermissions` | 用户已经明确表示不要提示、不要限制，没有可问的 |
| 其余（默认 `workspace-write` + `ask`） | `default` | 实测**唯一**会把每个受限原生工具（Write、Edit、Bash、PowerShell、REPL、MCP 包装层）交回驱动的模式 |

`auto` 刻意不可达：它是唯一在进程内用模型评审自行放行的模式，驱动根本收不到 `control_request`，DSH 用户也就永远不会被问到。这也是它以前被写死在这里却仍然有害的原因——请求一条都不会出现，看似"没问题"，实际是审批环节被整个绕过。

在 `default` 下，CLI 为每次受限调用发一条 `control_request`（`request.subtype` 为 `can_use_tool`，带 `tool_name`、`input`、`tool_use_id`）。插件把它转成 DSH 自己的审批问题：`ctx.get('approval').request({ agent, toolName, arguments, callId, reason })`，于是用户在 DSH 里看到并回答的就是同一条提示。结果一一对应：

| 审批结果 | 回应 | 后果 |
|---|---|---|
| `allowed-once` | `allowed: true` | 只放行这一次；下一次调用会重新问 |
| `rejected` | `allowed: false` + `用户拒绝了 X` | CLI 收到工具错误，模型能读到并改道；这一轮照常结束 |
| `cancelled` | `allowed: false` + `审批被取消` | 同上 |
| `unavailable` | `allowed: false` + `没有可用的审批通道` | 同上（失败关闭） |

失败关闭是硬规则：没有 `approval` 服务、没有可路由的 agent、`approval.request()` 抛错（不在开启的轮次里、审计写入失败），一律拒绝，绝不放行。旁路请求（会话标题）不是用户正在进行的那一轮，没有可问的对象，所以它的权限请求直接拒绝——标题生成绝不该弹权限提示。拒绝理由不会以 `prompt ended`、`cancelled`、`timeout waiting for user response`、`this is an unattended automated session` 开头——CLI 把这些前缀当作"提示被取消"并在 `AskUserQuestion` 的双通道竞速里丢弃回答、继续等待。`interrupt: true` 只在拒绝 `ExitPlanMode` 时发送；其余工具带上它会把整轮变成终止性失败（空回复、`is_error`），而不带它只是一次普通的工具错误。

一条 `control_request` 只被回答一次：请求 id 在作答前先登记，重复帧直接丢弃，写完即移除。**每条都必须有回答**——未回答的请求在 CLI 里不会超时，进程会一直等下去（`acceptEdits` 下等满 120 秒仍无结果就是这种表现）。所以 stdin 保持打开直到 `result` 帧到达才关闭；提前关掉会让 CLI 改为等待 EOF，白等约 40 秒。作答在帧路径之外异步进行（`void this.#answerControlRequest(frame)`），因为答案可能在等人，而这期间后续帧必须继续流向本轮。

CLI 原生工具的审批与 MCP 工具无关：MCP 调用本来就经 DSH 的工具桥走 DSH 自己的执行管线，一次原生工具的 `allowed-once` 不对下一次原生调用、也不对 MCP 调用构成任何授权。CLI 对桥接工具的提问包在 `DeferExecuteTool` 这一层里，真正的目标在 `input.toolName`（`mcp__…`）；`approvalSubjectFor` 会把这一层剥开，让提示显示用户认得的那个工具名，而不是把包装层当成被批准的对象。同名工具也一样——`Write` 被批准过不代表下一次带恶意路径的 `Write` 也被批准，每次请求都带自己的参数单独送审。

账号池的失败重试有另一条硬边界：只有尚未产生任何文本、思考或工具调用的 429/额度耗尽才允许换账号重试一次。这个标记保存在整个 CLI turn 上，而不是当前 DSH step 上；即使工具副作用发生在上一续步，后续错误也不能重放请求。取消、未知错误、已有输出的失败都只记录冷却，不自动换账号。

工具在哪个目录里跑：优先用配置里的 `cwd`；没配就用 DSH 会话自己的工作目录（通过 `workingDirectory` 服务查到），这样模型看到的文件和你在界面上看到的是同一份。

## 上下文占用：两个数字必须对齐

界面右下角那个上下文计量（点开有系统提示 / 工具 / 对话三段明细）读的是 `contextPressure` 投影：分母是模型声明的上下文窗口，分子是**最近一次请求**的提示词大小。这两边原来都是错的，症状是「明细里的数字明显不对」。

**分子重复计数。** DSH 把 `inputTokens` 理解为**未命中缓存**的那部分，然后自己用 `inputTokens + cacheReadTokens + cacheWriteTokens` 还原提示词大小。CodeBuddy 的约定正好相反：它的 `input_tokens` 已经是整个提示词，缓存命中部分已经算在里面。实测一轮 `input_tokens: 3106`、`cache_read_input_tokens: 2944`，而 `modelUsage.inputTokens` 是 `162`，也就是 `162 + 2944 === 3106`。原样透传就等于让 DSH 把缓存部分加了两遍：一个 19,435 token 的提示词被报成 37,739，占用率翻了一倍。现在 `usageOf` 会先减掉缓存份额，让 DSH 还原出来的值精确等于 CLI 自己公布的 `codebuddy.ai/contextUsed`。

**分母与传输层不一致。** `contextWindowFor` 的回退链现在刻意对齐 CLI 自己的 `resolveEffectiveContextBudget`：`overrideContextWindow` → `contextWindow.defaultLength` → `supportedLengths[0]` → `maxInputTokens`（旧清单的 `maxLength` 只作最后兼容回退）。22 个模型逐个比对，两边 22/22 一致。这里不能只认显式的 `contextWindow` 字段——`glm-5.3` 根本没声明它，实际跑在 1M 的 `maxInputTokens` 上；那样改会让三分之二的模型连计量条都不显示。分母必须和真正负责自动压缩的那一侧一致，否则 DSH 会按另一套节奏压缩。

**分子还曾被整轮累计污染。** `result` 帧的 `usage` 是这一轮**所有请求**的累加，是账单不是上下文读数。原来它在最后覆盖了逐步采样的值，一个三步的轮次于是报出 127,484 的「压力」——对应的真实提示词只有 19,435。现在 `result` 只在没有任何一步报过用量时才作为兜底（老的、不带 `--include-partial-messages` 的 CLI）。

修完后实测同一个三步轮次：`pressureTokens: 18228`，而 `180 + 18048` 正是 CLI 自报的 `contextUsed`。

## 实测行为

| 场景 | 结果 |
| --- | --- |
| 普通文本 | 正常流式输出，带用量 |
| 上下文占用 | 与 CLI 自报的 `contextUsed` 一致（见上一节） |
| 思考模型 | 思考过程与正文分开显示（两者用不同的块索引，不会被合并） |
| 思考等级 | 选择器里四档菜单；档位真的传给 CLI（实测 `deepseek-v4-pro` low 61 字符 / max 242 字符思考） |
| 读文件 / 写文件 / 跑命令 | CLI 真实执行；界面里显示成原生工具卡，可展开查看参数与结果 |
| 卡片位置 | 出现在发起它的那条消息之后、下一条消息之前（一步 = 一条 CLI 助手消息） |
| 最终答案 | 不再被折进过程组：最后一步只带文字，DSH 认得出它是答案 |
| 多个工具并行 | 每个调用单独一张卡（CLI 会复用同一个块索引，插件在下一个块开始时结算上一个） |
| 多轮 | 同一 DSH 会话内记忆连续 |
| 取消 | 约 2.5 秒内结束，标记为中断，已流出的文本保留 |
| session id 含 `:` | 映射成安全 slug 后正常执行 |
| CLI 不存在 / 路径错 | 模型选择器里不出现该分组，并给出可读原因 |
| 未知模型 | 报出 CLI 自己的错误说明 |

运行 `npm test`（或 `node test/steps.mjs`）可以离线复跑步进逻辑（268 项，用一个假 CLI 重放真实帧序列，不需要登录、不联网），其中包含"旁路请求不会抢走用户这一轮、并且有独立 session id"，权限相关的回归项（未授权的 Bash、Write 与越目录访问都被拒绝、没有审批服务时拒绝而不是放行、用户拒绝后这一轮仍以工具错误正常结束而不是挂住、批准后照常继续、`unavailable`/`cancelled`/抛错三种非授权结果都转成拒绝、同名工具的第二次请求单独送审、`--permission-mode` 随 DSH 设置推导、`DeferExecuteTool` 包装层剥成真实工具名、拒绝理由不以 CLI 的"提示已取消"前缀开头），以及保活相关的回归项：同一会话的第二条消息复用同一个进程、保活为 0 时每条消息各起一个进程、预热会保留已驻留的后端而不再起第二个；`node test/page.mjs` 复跑插件页（108 项，用一个小型渲染器把页面真的渲染一遍，数据走宿主真实 RPC，账号服务用假响应，不联网、不花额度；其中也包含"四个标签页（含账号）"、"刷新会绕过缓存重读"、"接口失败要给出原因"、"打开页面会预热后端"、"模型改动只是草稿、点保存才写盘"、"保存按钮的状态机"、"积分倍率同时出现在页面与选择器"、"未安装/未登录/过期各有对应提示与命令"、"倍率优先取 CLI 自己的模型目录、缺失时按登录站点回退清单"、"MCP 桥接的鉴权/schema 转换/工具执行/失败降级"、"图片帧形状与默认暴露 present"、"设置页三个子标签页（后端/提示词/DSH 工具）与工具勾选、提示词模式、声明开关及附着位置落盘"、"账号池的登记/冷却/当前使用展示"和"保活选项目落盘"的回归项）；运行 `node test/matrix.mjs` 可以复跑实测检查（需要已安装并登录的 CLI；活体套件的项数取决于账号与网络，不固定），它按 DSH 的方式逐步驱动并派发卡片。其中工具那组会真的读一次 `package.json`、真的写一个文件再删掉，以此确认工具确实执行了；工具卡那组会确认调用被上报成 `tool-call` 块、标识性参数排在摘要位置、执行器回放的是 CLI 的真实输出、执行完就撤销注册、并且不结束这一轮；ptc 那组会确认工具集被折叠时不发卡片、活动退回文本且该轮仍能正常结束；提示词选择那组会构造一条追加在人类消息之后的时间戳，确认选中的仍是人写的那条；思考等级那组会确认 16 个模型都给出同一份四档菜单，并真的让 `deepseek-v4-pro` 带着 `max` 跑一轮。

修补后的回归还覆盖：MCP 配置写盘失败不回退到内联 token、主/旁路进程分别清理配置；双账号下默认账号缺失仍可选池账号、冷启动与预热保持账号绑定、回退只删除本账号转录、ACP 倍率按账号隔离；仅在未产生输出或工具活动的 429 时换账号，文本或工具副作用后绝不重放；跨 agent 同名工具注册互不影响、执行器异常只派发一次；effort/cwd 改变会换进程，工具声明在新进程重新发送而保活进程不重复，匿名请求不共享转录；POSIX 登录命令转义、上下文窗口回退、积分强制刷新和整体超时，以及忽略优雅终止信号后的强制进程回收。另有真实 CLI 拒绝帧回归：只有终端 `permission_denials`、没有 `user/tool_result` 时卡片仍能显示拒绝原因；已知调用即使完全缺失结果，也只显示防重放错误，不会交给真实执行器。活体套件使用独立 DSH_HOME 和逐次测试审批，保留完整消息历史，并在 finally 中 dispose 全部适配器。

## 插件页：概览与设置

插件自带一个浏览器页面，注册在侧栏 **Plugins** 里本插件自己的详情页上（`plugins.bundle.config`，key 为包名）。页面有四个标签页：**概览**、**账号**、**模型**、**设置**。

**概览** 读的是本机真实状态，不是推测：

| 显示项 | 来源 |
| --- | --- |
| CLI 状态、版本、入口路径 | 探测 `@tencent-ai/codebuddy-code`，版本由 `--version` 得出（不花额度） |
| 登录账号：昵称、手机号、UIN、个人/企业、站点 | CLI 的登录会话文件 `%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/auth/<auth-id>.info` |
| 会话到期时间与剩余天数 | 同一文件里的 `auth.expiresAt` / `lastRefreshTime` |
| 已暴露模型数、单轮上限 | 适配器当前的模型清单与 `maxTurns` |
| 剩余积分、套餐、按来源的用量明细 | 账号服务的 `billing/meter/get-user-resource-summary`（用 CLI 自己的登录令牌） |

**积分余额** 是从 CodeBuddy 账号服务读的真实数字，不是推测。CodeBuddy 按**积分（credits）**计费，而 CLI 本身从不显示余额——它只在请求被后端拒绝时才在错误里提到积分和限流重置时间，模型清单里的 `x0.34 credits` 是单次消耗倍率、不是余额。余额来自 CLI 登录令牌本来就有权访问的账号接口：

```
POST https://<账号站点>/billing/meter/get-user-resource-summary   Authorization: Bearer <accessToken>
→ { TotalCredits, SubscriptionPackageName, IsPaidUser, CreditGroups[{Name, CycleRemainCapacity, CycleTotalCapacity, ...}] }
```

页面显示剩余积分、套餐名、已用/总量进度条，以及按来源拆分的明细（套餐基础积分 / 套餐赠送积分 / 购买积分 / 平台奖励积分——实际出现哪些取决于账号）。**令牌只在宿主进程内使用**：它从登录会话文件读出来、只发给该账号自己的站点、不会写进日志，也绝不会出现在发给浏览器的数据里。结果缓存 30 秒，点"刷新"会绕过缓存重读；账号池的强制刷新也会穿透池缓存和探测节流。池账号积分查询最多并发 4 个，并有 10 秒整体页面预算，单个账号不可达不会把整页拖到数分钟；接口不可达时页面显示原因，而不是留白或编一个数。

页面外观与 host 自带的插件页一致（同一套卡片描边/背景、`SegmentedTabs`、`Button`、`Checkbox`、`Tag` 都取自 `@deepseek-ai/dsh-client-ui-primitives`，dsh-codearts 的卡片就是参照）：

**概览** 见上表；**账号** 管理账号池（准备/登记账号、单独停用、冷却与「当前使用」展示）；**模型** 是独立的一页；**设置** 放后端保活与设置文件路径。

**模型** 页编辑的是一份**草稿**，点「保存」才写盘：

- 列出 CLI 声明的每个模型，勾选 = 出现在 DSH 的模型选择器里；被插件配置排除的模型带一个警告标签、不可勾选。
- 有改动时「保存」才可用，保存成功按钮显示"已保存"；另有「全选」。
- 保存走一次 `save-models`（整份可见清单），宿主据此重算"隐藏了哪些模型"——顺手丢掉 CLI 已经不再声明的旧 id。
- 取消勾选的模型不会从已有会话里消失：适配器仍按 id 解析模型，被过滤的只是选择器清单。
- 保存后宿主会补发一次 `llm/adapters-updated`。这一步不能省：浏览器里的模型目录是**缓存**的，只在这个事件（以及设置/凭据变更）到来时才重建；插件把自己的选择写在私有 `settings.json` 里，不广播的话选择器会一直显示旧清单，直到刷新页面。
- **积分倍率优先取 CLI 自己的模型目录**。TUI 的 `/model` 菜单、Web UI 的模型列表、以及 ACP 客户端读的是同一个 `getModelsInfo` 答案，而 ACP 是桥接插件唯一能问到的那个口：`initialize` → `session/new` 的响应里 `models.availableModels[]._meta.credits` 就是倍率。这也解释了为什么读文件永远对不上——实测 `glm-5.3` 在目录里是 **×0.69**，而 `product.json` 和 `product.ioa.json` 都写 ×0.79；`deepseek-v4.1-flash` 目录里 ×0.11、国际清单 ×0.00。
  - 探测**不花额度**（不发 prompt），用 `--acp --no-session-persistence` 启动，所以不会在 `~/.codebuddy/projects/` 留下会话文件；结果按账号 home 分别缓存 10 分钟，同一账号的并发探测共享一个进程，插件启动时预热一次，打开插件页时再顺手刷新。
  - 页面先按清单渲染，探测落地后自动重读一次，把倍率换成菜单里的数字（不需要手动刷新）。
  - 目录里没有的模型才回退到清单：先按登录站点判定部署（`*.codebuddy.cn` / `*.workbuddy.cn` / `*.tencent.com` → 国内，其余 → 国际），国内读 `product.ioa.json`、国际读 `product.json`；国内清单把多数模型记成 `glm-5.3-ioa` 这种带后缀的写法，查表时会把 `<id>-ioa` 当别名。页面底部会写明当前倍率来自"CLI 模型目录"还是"哪份清单"。
- **倍率进选择器的方式**：宿主的目录投影只保留 id/name/description/reasoning，所以倍率拼在**模型名**后面（`Deepseek-V4.1-Flash · ×0.11`），这也是 dsh-codearts 处理同类信息的方式；页面上的标签用同一个值。两边取不到倍率的模型就只显示名字。

**设置** 分成三个子标签页：

1. **后端** —— **CLI 后端保活**（关闭 / 1 / 5 / 15 / 30 分钟，即上面那节说的时长，改了立即生效：调大延长已驻留的进程，设为 0 当场关掉）和设置文件路径。
2. **提示词** —— 决定这一轮跑在什么系统提示词下，三选一：
   - **DSH 提示词**：原样用 Host 每轮发的那条 `system-prompt` 消息，换到 CodeBuddy 模型时行为规则不变；拿不到系统消息时回退到默认文本，而不是让模型裸跑。
   - **CodeBuddy 提示词**：完全不覆盖，CLI 用它自带的编码助手提示词——更像 agent，也更啰嗦。
   - **自定义**（默认）：文本框预填的就是本插件一直用的那段 chat 提示词，可改语气与规则，上限 20000 字符。

   选模式即时保存；文本框有改动时「保存」才可用，另有「恢复默认」。
3. **DSH 工具** —— 见下节。

模型清单、保活时长、提示词选择、以及桥接的工具清单都存到 `$DSH_HOME/dsh-connect-codebuddy-cli/settings.json`；模型清单记的是"隐藏了哪些模型"，所以 CLI 升级后新增的模型默认可见。

### 多模态

**输入（图片进模型）**：DSH 给支持视觉的适配器 `{type:'image', attachment}` 块；插件用 `ctx.attachments.readImageRequest(ref, {width, height, maxBytes}, signal)` 取到按请求尺寸归一化的 base64，再作为**同级内容块**塞进 CLI 的用户帧：

```json
{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
```

实测：一张写着 42 的 PNG 走完整条链路，模型答「42」（它会先把图落到 `~/.codebuddy/blobs/`，再用 `ViewImage` 去看）。几个实现上的取舍：

- 只在**新起一轮**时才读图。续步复用已经跑着的 CLI 进程，若每步都读会重复读同一张图并重复编码——这个问题实测能观察到（一次提问读了 2 次），所以读取被挪到"确实要 send"的分支里。
- 一张图读失败只丢这一张并记一条 warn，不牵连整轮。
- 上限 4 张/轮、单张 4 MiB；文本模型根本收不到这些块（DSH 已替换成占位文字），所以插件不做模态判断。图片块在发给 CLI 的文本帧里以中性的 `[图片]` 占位（字节本体在同一帧里），不再写"无法传递"——那与实际转发出去的图自相矛盾。
- 副作用：CLI 会把每张图持久化进它自己的 blob 存储。

**输出（模型产图）**：CLI 的 `stream-json` 里**没有**图片块，生成的图只以文件路径出现；DSH 的会话内容又只在**用户提交**一侧消费 image 块，assistant 侧没有渲染路径。所以输出的可行通道是把 DSH 的 `present` 工具桥给模型：模型产图后调它，这些文件就以**交付物卡片**出现在对话里。插件因此把 `present` 设为**默认暴露的工具**（`settings.json` 里还没写过 `exposedTools` 时；显式清空表示真的不要），设置页可以随时取消。

### 把 DSH 的工具给模型用（MCP 桥接）

CLI 不会自己回头调用宿主，但它**说 MCP**，而且支持按次注入配置（`--mcp-config`，stdio/sse/http）。所以插件走了一条加法路线：

```
模型 ──MCP(stdio)──> src/bridge/shim.mjs ──HTTP──> 插件内的 loopback 服务 ──> tools.execute()
```

- 插件在 **127.0.0.1 的随机端口**上起一个监听，每个请求都要一个**每进程随机 token**，所以同机其他程序驱动不了宿主工具。
- `--mcp-config` 里写的只是"用 node 跑这个 shim，并告诉它 URL/token/session"，配置是**每次 CLI 调用注入**的，不会污染用户自己的 `codebuddy mcp` 列表。注入的是**临时文件路径**而不是内联 JSON：目录在 POSIX 下为 `0700`、文件为 `0600`，每个 CLI 进程单独拥有并在关闭时清理；写盘失败直接禁用桥接，绝不回退到会把 token 暴露到 argv 的内联配置。
- `tools/list` 只返回**用户勾选的**工具（默认空），并且永远排除 `run_code`；`tools/call` 走 `tools.execute`，也就是**完整的策略与审批管线**，不是后门。
- 工具名在 CLI 那边是 `mcp__dsh__<name>`。默认只开 `present`（输出通道）：每多一个工具，每轮提示词都会更长。
- **非内置工具会带标记**：宿主的工具表不记注册者（定义就是个对象，`tools/change` 也只说"变了"），所以插件只能按「是否在 DSH 自带工具清单里」分类；清单在 `builtin-tools.js`，从本版 `@deepseek-ai/dsh-tool-*` 提取。不在清单里的标成「**非内置（插件提供）**」——意思是"不在自带清单中"，不是"已确认来自某个第三方包"，页面文案按这个措辞。

实测（headless，暴露 `todo_write`）跑通了整条链路：

```
ToolSearch → 找到 mcp__dsh__todo_write
DeferExecuteTool → DSH 实际执行 → "Updated todo list: 1 pending, 0 in progress, 0 completed."
```

一个必须注意的细节：`tools.execute` 会读 `exec.signal`，不传会在管线里报 `Cannot read properties of undefined (reading 'aborted')`——桥接因此把 HTTP 请求的关闭事件接成了 AbortSignal，客户端断开时工具也会被取消。

### 后端不可用时的提示

未安装 CLI 和未登录是两件事，修法完全不同，所以分开讲，并且**给出可以直接照抄的命令**，而不是只复述探测结果：

| 状态 | 页面提示 | 步骤 |
| --- | --- | --- |
| 没装 CLI | `没有找到 CodeBuddy CLI` | `npm install -g @tencent-ai/codebuddy-code` → 重启 DSH →（装不上的话用配置里的 `binary` 指向包内 `bin/codebuddy`） |
| 装了没登录 | `CodeBuddy CLI 已安装，但还没有登录` | 终端运行 `codebuddy` → 输入 `/login` → 回本页点「刷新」 |
| 登录过期 | `CodeBuddy 登录已过期` | 同上：重新 `/login` |

提示块在标签页上方，四个标签都看得到；模型页额外说明"修好之前这些模型跑不起来，但可以先选好并保存"。发送消息时也会在启动进程**之前**就拦下，用同一套话术报错，而不是让 CLI 跑起来几秒后回一个像网络故障的错误。预检看的是整个账号池：默认账号退出而池账号仍有效时可以继续，所有账号都不可用才失败。若环境里设了 `CODEBUDDY_AUTH_TOKEN` / `CODEBUDDY_API_KEY`，这个预检会跳过——那条路径不需要登录会话文件。

添加池账号时，页面生成的登录命令按平台区分：Windows 使用 PowerShell 环境赋值，POSIX 使用 sh 赋值并同时设置 `HOME` 与 `CODEBUDDY_CONFIG_DIR`。路径按对应 shell 的字面量规则转义，避免空格、引号或 `$` 把登录重定向到错误的账号。

页面通过一条 RPC 通道（`/codebuddy`）向宿主取数据。这条通道是**挂在 web server 上的前缀路由**，注册时 `connection.register(owner, …)` 会读 `owner.webServer`——所以必须在一个**同时注入了 `connection` 和 `webServer` 的上下文**里注册，否则会静默失败，浏览器那边表现为 `POST /codebuddy/overview → HTTP 405`（请求落到了静态路由上）。插件用 `ctx.inject(['connection','webServer'], …)` 等这两个服务就绪再注册；headless 没有 web server，该回调因此从不执行，模型路由本身不受影响。

## 已知边界

- **工具卡在 ptc 模式下会退回文字**：`ptc` 模式下 DSH 只把 `run_code` 放进请求，其余工具一律不可解析，`tools/execute` 也不会触发。这时发出去的卡片只能拿到一个不可派发的错误结果，DSH 于是再要一步，而那一步其实没有内容可给（CLI 已经答完了）。所以插件从请求里的工具清单识别出这种情况，该轮**不拆步**，退回成 `Running Read · <路径>` 这样的思考文字，答案仍正常给出。默认的 `standard` / `native` 模式不受影响。
- **单轮有步数上限**：一次 CLI 调用里模型最多思考 `maxTurns` 步（默认 200，与 CLI 自己的默认值一致）。超过时 CLI 报 `Max turns (N) exceeded`，插件把这轮判为失败并把原因显示出来。计的是模型调用次数而不是工具次数，所以同一轮里连续发多个工具调用并不昂贵，真正的成本是"等结果再决定下一步"。
- **多模态：输入能传图，输出靠交付物**。图片以 base64 内容块进 CLI（下节细说）；CLI 的输出流里没有图片块，模型产出的图落在文件里，靠 `present` 工具变成 DSH 的交付物卡片。
- **每轮都有进程启动开销**：简单一轮约 5–7 秒，其中约 3 秒是 CLI 自身的启动时间；用工具的一轮更久（实测 10–20 秒，取决于工具次数）。
- **历史存在 CLI 那边**：删掉 `~/.codebuddy/projects/` 下的会话文件，对应 DSH 会话的上下文就断了。
- **回退只重建不精确重放**：转录被删掉后，幸存历史是以文本摘要（上限见上）重建的，不是逐帧还原；很长的会话回退后，最早那部分只剩摘要。
