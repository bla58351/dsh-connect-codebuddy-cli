window.__ModuleLoader__.load({
	id: "dsh-connect-codebuddy-cli",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;
		//#region src/client/styles.ts
		/**
		* The page's stylesheet.
		*
		* The card, tab row, section headings, choice rows, and action row follow the
		* plugin pages that ship with the host — dsh-codearts' card is the reference —
		* so this page reads as part of the same family: same design tokens, same
		* paddings, same hover treatment.
		*/
		const CSS = [
			".cbc_card{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);max-width:720px}",
			".cbc_header{align-items:flex-start;gap:12px;padding:14px 16px;display:flex}",
			".cbc_headText{flex-direction:column;flex:1;gap:6px;min-width:0;display:flex}",
			".cbc_statusLine{color:var(--dsw-alias-label-primary);align-items:center;gap:6px;font-size:14px;font-weight:500;line-height:22px;display:inline-flex}",
			".cbc_meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:12px;line-height:18px}",
			".cbc_desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}",
			".cbc_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:4px 0 16px}",
			".cbc_tabs{margin-top:12px}",
			".cbc_tabPanel{padding-top:2px}",
			".cbc_section{margin-top:16px}",
			".cbc_sectionHead{justify-content:space-between;align-items:baseline;gap:12px;display:flex}",
			".cbc_sectionLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500}",
			".cbc_count{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none;font-size:12px}",
			".cbc_hint{color:var(--dsw-alias-label-secondary);margin:8px 0 0;font-size:13px;line-height:20px}",
			".cbc_error{color:var(--dsw-alias-state-error-primary);margin:10px 0 0;font-size:13px;line-height:20px}",
			".cbc_rows{flex-direction:column;gap:8px;margin-top:10px;display:flex}",
			".cbc_row{grid-template-columns:132px minmax(0,1fr);align-items:baseline;gap:10px;display:grid;line-height:1.5;font-size:13px}",
			".cbc_rowLabel{color:var(--dsw-alias-label-tertiary)}",
			".cbc_rowValue{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}",
			".cbc_mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}",
			".cbc_ok{color:var(--dsw-alias-state-business-primary)}",
			".cbc_bad{color:var(--dsw-alias-state-error-primary)}",
			".cbc_balanceRow{flex-wrap:wrap;align-items:baseline;gap:6px;display:flex}",
			".cbc_balance{color:var(--dsw-alias-label-primary);letter-spacing:-.02em;font-variant-numeric:tabular-nums;font-size:28px;font-weight:600;line-height:34px}",
			".cbc_balanceUnit{color:var(--dsw-alias-label-secondary);font-size:12px}",
			".cbc_balanceMeta{color:var(--dsw-alias-label-tertiary);margin-left:2px;font-size:12px}",
			".cbc_usageBar{background:var(--dsw-alias-border-l2);border-radius:2px;height:4px;margin-top:6px;display:block;overflow:hidden}",
			".cbc_usageFill{background:var(--dsw-alias-brand-primary);border-radius:2px;height:100%;transition:width .2s;display:block}",
			".cbc_creditRows{flex-direction:column;gap:4px;margin-top:8px;display:flex}",
			".cbc_creditRow{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;justify-content:space-between;align-items:baseline;gap:12px;font-size:12px;line-height:18px;display:flex}",
			".cbc_choices{flex-direction:column;gap:2px;margin-top:8px;display:flex}",
			".cbc_choiceRow{border-radius:var(--dsw-radius-sm);align-items:center;gap:8px;flex-wrap:wrap;margin:0 -6px;padding:5px 6px;display:flex}",
			".cbc_choiceRow:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".cbc_fieldRow{align-items:center;gap:8px;flex-wrap:wrap;display:flex;margin:0 -6px;padding:5px 6px}",
			".cbc_fieldRow .cbc_input{flex:1 1 200px;width:auto;min-width:140px;max-width:320px}",
			".cbc_fieldRow>*:not(.cbc_input){flex:none}",
			".cbc_check{flex:1;min-width:0}",
			".cbc_check>span{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}",
			".cbc_actions{flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;display:flex}",
			".cbc_buttons{flex-wrap:wrap;align-items:center;gap:8px;margin-top:10px;display:flex}",
			".cbc_notice{border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);margin-top:12px;padding:12px 14px}",
			".cbc_noticeTitle{color:var(--dsw-alias-state-warn-label);font-size:13px;font-weight:600;line-height:20px}",
			".cbc_noticeDetail{color:var(--dsw-alias-label-secondary);margin:6px 0 0;font-size:13px;line-height:20px}",
			".cbc_steps{margin:10px 0 0;padding:0;list-style:none;flex-direction:column;gap:8px;display:flex}",
			".cbc_step{color:var(--dsw-alias-label-primary);align-items:baseline;gap:8px;font-size:13px;line-height:20px;display:flex;flex-wrap:wrap}",
			".cbc_stepNo{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;width:14px}",
			".cbc_code{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:1px 6px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;overflow-wrap:anywhere}",
			".cbc_noticeNote{color:var(--dsw-alias-label-tertiary);margin:10px 0 0;font-size:12px;line-height:18px;overflow-wrap:anywhere}",
			".cbc_area{box-sizing:border-box;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;min-height:140px}",
			".cbc_area:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}",
			".cbc_input{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;max-width:320px;color:var(--dsw-alias-label-primary);padding:5px 10px;font-size:12px;line-height:18px}",
			".cbc_input:focus{border-color:var(--dsw-alias-state-business-primary);outline:none}",
			".cbc_input::placeholder{color:var(--dsw-alias-label-tertiary)}",
			".cbc_codeblock{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;color:var(--dsw-alias-label-primary);padding:8px 10px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px;line-height:18px;margin:4px 0;white-space:pre-wrap;word-break:break-all}",
			".cbc_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;display:block;margin-top:10px}",
			".cbc_charCount{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;font-size:11px;text-align:right;display:block;margin-top:4px}"
		].join("")
		const tagId = "dsh-connect-codebuddy-cli/page.css"
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style")
			tag.dataset.plugin = "dsh-connect-codebuddy-cli"
			tag.dataset.pluginCss = tagId
			tag.textContent = CSS
			document.head.appendChild(tag)
		}
		//#endregion
		//#region src/client/copy.ts
		/** Whether the browser prefers Chinese, used only for the page's own copy. */
		const chinese = typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language)
		/**
		* Pick one of two strings. The page ships both languages inline because the
		* Plugins page does not hand a registering plugin a dictionary binding.
		* @param zh - the Chinese text.
		* @param en - the English text.
		* @returns the text for the browser's language.
		*/
		const pick = (zh, en) => chinese ? zh : en
		//#endregion
		//#region src/client/format.ts
		/**
		* Format a millisecond timestamp.
		* @param at - epoch milliseconds, or `0` when unknown.
		* @returns a localized timestamp, or a dash.
		*/
		function formatTime(at) {
			if (typeof at !== "number" || at <= 0) return "—"
			try {
				return new Date(at).toLocaleString(chinese ? "zh-CN" : "en-US", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
			} catch {
				return new Date(at).toISOString()
			}
		}
		/**
		* Whole days left before a timestamp.
		* @param at - epoch milliseconds, or `0` when unknown.
		* @returns a short phrase, or an empty string.
		*/
		function daysLeft(at) {
			if (typeof at !== "number" || at <= 0) return ""
			const days = Math.ceil((at - Date.now()) / 86400000)
			if (days <= 0) return pick("已过期", "expired")
			return pick(`还有 ${days} 天`, `${days} days left`)
		}
		/**
		* Format a credit amount with grouping and at most two decimals.
		* @param value - the amount.
		* @returns the display text.
		*/
		function formatCredits(value) {
			const number = typeof value === "number" && Number.isFinite(value) ? value : 0
			return (Math.round(number * 100) / 100).toLocaleString(chinese ? "zh-CN" : "en-US", { maximumFractionDigits: 2 })
		}
		/**
		* Format the keep-alive delay.
		* @param seconds - the delay.
		* @returns the phrase shown next to the controls.
		*/
		function formatDelay(seconds) {
			if (!(seconds > 0)) return pick("不保活", "no keep-alive")
			if (seconds % 60 === 0) return pick(`保活 ${seconds / 60} 分钟`, `${seconds / 60} min keep-alive`)
			return pick(`保活 ${seconds} 秒`, `${seconds}s keep-alive`)
		}
		//#endregion
		//#region src/client/components.tsx
		/** Tab element id for one tab value. */
		const tabId = (value) => `cbc-tab-${value}`
		/** Panel element id for one tab value. */
		const panelId = (value) => `cbc-panel-${value}`
		/**
		* Explain what is missing before any CodeBuddy model can answer.
		*
		* A plugin whose backend is absent has exactly one useful thing to say: the
		* next step. The raw probe reason ("no CLI found") tells a user what the
		* plugin saw, not what to do about it, so the notice carries numbered steps
		* with the literal commands, and keeps the probe's own words as a footnote
		* for the case where they differ.
		* @param props - the readiness record from the host.
		* @returns the rendered notice.
		*/
		function ReadinessNotice({ readiness }) {
			if (readiness === undefined || readiness.ready !== false) return null
			return h("div", { className: "cbc_notice", role: "status" },
				h("div", { className: "cbc_noticeTitle" }, readiness.title),
				readiness.detail === "" ? null : h("p", { className: "cbc_noticeDetail" }, readiness.detail),
				(readiness.steps ?? []).length === 0 ? null : h("ol", { className: "cbc_steps" },
					(readiness.steps ?? []).map((step, at) => h("li", { key: step.label + at, className: "cbc_step" },
						h("span", { className: "cbc_stepNo" }, `${at + 1}.`),
						h("span", null, step.label),
						step.command === "" ? null : h("code", { className: "cbc_code" }, step.command)
					))
				),
				readiness.note === "" ? null : h("p", { className: "cbc_noticeNote" }, readiness.note)
			)
		}
		/**
		* One tab's panel. Hidden panels stay mounted so a draft survives a switch.
		* @param props - panel identity and content.
		* @returns the rendered panel.
		*/
		function TabPanel({ id, labelledBy, active, children }) {
			return h("div", {
				role: "tabpanel",
				id,
				"aria-labelledby": labelledBy,
				hidden: !active,
				tabIndex: 0,
				className: "cbc_tabPanel"
			}, children)
		}
		/**
		* One label/value row.
		* @param props - label, value, and value styling.
		* @returns the rendered row.
		*/
		function Row({ label, value, mono, className }) {
			const style = [mono === true ? "cbc_mono" : "", className ?? ""].filter(part => part !== "").join(" ")
			return h("div", { className: "cbc_row" },
				h("div", { className: "cbc_rowLabel" }, label),
				h("div", { className: style === "" ? "cbc_rowValue" : `cbc_rowValue ${style}` }, value)
			)
		}
		/**
		* One titled section.
		* @param props - title, optional trailing count, and content.
		* @returns the rendered section.
		*/
		function Section({ title, count, children }) {
			return h("section", { className: "cbc_section" },
				h("div", { className: "cbc_sectionHead" },
					h("span", { className: "cbc_sectionLabel" }, title),
					count === undefined ? null : h("span", { className: "cbc_count" }, count)
				),
				children
			)
		}
		/**
		* The credit balance and its per-source breakdown.
		* @param props - the credit summary, or the reason it could not be read.
		* @returns the rendered block.
		*/
		function CreditsBlock({ credits }) {
			if (credits === undefined || credits.available !== true) {
				return h("p", { className: "cbc_hint" },
					credits?.reason ?? pick("积分读取失败。", "Credits could not be read."),
					" ",
					pick("可到 CodeBuddy 控制台的用量页面查看。", "Check the usage page in the CodeBuddy console.")
				)
			}
			const granted = credits.granted > 0 ? credits.granted : credits.total + credits.used
			const ratio = granted > 0 ? Math.min(1, Math.max(0, credits.used / granted)) : 0
			return h("div", null,
				h("div", { className: "cbc_balanceRow", style: { marginTop: "10px" } },
					h("span", { className: "cbc_balance" }, formatCredits(credits.total)),
					h("span", { className: "cbc_balanceUnit" }, pick("积分可用", "credits left")),
					credits.plan === "" ? null : h("span", { className: "cbc_balanceMeta" }, credits.plan),
					h("span", { className: "cbc_balanceMeta" }, credits.paid === true ? pick("付费", "paid") : pick("免费", "free"))
				),
				h("span", { className: "cbc_usageBar" },
					h("span", { className: "cbc_usageFill", style: { width: `${Math.round(ratio * 100)}%` } })
				),
				h("div", { className: "cbc_creditRows" },
					h("div", { className: "cbc_creditRow" },
						h("span", null, pick("已用 / 累计发放", "used / granted")),
						h("span", null, `${formatCredits(credits.used)} / ${formatCredits(granted)}`)
					),
					(credits.groups ?? []).map(group => h("div", { key: group.kind + group.name, className: "cbc_creditRow" },
						h("span", null, group.name),
						h("span", null, `${formatCredits(group.remain)} / ${formatCredits(group.total)}`)
					))
				)
			)
		}
		/**
		* The 概览 panel: what the CLI is, who is signed in, how many credits are left,
		* and whether a backend process is warm.
		* @param props - the loaded overview plus its refresh state.
		* @returns the rendered panel.
		*/
		function OverviewPanel({ data, busy, onRefresh, warming }) {
			const cli = data?.cli ?? {}
			const account = data?.account ?? { signedIn: false }
			const accountDetail = account.account
			const backend = data?.backend
			const models = data?.models
			return h("div", null,
				h(Section, { title: pick("CodeBuddy CLI", "CodeBuddy CLI") },
					h("div", { className: "cbc_rows" },
						h(Row, {
							label: pick("状态", "Status"),
							value: cli.installed === true ? pick("已安装", "Installed") : (cli.reason ?? pick("未找到", "Not found")),
							className: cli.installed === true ? "cbc_ok" : "cbc_bad"
						}),
						h(Row, { label: pick("版本", "Version"), value: cli.version || "—", mono: true }),
						h(Row, { label: pick("入口", "Entry"), value: cli.entry || "—", mono: true })
					)
				),
				h(Section, { title: pick("登录账号", "Signed-in account") },
					account.signedIn === true
						? h("div", { className: "cbc_rows" },
							h(Row, { label: pick("昵称", "Nickname"), value: accountDetail.nickname || "—" }),
							h(Row, { label: pick("手机号", "Phone"), value: accountDetail.phone || "—", mono: true }),
							h(Row, { label: "UIN", value: accountDetail.uin || "—", mono: true }),
							h(Row, {
								label: pick("类型", "Type"),
								value: accountDetail.enterprise === true
									? pick("企业", "Enterprise")
									: (accountDetail.kind === "personal" ? pick("个人", "Personal") : (accountDetail.kind || "—"))
							}),
							h(Row, { label: pick("站点", "Site"), value: accountDetail.domain || "—", mono: true }),
							h(Row, {
								label: pick("会话到期", "Session expires"),
								value: `${formatTime(accountDetail.expiresAt)} · ${daysLeft(accountDetail.expiresAt)}`,
								className: accountDetail.expired === true ? "cbc_bad" : undefined
							})
						)
						: h("p", { className: "cbc_error" }, account.reason ?? pick("未登录", "Not signed in"))
				),
				h(Section, { title: pick("积分余额", "Credit balance") }, h(CreditsBlock, { credits: data?.credits })),
				h(Section, { title: pick("CLI 后端", "CLI backend") },
					h("div", { className: "cbc_rows" },
						h(Row, {
							label: pick("状态", "Status"),
							value: warming === true
								? pick("正在启动…", "starting…")
								: (backend?.parked ?? 0) > 0
									? pick(`正在运行（${backend.parked} 个进程）`, `running (${backend.parked} process${backend.parked === 1 ? "" : "es"})`)
									: pick("未运行", "not running"),
							className: (backend?.parked ?? 0) > 0 ? "cbc_ok" : undefined
						}),
						h(Row, { label: pick("保活时长", "Keep-alive"), value: formatDelay(backend?.keepAliveSeconds ?? 0) }),
						h(Row, { label: pick("模型", "Models"), value: `${models?.visible ?? 0} / ${models?.advertised ?? 0}` })
					),
					h("p", { className: "cbc_hint" },
						pick(
							"每条消息跑完后进程会按保活时长保留，期间同一会话再发消息直接复用；打开本页会启动一次后端。",
							"After each message the process stays warm for the delay above, and the next message in the same conversation reuses it. Opening this page starts it once."
						)
					)
				),
				h("div", { className: "cbc_actions" },
					h(primitives.Button, { variant: "outline", size: "sm", disabled: busy === true, onClick: () => onRefresh(true) }, pick("刷新", "Refresh"))
				)
			)
		}
		/**
		* The 模型 panel: a draft of which models the picker offers, saved on demand.
		*
		* Editing a draft instead of writing each switch is what makes a save button
		* meaningful — the picker is rewritten once, and an accidental click is undone
		* by leaving the page without saving.
		* @param props - the model rows, the draft, and the save handlers.
		* @returns the rendered panel.
		*/
		function ModelsPanel({ data, draft, onToggle, onSelectAll, onSave, saving, dirty, saved, error, busy }) {
			const rows = data?.models?.rows ?? []
			const selectable = rows.filter(row => row.blocked !== true).map(row => row.id)
			const allSelected = selectable.length > 0 && selectable.every(id => draft.includes(id))
			const notReady = data?.readiness !== undefined && data.readiness.ready === false
			return h(Section, {
				title: pick("模型", "Models"),
				count: `${draft.length} / ${rows.length}`
			},
				h("p", { className: "cbc_hint" },
					pick(
						"勾选要出现在 DSH 模型选择器里的模型，改完点「保存」。取消勾选的模型不会从已有会话里消失。倍率是每次调用消耗的积分倍数，选择器里的模型名后面也会带上它。",
						"Tick the models DSH should offer, then press Save. Unticking one does not remove it from a conversation already using it. The multiplier is the credits one call consumes, and it also appears after the model name in the selector."
					)
				),
				notReady
					? h("p", { className: "cbc_noticeNote" },
						pick(
							"上面的问题修好之前这些模型还跑不起来；现在也可以先选好，改完照样能保存。",
							"These models cannot run until the problem above is fixed. You can still pick now and save; the choice is kept either way."
						)
					)
					: null,
				rows.length === 0
					? h("p", { className: "cbc_hint" }, pick("CLI 没有声明任何模型。", "The CLI advertises no models."))
					: h("div", { className: "cbc_choices" }, rows.map(row => h("div", { key: row.id, className: "cbc_choiceRow" },
						h(primitives.Checkbox, {
							className: "cbc_check",
							checked: draft.includes(row.id),
							disabled: row.blocked === true || saving === true || busy === true,
							onChange: (on) => onToggle(row.id, on),
							label: row.id
						}),
						row.blocked === true
							? h(primitives.Tag, { tone: "warning" }, pick("被插件配置排除", "excluded by plugin config"))
							: null,
						// The billing multiplier the model carries, straight from the
						// product manifest — the same figure the selector shows in the
						// model name.
						row.credits === undefined || row.credits === ""
							? null
							: h(primitives.Tag, { tone: "quiet" }, row.credits)
					))),
				rows.length === 0 ? null : h("div", { className: "cbc_actions" },
					h(primitives.Button, {
						variant: "outline",
						size: "sm",
						disabled: saving === true || allSelected,
						onClick: onSelectAll
					}, pick("全选", "Select all")),
					h(primitives.Button, {
						variant: "primary",
						size: "sm",
						disabled: !dirty || saving === true,
						onClick: onSave
					}, saving === true ? pick("正在保存…", "Saving…") : saved && !dirty ? pick("已保存", "Saved") : pick("保存", "Save"))
				),
				DeploymentNote({ deployment: data?.models?.deployment, catalog: data?.models?.catalog }),
				error === "" ? null : h("p", { className: "cbc_error" }, error)
			)
		}
/**
		* The 提示词 page: which system prompt the CLI runs behind.
		*
		* Three sources that genuinely differ — the Host's own rules, the CLI's
		* coding-agent brief, or text stored here — so the page states what each one
		* means rather than offering three unlabeled radio buttons.
		* @param props - the prompt state, the draft, and the handlers.
		* @returns the rendered panel.
		*/
		function PromptPanel({ prompt, draft, onMode, onText, onSave, saving, dirty, saved, error, declareTools, onDeclareTools, declaringSaving, declarationPlacement, onDeclarationPlacement }) {
			const mode = prompt?.mode ?? "custom"
			const modes = [
				{ id: "dsh", label: pick("DSH 提示词", "DSH prompt"), hint: pick("沿用 DSH 每轮发给模型的那份系统提示词，切换模型时规则保持一致。", "Reuse the system prompt DSH sends with every step, so the rules stay the same when you switch models.") },
				{ id: "codebuddy", label: pick("CodeBuddy 提示词", "CodeBuddy prompt"), hint: pick("不覆盖，直接用 CLI 自带的编码助手提示词：更贴近它原本的工作方式，也更啰嗦。", "No override: the CLI uses its own coding-agent prompt, which suits its native behaviour but reads more like an agent than a chat.") },
				{ id: "custom", label: pick("自定义", "Custom"), hint: pick("下面这段就是默认值（本插件原来一直在用的那段），可以改成你要的语气和规则。", "The box below starts from the text this bridge has always used; edit it to change tone or rules.") },
			]
			const declared = prompt?.declaredTools
			return h("div", null,
				h(Section, { title: pick("系统提示词", "System prompt") },
					modes.map(choice => h("div", { key: choice.id, className: "cbc_choiceRow", style: { alignItems: "flex-start", flexDirection: "column", gap: "2px" } },
						h(primitives.Button, {
							variant: mode === choice.id ? "primary" : "outline",
							size: "sm",
							disabled: saving === true,
							onClick: () => onMode(choice.id)
						}, choice.label),
						h("p", { className: "cbc_hint", style: { marginTop: "4px" } }, choice.hint)
					)),
					mode !== "custom"
						? h("p", { className: "cbc_noticeNote" }, pick("选择「自定义」才能编辑下面的文本。", "Choose Custom to edit the text below."))
						: h("div", null,
							h("label", { className: "cbc_fieldLabel" },
								pick("自定义提示词（发给 CLI 作为系统提示词）", "Custom prompt (sent to the CLI as its system prompt)")
							),
							h("textarea", {
								className: "cbc_area",
								value: draft,
								spellCheck: false,
								rows: 8,
								onChange: (event) => onText(event.target.value)
							}),
							h("span", { className: "cbc_charCount" }, `${draft.length} / ${prompt?.maxChars ?? 0}`)
						),
					h("div", { className: "cbc_choiceRow", style: { alignItems: "flex-start", flexDirection: "column", gap: "2px", marginTop: "8px" } },
						h("label", { className: "cbc_fieldLabel" },
							pick("在提示词中声明桥接工具", "Declare bridged tools in the prompt")
						),
						h("div", { className: "cbc_choiceRow" },
							h(primitives.Switch, {
								checked: declareTools !== false,
								disabled: declaringSaving === true || mode === "codebuddy",
								onChange: (checked) => onDeclareTools(checked === true)
							}),
							h("span", { className: "cbc_hint" },
								mode === "codebuddy" && declarationPlacement !== "first-user"
									? pick("CodeBuddy 模式不传提示词文件，此声明不会生效——除非把附着位置改为「首条用户消息」。", "The CodeBuddy mode sends no prompt file, so this declaration never applies — unless the placement below is set to first message.")
									: pick("开启后，勾选的 DSH 工具会以一段清单随声明位置发给模型，模型不必先 ToolSearch 也能知道它们存在。", "When on, the bridged DSH tools are sent as a list at the chosen position, so the model knows they exist without a ToolSearch first.")
							)
						),
						declareTools !== false
							? h("div", { className: "cbc_choiceRow", style: { flexDirection: "column", alignItems: "flex-start", gap: "2px", marginTop: "8px" } },
								h("label", { className: "cbc_fieldLabel" }, pick("声明附着位置", "Declaration placement")),
								h("div", { className: "cbc_choiceRow" },
									h(primitives.Button, {
										variant: declarationPlacement !== "first-user" ? "primary" : "outline",
										size: "sm",
										disabled: declaringSaving === true,
										onClick: () => onDeclarationPlacement("system")
									}, pick("系统提示词末尾", "End of system prompt")),
									h(primitives.Button, {
										variant: declarationPlacement === "first-user" ? "primary" : "outline",
										size: "sm",
										disabled: declaringSaving === true,
										onClick: () => onDeclarationPlacement("first-user")
									}, pick("首条用户消息之前", "Before the first user message"))
								),
								h("span", { className: "cbc_hint" },
									declarationPlacement === "first-user"
										? pick("声明随会话第一条消息发出（每个 CLI 进程一次），CodeBuddy 提示词模式下也能生效。", "The declaration rides with the conversation's first message (once per CLI process); it also works in the CodeBuddy-prompt mode.")
										: pick("声明追加在系统提示词末尾（默认）。", "The declaration is appended to the system prompt (default).")
								)
							)
							: null,
						declareTools !== false && Array.isArray(declared) && declared.length > 0
							? h("pre", { className: "cbc_codeblock", style: { margin: "4px 0 0" } },
								declared.map(line => `- ${line}`).join("\n"))
							: declareTools !== false
								? h("p", { className: "cbc_hint", style: { margin: "4px 0 0" } },
									pick("当前没有勾选任何工具（或暂无会话可读取描述），声明段为空。", "No tools are enabled (or no session is available to read descriptions), so the declaration block is empty."))
								: null
					),
					h("div", { className: "cbc_actions" },
						h(primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: dirty !== true || saving === true || mode !== "custom",
							onClick: onSave
						}, saving === true ? pick("正在保存…", "Saving…") : saved && !dirty ? pick("已保存", "Saved") : pick("保存", "Save")),
						h(primitives.Button, {
							variant: "outline",
							size: "sm",
							disabled: saving === true || draft === (prompt?.defaultPrompt ?? ""),
							onClick: () => onText(prompt?.defaultPrompt ?? "")
						}, pick("恢复默认", "Reset to default"))
					),
					error === "" ? null : h("p", { className: "cbc_error" }, error)
				)
			)
		}
		/**
		* Say where the displayed multipliers came from.
		*
		* The live catalog the CLI's own `/model` menu renders is the preferred
		* source, and its numbers differ from every bundled manifest (glm-5.3 is
		* ×0.69 there, ×0.79 in the files). When the probe has not landed, the
		* deployment's manifest is the fallback and the note says so.
		* @param props - the deployment and the catalog status.
		* @returns the rendered note, or null when nothing was resolved.
		*/
		function DeploymentNote({ deployment, catalog }) {
			if (catalog !== undefined && catalog.source === "catalog") {
				const count = catalog.models ?? 0
				return h("p", { className: "cbc_noticeNote" },
					pick(
						`倍率取自 CLI 自己的模型目录（与 /model 菜单同源，共 ${count} 个模型）；目录里没有的模型回退${deployment?.label ?? ""}产品清单。`,
						`Multipliers come from the CLI's own model catalog (the /model menu's source, ${count} models); models missing there fall back to the ${deployment?.label ?? ""} manifest.`
					)
				)
			}
			if (deployment === undefined || deployment.name === undefined) return null
			const domestic = deployment.name === "domestic"
			return h("p", { className: "cbc_noticeNote" },
				pick(
					`倍率取自${domestic ? "国内" : "国际"}产品清单（${deployment.manifest}），按登录站点 ${deployment.domain || "未知"} 判定。`,
					`Multipliers come from the ${domestic ? "domestic" : "international"} manifest (${deployment.manifest}), chosen from the sign-in site ${deployment.domain || "unknown"}.`
				)
			)
		}
