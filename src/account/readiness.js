/**
 * Explain why the route cannot serve yet, in words the page can render.
 *
 * This lives in `account/`, not `host/`: the adapter asks the same question in
 * its pre-flight check (to fail before a process is spawned), and the layering
 * runs `host/ → adapter/` only — an adapter import from `host/` inverted that.
 * The host page re-exports it, so nothing about the public surface moves.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/account/readiness
 */

/**
 * Explain what still has to happen before a CodeBuddy model can answer.
 *
 * Two failures are worth separating because the fix differs completely: a missing
 * CLI is an install, a missing session is a login. Both used to surface as one
 * opaque reason string, which told a user what was wrong but not what to do.
 *
 * @param status - the CLI status.
 * @param account - the account status.
 * @returns `{ ready, state, title, detail, steps, note }`.
 */
export function describeReadiness(status, account) {
  if (status.installed !== true) {
    return {
      ready: false,
      state: 'cli-missing',
      title: '没有找到 CodeBuddy CLI',
      detail: 'DSH 里的 CodeBuddy 模型是由本机已登录的 CLI 实际回答的。没有 CLI，就没有可用的后端。',
      steps: [
        { label: '安装 CLI', command: 'npm install -g @tencent-ai/codebuddy-code' },
        { label: '安装后重启 DSH（插件在启动时探测 CLI）', command: '' },
      ],
      note: '如果 CLI 装在别处，可在插件配置里用 binary 指向包内的 bin/codebuddy；不要指向 .cmd 包装，那会把 --model 当成命令解释。',
    }
  }
  if (account?.signedIn !== true) {
    const expired = account?.state === 'expired'
    return {
      ready: false,
      state: expired ? 'expired' : 'not-signed-in',
      title: expired ? 'CodeBuddy 登录已过期' : 'CodeBuddy CLI 已安装，但还没有登录',
      detail: 'DSH 通过 CLI 自己的登录身份调用模型，所以未登录时任何 CodeBuddy 模型都跑不起来。',
      steps: [
        { label: '在终端启动 CLI', command: 'codebuddy' },
        { label: '在它的输入框里登录', command: '/login' },
        { label: '登录完成后回到本页点「刷新」', command: '' },
      ],
      note: typeof account?.reason === 'string' && account.reason !== '' ? account.reason : '',
    }
  }
  return { ready: true, state: 'ready', title: '', detail: '', steps: [], note: '' }
}
