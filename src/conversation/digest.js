/**
 * The text digest that rebuilds context after a provider switch or a rollback.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/conversation/digest
 */

import { isConversationMessage } from './messages.js'

/**
 * Bounds for the handoff digest injected on the first CLI turn of a conversation
 * that already has history from other providers.
 *
 * The digest is one text block prepended to the newest user message; a cap on
 * turns keeps a long session from pushing the actual question out of the CLI's
 * attention, and a cap per message keeps one huge paste from dominating.
 */
const MAX_HANDOFF_TURNS = 12

const MAX_HANDOFF_MESSAGE_CHARS = 400

/**
 * Caps for the digest that rebuilds context after a conversation rollback.
 *
 * A rewind has to reproduce the *surviving* conversation faithfully — there is
 * no CLI transcript left to resume — so it gets a much larger budget than a
 * cross-provider handoff, which is only a courtesy summary. Both numbers are
 * still bounded: the rebuild is paid once, and an unbounded replay would push
 * the user's actual question out of the window it is meant to fit in.
 */
const MAX_REWIND_TURNS = 40

const MAX_REWIND_MESSAGE_CHARS = 2_000

/** Total characters one rebuilt digest may carry, whatever the per-turn caps allow. */
const MAX_REWIND_TOTAL_CHARS = 24_000

export function handoffMessageText(message, maxChars = MAX_HANDOFF_MESSAGE_CHARS) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block?.type === 'image') parts.push('[图片]')
    else if (block?.type === 'file') parts.push('[附件]')
  }
  const joined = parts.join('\n').trim()
  if (joined === '') return ''
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}

/**
 * Build the handoff digest for a conversation whose earlier turns another
 * provider served.
 *
 * DSH gives every provider the full history each step, but this bridge sends
 * only the newest user text and lets the CLI accumulate its own transcript —
 * so a session where the user chatted with other models first would hand
 * CodeBuddy a question with no preceding context. When the projected step
 * carries prior conversation (any message before the newest human turn), the
 * digest condenses it into a bounded transcript prefix the CLI reads once.
 * Continuation steps and pure-CodeBuddy conversations never see it.
 * @param messages - the step's projected messages.
 * @returns the digest text, or `''` when there is nothing to hand over.
 */
export function handoffDigest(messages, options = {}) {
  if (!Array.isArray(messages)) return ''
  let human = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'user' && message?.source?.kind === 'user') human = index
  }
  if (human <= 0) return ''
  const rewound = options.reason === 'rewind'
  const maxTurns = options.maxTurns ?? (rewound ? MAX_REWIND_TURNS : MAX_HANDOFF_TURNS)
  const maxChars = options.maxChars ?? (rewound ? MAX_REWIND_MESSAGE_CHARS : MAX_HANDOFF_MESSAGE_CHARS)
  const totalChars = options.totalChars ?? (rewound ? MAX_REWIND_TOTAL_CHARS : Number.POSITIVE_INFINITY)
  // Assistant answers, human turns, and tool results are the conversation; the
  // injected reminders and the rewind marker are machinery (see isConversationMessage).
  const earlier = messages.slice(0, human).filter(isConversationMessage)
  if (earlier.length === 0) return ''
  // Keep the tail: the most recent context is what the question continues.
  const lines = []
  let used = 0
  for (const message of earlier.slice(-maxTurns)) {
    const text = handoffMessageText(message, maxChars)
    if (text === '') continue
    const who = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'Tool'
    const line = `${who}: ${text.replaceAll('\n', ' ')}`
    if (used + line.length > totalChars) break
    lines.push(line)
    used += line.length
  }
  if (lines.length === 0) return ''
  // A rewind rebuilds the transcript from nothing, so it says so; a handoff may
  // be a mid-conversation provider switch and describes that instead.
  const header = rewound
    ? [
      '[Conversation history — this chat was rolled back and this is what remains of it.',
      'Treat it as established context; do not answer these turns again.]',
    ]
    : [
      '[Conversation handoff — the turns below happened in this chat before the message that follows,',
      'partly with other models. Treat them as established context; do not answer them again.]',
    ]
  return [...header, ...lines].join('\n')
}

export {
  MAX_HANDOFF_MESSAGE_CHARS,
  MAX_HANDOFF_TURNS,
  MAX_REWIND_MESSAGE_CHARS,
  MAX_REWIND_TOTAL_CHARS,
  MAX_REWIND_TURNS,
}