/**
		* The 设置 tab: three pages — backend behaviour, the system prompt, and the DSH
		* tools the CLI may call.
		*
		* Sub-tabs rather than one long form because the pages answer unrelated questions:
		* how long the process lives, what rules the model runs under, and whether it may
		* reach the Host's tools at all.
		* @param props - settings state, the tool draft, and the handlers.
		* @returns the rendered panel.
		*/
		function SettingsPanel({ data, busy, onKeepAlive, subTab, onSubTab, toolDraft, onToggleTool, onSaveTools, savingTools, toolsDirty, toolsSaved, toolError, prompt, promptDraft, onMode, onText, onSavePrompt, savingPrompt, promptDirty, promptSaved, promptError, onDeclareTools, onDeclarationPlacement }) {
			const keepAlive = data?.backend?.keepAliveSeconds ?? 0
			const presets = [0, 60, 300, 900, 1800]
			const tools = data?.tools
			const available = tools?.available ?? []
			const subButton = (id, label) => h(primitives.Button, {
				key: id,
				variant: subTab === id ? "primary" : "outline",
				size: "sm",
				onClick: () => onSubTab(id)
			}, label)
			return h("div", null,
				h("div", { className: "cbc_buttons", style: { marginTop: "12px" } },
					subButton("backend", pick("后端", "Backend")),
					subButton("prompt", pick("提示词", "Prompt")),
					subButton("tools", pick("DSH 工具", "DSH tools"))
				),
				subTab === "prompt"
					? h(PromptPanel, { prompt, draft: promptDraft, onMode, onText, onSave: onSavePrompt, saving: savingPrompt, dirty: promptDirty, saved: promptSaved, error: promptError, declareTools: data?.prompt?.declareTools !== false, onDeclareTools, declaringSaving: savingPrompt, declarationPlacement: data?.prompt?.declarationPlacement ?? "system", onDeclarationPlacement })
					: subTab === "tools"
					? h("div", null,
						h(Section, { title: pick("桥接给模型的 DSH 工具", "DSH tools for the model"), count: `${toolDraft.length} / ${available.length}` },
							h("p", { className: "cbc_hint" },
								pick(
									"勾选的工具会通过 MCP 暴露给 CodeBuddy 模型，由 DSH 实际执行——也就是说模型能用上 DSH 这边的插件工具。每多一个工具，每轮提示词都会更长。勾上 `present` 后，模型产出的图片/文件会以交付物卡片出现在对话里，这是目前让「输出」变成多模态的唯一通道。带「非内置（插件提供）」标记的工具不在 DSH 自带的工具清单里，通常由你安装的第三方插件注册——挂上它之前先确认那个插件可信。",
									"Ticked tools are exposed to CodeBuddy models over MCP and executed by DSH, so the model can use this Host's plugin tools. Every tool makes every prompt longer. Enabling `present` is what turns model-produced files — images included — into deliverable cards, which is currently the only multimodal output path. A tool marked “not built in” is not part of DSH's own catalog — it usually comes from a third-party plugin you installed, so check that plugin before exposing it."
								)
							),
							tools === undefined || tools.bridge !== true
								? h("p", { className: "cbc_noticeNote" }, pick("工具桥还没启动（宿主缺少 tools/agents 服务）。", "The tool bridge is not running (the Host has no tools/agents services)."))
								: null,
							tools?.note === "no-session"
								? h("p", { className: "cbc_noticeNote" }, pick("还没有运行中的会话，列表取自最近一次会话；先用 CodeBuddy 模型聊一轮再看这里。", "No live session yet — the list comes from the most recent one. Use a CodeBuddy model once, then come back."))
								: null,
							available.length === 0
								? h("p", { className: "cbc_hint" }, pick("没有可桥接的工具。", "No tool is available to bridge."))
								: h("div", { className: "cbc_choices" }, available.map(tool => h("div", { key: tool.name, className: "cbc_choiceRow" },
									h(primitives.Checkbox, {
										className: "cbc_check",
										checked: toolDraft.includes(tool.name),
										disabled: savingTools === true || busy === true,
										onChange: (on) => onToggleTool(tool.name, on),
										label: tool.name
									}),
									tool.overlap === true
										? h(primitives.Tag, { tone: "quiet" }, pick("CLI 也有同名工具", "CLI has one too"))
										: null,
									// The Host keeps no per-tool provenance, so this tag is
									// "not in the shipped catalog" rather than proof of a
									// third-party package — see builtin-tools.js.
									tool.origin === "external"
										? h(primitives.Tag, { tone: "warning" }, pick("非内置（插件提供）", "not built in"))
										: null
								))),
							available.length === 0 ? null : h("div", { className: "cbc_actions" },
								h(primitives.Button, {
									variant: "primary",
									size: "sm",
									disabled: !toolsDirty || savingTools === true,
									onClick: onSaveTools
								}, savingTools === true ? pick("正在保存…", "Saving…") : toolsSaved && !toolsDirty ? pick("已保存", "Saved") : pick("保存", "Save"))
							),
							toolError === "" ? null : h("p", { className: "cbc_error" }, toolError)
						)
					)
					: h("div", null,
						h(Section, { title: pick("CLI 后端保活", "CLI keep-alive"), count: formatDelay(keepAlive) },
							h("p", { className: "cbc_hint" },
								pick(
									"每条消息跑完后，CLI 进程按这个时长继续保留；期间在同一会话里再发消息会直接复用这个进程，省掉一次启动。设为 0 表示跑完就关。",
									"After each message the CLI process stays warm for this long. A follow-up message in the same conversation reuses it instead of starting a new one. Zero closes it as soon as the message finishes."
								)
							),
							h("div", { className: "cbc_buttons" },
								presets.map(seconds => h(primitives.Button, {
									key: seconds,
									variant: keepAlive === seconds ? "primary" : "outline",
									size: "sm",
									disabled: busy === true,
									onClick: () => onKeepAlive(seconds)
								}, seconds === 0 ? pick("关闭", "Off") : `${seconds / 60} ${pick("分钟", "min")}`))
							)
						),
						h(Section, { title: pick("设置文件", "Settings file") },
							h("div", { className: "cbc_rows" },
								h(Row, { label: pick("路径", "Path"), value: data?.settingsPath ?? "—", mono: true })
							)
						)
					)
			)
		}
		//#endregion
		//#region src/client/page.tsx
		/**
		* The 账号 tab: the account pool, one row per login, plus the flow for
		* adding another one.
		*
		* Adding an account is a two-step dance the page can only half-automate:
		* the plugin prepares an isolated home directory and hands back a terminal
		* command, the user runs it and signs in inside that terminal, then presses
		* 保存 to register the row. The plugin never sees or stores the token —
		* the login session stays in the account's own home, read only by the CLI
		* it belongs to.
		* @param props - the pool state, reload callback, and the prepare flow.
		* @returns the rendered panel.
		*/
		function AccountsPanel({ pool, onReload, busy, onError, prepareState, onPrepare, onSaveCurrent }) {
			const rows = pool?.accounts ?? []
			const current = rows.find(row => row.current === true)
			const [currentLabelDraft, setCurrentLabelDraft] = react.useState("")
			const [labelDraft, setLabelDraft] = react.useState("")
			const prepared = prepareState?.value
			return h("div", null,
				h(Section, { title: pick("账号池", "Account pool"), count: `${rows.length}` },
					h("p", { className: "cbc_hint" },
						pick(
							"多个账号轮着用：一个遇到限流（429）或积分用完，下一条消息自动换下一个继续，原账号冷却一段时间后自动归队。默认账号就是你本机 CLI 已登录的那个。添加流程：点「准备新账号」→ 复制命令到终端运行并登录 → 回来点「登记此账号」。",
							"Accounts rotate automatically: when one hits a rate limit (429) or runs out of credits, the next message continues on another account, and the cooled-down one re-enters the pool later. The default account is your CLI's own login. To add one: prepare, run the command in a terminal and sign in, then register it."
						)
					),
					h("div", { className: "cbc_choiceRow", style: { marginBottom: "6px" } },
						h("span", { className: "cbc_fieldLabel" }, pick("当前使用：", "Currently serving:")),
						current === undefined
							? h("span", { className: "cbc_hint" }, pick("暂无（还没有消息走过任何账号）", "none yet (no message has used an account)"))
							: h("span", null,
								h("strong", null, current.label || current.id),
								current.credits?.available === true ? h("span", { className: "cbc_hint" }, pick(`　积分 ${current.credits.total}`, `　credits ${current.credits.total}`)) : null
							)
					),
					rows.length === 0
						? h("p", { className: "cbc_hint" }, pick("只有默认账号。", "Only the default account."))
						: h("div", { className: "cbc_choices" }, rows.map(row => h("div", { key: row.id, className: "cbc_choiceRow", style: { flexDirection: "column", alignItems: "flex-start", gap: "2px" } },
							h("div", { className: "cbc_choiceRow" },
								h("strong", null, row.label || row.id),
								row.isDefault === true ? h(primitives.Tag, { tone: "quiet" }, pick("默认", "default")) : null,
								row.current === true ? h(primitives.Tag, { tone: "quiet" }, pick("当前", "current")) : null,
								row.enabled === false ? h(primitives.Tag, { tone: "warning" }, pick("已停用", "disabled")) : null,
								row.reason !== ""
									? h(primitives.Tag, { tone: "warning" }, pick(`冷却中：${row.reason}`, `cooling down: ${row.reason}`))
									: row.signedIn === true
										? h(primitives.Tag, { tone: "quiet" }, pick("可用", "usable"))
										: h(primitives.Tag, { tone: "warning" }, pick("未登录", "not signed in"))
							),
							h("span", { className: "cbc_hint" },
								[
									row.nickname !== "" ? row.nickname : null,
									row.domain !== "" ? row.domain : null,
									row.deployment === "domestic" ? pick("国内", "domestic") : pick("国际", "international"),
									row.credits?.available === true ? pick(`积分 ${row.credits.total}`, `credits ${row.credits.total}`) : null,
								].filter(part => part !== null && part !== "").join(" · ")
							)
						)))
				),
				h(Section, { title: pick("保存当前账号", "Save the current account") },
					h("p", { className: "cbc_hint" },
						pick(
							"把 CLI 当前登录的账号也登记进池（不复制任何数据，两个条目共享同一次登录）。登记后它可以单独停用；默认账号条目始终保留。",
							"Register the CLI's own login as a pool row too (nothing is copied — both entries share one sign-in). Once registered it can be disabled on its own; the default entry always remains."
						)
					),
					h("div", { className: "cbc_fieldRow" },
						h("input", {
							className: "cbc_input",
							value: currentLabelDraft,
							placeholder: pick("给它起个名字（可选）", "name it (optional)"),
							onChange: (event) => setCurrentLabelDraft(event.target.value)
						}),
						h(primitives.Button, {
							variant: "primary",
							size: "sm",
							disabled: busy === true,
							onClick: () => onSaveCurrent(currentLabelDraft)
						}, pick("保存当前账号", "Save current account"))
					)
				),
				h(Section, { title: pick("添加账号", "Add an account") },
					prepared === undefined
						? h("div", null,
							h(primitives.Button, {
								variant: "primary",
								size: "sm",
								disabled: busy === true || prepareState?.busy === true,
								onClick: onPrepare
							}, prepareState?.busy === true ? pick("正在准备…", "Preparing…") : pick("准备新账号", "Prepare a new account"))
						)
						: h("div", null,
							h("label", { className: "cbc_fieldLabel" }, pick("1. 在终端里运行这条命令并完成登录", "1. Run this command in a terminal and sign in")),
							h("pre", { className: "cbc_codeblock" }, prepared.command),
							h("label", { className: "cbc_fieldLabel" }, pick("2. 登录完成后给这个账号起个名字（可选），然后登记", "2. Once signed in, name it (optional) and register")),
							h("div", { className: "cbc_fieldRow" },
								h("input", {
									className: "cbc_input",
									value: labelDraft,
									placeholder: pick("例如：国际版小号", "e.g. international spare"),
									onChange: (event) => setLabelDraft(event.target.value)
								}),
								h(primitives.Button, {
									variant: "primary",
									size: "sm",
									disabled: busy === true,
									onClick: () => onPrepare("register", labelDraft)
								}, pick("登记此账号", "Register account")),
								h(primitives.Button, {
									variant: "outline",
									size: "sm",
									disabled: busy === true,
									onClick: () => { setLabelDraft(""); onError(""); onPrepare("reset") }
								}, pick("放弃", "Discard"))
							),
							h("p", { className: "cbc_hint" }, pick("家目录：", "Home directory: "), prepared.home)
						)
				)
			)
		}
		function PluginPage() {
			const [tab, setTab] = react.useState("overview")
			const [data, setData] = react.useState(undefined)
			const [error, setError] = react.useState("")
			const [busy, setBusy] = react.useState(false)
			const [warming, setWarming] = react.useState(false)
			const [draft, setDraft] = react.useState(undefined)
			const [savedDraft, setSavedDraft] = react.useState(undefined)
			const [saving, setSaving] = react.useState(false)
			const [savedFlag, setSavedFlag] = react.useState(false)
			const [modelError, setModelError] = react.useState("")
			/** Which page of the settings tab is showing. */
			const [settingsSubTab, setSettingsSubTab] = react.useState("backend")
			const [toolDraft, setToolDraft] = react.useState(undefined)
			const [toolSaved, setToolSaved] = react.useState(undefined)
			const [savingTools, setSavingTools] = react.useState(false)
			const [toolsSavedFlag, setToolsSavedFlag] = react.useState(false)
			const [toolError, setToolError] = react.useState("")
			const [promptDraft, setPromptDraft] = react.useState(undefined)
			const [savingPrompt, setSavingPrompt] = react.useState(false)
			const [promptSavedFlag, setPromptSavedFlag] = react.useState(false)
			const [promptError, setPromptError] = react.useState("")
			const load = react.useCallback(async (fresh) => {
				const rpc = transport
				if (rpc === undefined) {
					setError(pick("浏览器连接不可用，无法读取插件状态。", "The browser connection is unavailable, so the plugin state cannot be read."))
					return
				}
				setBusy(true)
				try {
					const result = await rpc.call(CHANNEL, "overview", { refresh: fresh === true })
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("读取失败", "Read failed"))
					const value = result.value
					setData(value)
					const visible = (value.models?.rows ?? []).filter(row => row.visible === true).map(row => row.id)
					setDraft(previous => previous === undefined ? visible : previous)
					setSavedDraft(previous => previous === undefined ? visible : previous)
					const exposedTools = Array.isArray(value.tools?.exposed) ? value.tools.exposed : []
					setToolDraft(previous => previous === undefined ? exposedTools : previous)
					setToolSaved(previous => previous === undefined ? exposedTools : previous)
					const storedPrompt = typeof value.prompt?.custom === 'string' ? value.prompt.custom : ''
					setPromptDraft(previous => previous === undefined ? storedPrompt : previous)
					setError("")
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
				} finally {
					setBusy(false)
				}
			}, [])
			react.useEffect(() => { load() }, [load])
			/**
			* Re-read the page once the live catalog has arrived, at most once.
			*
			* The first paint cannot wait for the probe (it starts a CLI), so it shows
			* manifest multipliers; this is what swaps them for the menu's own numbers
			* without a manual refresh.
			*/
			const reloadedForCatalog = react.useRef(false)
			const reloadAfterCatalog = react.useRef()
			reloadAfterCatalog.current = () => {
				if (reloadedForCatalog.current) return
				reloadedForCatalog.current = true
				void load()
			}
			/**
			* Start the CLI backend as soon as the page is shown.
			*
			* Opening the page is an explicit signal that the next turn is imminent,
			* so paying the start-up cost here beats paying it on the first message.
			*/
			const warm = react.useCallback(async () => {
				const rpc = transport
				if (rpc === undefined) return
				setWarming(true)
				try {
					const result = await rpc.call(CHANNEL, "warm", {})
					if (result?.ok === true && result.value?.backend !== undefined) {
						setData(previous => previous === undefined ? previous : { ...previous, backend: result.value.backend })
					}
					// The first paint used the manifest fallback; once the live catalog
					// is in, re-read so the multipliers switch to the menu's numbers.
					if (result?.ok === true && result.value?.catalog?.source === "catalog") reloadAfterCatalog.current()
				} catch {
					// Warming is best-effort; the overview already explains the backend.
				} finally {
					setWarming(false)
				}
			}, [])
			react.useEffect(() => { warm() }, [warm])
			const onKeepAlive = react.useCallback(async (seconds) => {
				const rpc = transport
				if (rpc === undefined) return
				setBusy(true)
				try {
					const result = await rpc.call(CHANNEL, "set-keep-alive", { seconds })
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("保存失败", "Save failed"))
					setData(previous => previous === undefined ? previous : { ...previous, backend: result.value })
					setError("")
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
				} finally {
					setBusy(false)
				}
			}, [])
			const toggleModel = react.useCallback((id, on) => {
				setSavedFlag(false)
				setModelError("")
				setDraft(previous => {
					const current = previous ?? []
					if (on === true) return current.includes(id) ? current : [...current, id]
					return current.filter(entry => entry !== id)
				})
			}, [])
			const selectAll = react.useCallback(() => {
				setSavedFlag(false)
				setModelError("")
				setDraft((data?.models?.rows ?? []).filter(row => row.blocked !== true).map(row => row.id))
			}, [data])
			const saveModels = react.useCallback(async () => {
				const rpc = transport
				if (rpc === undefined) return
				setSaving(true)
				setModelError("")
				try {
					const result = await rpc.call(CHANNEL, "save-models", { visible: draft ?? [] })
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("保存失败", "Save failed"))
					setData(previous => previous === undefined ? previous : { ...previous, models: result.value })
					setSavedDraft(draft ?? [])
					setSavedFlag(true)
					setError("")
				} catch (cause) {
					setModelError(cause instanceof Error ? cause.message : String(cause))
				} finally {
					setSaving(false)
				}
			}, [draft])
			const currentDraft = draft ?? []
			const currentSaved = savedDraft ?? []
			const dirty = currentDraft.length !== currentSaved.length || currentDraft.some(id => !currentSaved.includes(id))
			/** Stage one tool switch; nothing is written until Save. */
			const toggleTool = react.useCallback((name, on) => {
				setToolsSavedFlag(false)
				setToolError("")
				setToolDraft(previous => {
					const current = previous ?? []
					if (on === true) return current.includes(name) ? current : [...current, name]
					return current.filter(entry => entry !== name)
				})
			}, [])
			/** Persist the tool draft and take the refreshed catalog back. */
			const saveTools = react.useCallback(async () => {
				const rpc = transport
				if (rpc === undefined) return
				setSavingTools(true)
				setToolError("")
				try {
					const result = await rpc.call(CHANNEL, "save-tools", { names: toolDraft ?? [] })
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("保存失败", "Save failed"))
					setData(previous => previous === undefined ? previous : { ...previous, tools: result.value })
					setToolSaved(toolDraft ?? [])
					setToolsSavedFlag(true)
				} catch (cause) {
					setToolError(cause instanceof Error ? cause.message : String(cause))
				} finally {
					setSavingTools(false)
				}
			}, [toolDraft])
