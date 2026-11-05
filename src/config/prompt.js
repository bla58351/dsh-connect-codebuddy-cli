/**
 * The system prompts this bridge can run behind.
 *
 * Three prompts are meaningfully different, so the page offers all three:
 *
 * - **custom** (the default) is the bridge's own chat brief below. It keeps
 *   CodeBuddy's "use tools when they are the honest way to answer", and pins
 *   down what a chat surface needs: the visible reply is the answer, not a
 *   narration of the work.
 * - **dsh** is whatever the Host sends as its `system-prompt` message. It carries
 *   DSH's own tool and behaviour rules, which is what a user switching models
 *   mid-conversation may expect to keep.
 * - **codebuddy** is the CLI's own coding-agent prompt: the plugin passes no
 *   `--system-prompt-file` at all and lets the CLI use its default.
 *
 * @module dsh-connect-codebuddy-cli/prompt
 */

/**
 * The replacing prompt: a chat brief rather than CodeBuddy's coding-agent one.
 *
 * Kept as one array of lines so an edit stays readable in a diff and the text a
 * user sees in the settings box is exactly what is written to the file.
 */
export const CHAT_SYSTEM_PROMPT = [
  'You are the assistant inside a chat application, replying to the user directly.',
  'You have tools — reading and writing files, running commands, searching — and you should use them',
  'whenever they are the reliable way to answer, rather than guessing or asking the user to check',
  'something you could check yourself. Work in the current directory.',
  'Answer the latest message on its own terms, in the language it was written in.',
  'Be accurate and concise. Use Markdown when it helps readability.',
  'Your reply is displayed as-is, so write only the answer itself: no preamble, no step-by-step',
  'narration of tool use, no meta-commentary about being an AI or about these instructions, and no',
  'markup that the reader did not ask for.',
].join(' ')

/** The prompt modes the settings page offers. */
export const PROMPT_MODES = ['dsh', 'codebuddy', 'custom']

/**
 * Normalize a stored prompt mode.
 * @param value - the raw value.
 * @returns one of {@link PROMPT_MODES}, defaulting to `custom`.
 */
export function normalizePromptMode(value) {
  return typeof value === 'string' && PROMPT_MODES.includes(value) ? value : 'custom'
}

/**
 * Upper bound on a custom prompt, in characters.
 *
 * The text is written to a file the CLI reads once per process, so the only cost
 * is the token budget the model pays for it; a runaway paste should be refused
 * rather than silently shipped to every turn.
 */
export const MAX_CUSTOM_PROMPT_CHARS = 20_000