/** Save one prompt choice; the text and the declaration switch ride along. */
			const savePrompt = react.useCallback(async (mode, text, declareTools, declarationPlacement) => {
				const rpc = transport
				if (rpc === undefined) return
				setSavingPrompt(true)
				setPromptError("")
				try {
					const result = await rpc.call(CHANNEL, "save-prompt", { mode, text, ...(declareTools === undefined ? {} : { declareTools }), ...(declarationPlacement === undefined ? {} : { declarationPlacement }) })
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("保存失败", "Save failed"))
					setData(previous => previous === undefined ? previous : { ...previous, prompt: result.value })
					setPromptDraft(previous => previous === undefined ? result.value.custom : previous)
					setPromptSavedFlag(true)
				} catch (cause) {
					setPromptError(cause instanceof Error ? cause.message : String(cause))
				} finally {
					setSavingPrompt(false)
				}
			}, [])
			const onPromptMode = react.useCallback((mode) => {
				setPromptSavedFlag(false)
				void savePrompt(mode, promptDraft ?? "")
			}, [savePrompt, promptDraft])
			const onPromptSave = react.useCallback(() => {
				void savePrompt("custom", promptDraft ?? "")
			}, [savePrompt, promptDraft])
			const onDeclareTools = react.useCallback((on) => {
				void savePrompt(data?.prompt?.mode ?? "custom", promptDraft ?? "", on)
			}, [savePrompt, promptDraft, data?.prompt?.mode])
			const onDeclarationPlacement = react.useCallback((placement) => {
				void savePrompt(data?.prompt?.mode ?? "custom", promptDraft ?? "", undefined, placement)
			}, [savePrompt, promptDraft, data?.prompt?.mode])
			const currentPromptText = promptDraft ?? ""
			const storedPromptText = data?.prompt?.custom ?? ""
			const promptDirty = currentPromptText !== storedPromptText
			const [prepareState, setPrepareState] = react.useState({ value: undefined, busy: false })
			const accountPool = data?.accounts
			const onPrepare = react.useCallback(async (action, label) => {
				const rpc = transport
				if (rpc === undefined) return
				if (action === "reset") { setPrepareState({ value: undefined, busy: false }); return }
				if (action === "register") {
					const prepared = prepareState?.value
					if (prepared === undefined) return
					setPrepareState(previous => ({ ...previous, busy: true }))
					setError("")
					try {
						const existing = accountPool?.accounts ?? []
						const rows = [
							...existing.filter(row => row.isDefault !== true).map(row => ({ id: row.id, home: row.home, label: row.label, enabled: row.enabled !== false })),
							{ id: prepared.id, home: prepared.home, label: typeof label === "string" ? label : "", enabled: true },
						]
						const result = await rpc.call(CHANNEL, "accounts", { accounts: rows })
						if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("登记失败", "Register failed"))
						setData(previous => previous === undefined ? previous : { ...previous, accounts: result.value })
						setPrepareState({ value: undefined, busy: false })
					} catch (cause) {
						setError(cause instanceof Error ? cause.message : String(cause))
						setPrepareState(previous => ({ ...previous, busy: false }))
					}
					return
				}
				setPrepareState({ value: undefined, busy: true })
				setError("")
				try {
					const result = await rpc.call(CHANNEL, "prepare-account", {})
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("准备失败", "Prepare failed"))
					setPrepareState({ value: result.value, busy: false })
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
					setPrepareState({ value: undefined, busy: false })
				}
			}, [prepareState?.value, accountPool, setError])
			const onSaveCurrent = react.useCallback(async (label) => {
				const rpc = transport
				if (rpc === undefined) return
				setError("")
				try {
					const result = await rpc.call(CHANNEL, "save-current-account", { label })
					if (result?.ok !== true) throw new Error(result?.error?.message ?? pick("保存失败", "Save failed"))
					setData(previous => previous === undefined ? previous : { ...previous, accounts: result.value })
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause))
				}
			}, [setError])
			const currentToolDraft = toolDraft ?? []
			const currentToolSaved = toolSaved ?? []
			const toolsDirty = currentToolDraft.length !== currentToolSaved.length || currentToolDraft.some(name => !currentToolSaved.includes(name))
			const tabItems = [
				{ value: "overview", label: pick("概览", "Overview"), id: tabId("overview"), panelId: panelId("overview") },
				{ value: "accounts", label: pick("账号", "Accounts"), id: tabId("accounts"), panelId: panelId("accounts") },
				{ value: "models", label: pick("模型", "Models"), id: tabId("models"), panelId: panelId("models") },
				{ value: "settings", label: pick("设置", "Settings"), id: tabId("settings"), panelId: panelId("settings") }
			]
			const activeTab = tabItems.some(item => item.value === tab) ? tab : "overview"
			const cli = data?.cli
			const account = data?.account?.account
			const meta = [
				cli?.version === undefined || cli.version === "" ? "" : `v${cli.version}`,
				account?.nickname ?? "",
				data?.credits?.plan ?? ""
			].filter(part => part !== "").join(" · ")
			return h("div", { className: "cbc_card" },
				h("div", { className: "cbc_header" },
					h("div", { className: "cbc_headText" },
						h("span", { className: "cbc_statusLine" },
							"CodeBuddy",
							meta === "" ? null : h("span", { className: "cbc_meta" }, meta)
						),
						h("span", { className: "cbc_desc" },
							data?.readiness !== undefined && data.readiness.ready === false
								? data.readiness.title
								: pick("走本机 CodeBuddy CLI 的模型；账号、积分与后端状态都看这里。", "Models served by the local CodeBuddy CLI; account, credits, and backend state live here.")
						)
					)
				),
				h("div", { className: "cbc_body" },
					error === "" ? null : h("p", { className: "cbc_error" }, error),
					data === undefined && error === ""
						? h("p", { className: "cbc_hint" }, pick("正在读取…", "Loading…"))
						: h("div", null,
							h(ReadinessNotice, { readiness: data?.readiness }),
							h(primitives.SegmentedTabs, {
								className: "cbc_tabs",
								items: tabItems,
								value: activeTab,
								onChange: setTab,
								label: pick("插件页标签", "Plugin page tabs")
							}),
							h(TabPanel, { id: tabItems[0].panelId, labelledBy: tabItems[0].id, active: activeTab === "overview" },
								h(OverviewPanel, { data, busy, onRefresh: load, warming })
							),
							h(TabPanel, { id: tabItems[1].panelId, labelledBy: tabItems[1].id, active: activeTab === "accounts" },
								h(AccountsPanel, { pool: data?.accounts, onReload: load, busy, onError: setError, prepareState, onPrepare, onSaveCurrent })
							),
							h(TabPanel, { id: tabItems[2].panelId, labelledBy: tabItems[2].id, active: activeTab === "models" },
								h(ModelsPanel, {
									data,
									draft: currentDraft,
									onToggle: toggleModel,
									onSelectAll: selectAll,
									onSave: saveModels,
									saving,
									dirty,
									saved: savedFlag,
									error: modelError,
									busy
								})
							),
							h(TabPanel, { id: tabItems[3].panelId, labelledBy: tabItems[3].id, active: activeTab === "settings" },
								h(SettingsPanel, {
									data,
									busy,
									onKeepAlive,
									subTab: settingsSubTab,
									onSubTab: setSettingsSubTab,
									toolDraft: currentToolDraft,
									onToggleTool: toggleTool,
									onSaveTools: saveTools,
									savingTools,
									toolsDirty,
									toolsSaved: toolsSavedFlag,
									toolError,
									prompt: data?.prompt,
									promptDraft: currentPromptText,
									onMode: onPromptMode,
									onText: setPromptDraft,
									onSavePrompt: onPromptSave,
									savingPrompt,
									promptDirty,
									promptSaved: promptSavedFlag,
									promptError,
									onDeclareTools,
								onDeclarationPlacement
							})
							)
						)
				)
			)
		}
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-connect-codebuddy-cli-client"
		const inject = ["slots", "connection"]
		/** RPC channel served by this package's host half. */
		const CHANNEL = "/codebuddy"
		/**
		* The browser connection's RPC face, captured when the plugin activates.
		*
		* The page is a singleton mounted by the Plugins page, so one module-level
		* handle is enough, and reading it at call time keeps the page working when
		* the service is resolved after activation.
		*/
		let transport
		/**
		* Register the page on this bundle's own detail page.
		*
		* The Plugins page keys a bundle's configuration by its package name, and a
		* registered entry is what makes the detail page show a configuration
		* section at all.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			transport = ctx.get("connection")?.rpc
			ctx.effect(() => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: "dsh-connect-codebuddy-cli",
				order: 10
			}, PluginPage)), "dsh-connect-codebuddy-cli: plugin page")
		}
		//#endregion
		exports.apply = apply
		exports.inject = inject
		exports.name = name
		return module.exports
	}
})