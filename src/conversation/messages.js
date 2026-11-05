/**
 * Which projected message is the human turn, and how a conversation is fingerprinted.
 *
 * Extracted from the plugin entry so the entry stays wiring only; no
 * behaviour changed in the move.
 * @module dsh-connect-codebuddy-cli/conversation/messages
 */

import { handoffMessageText } from './digest.js'

/** The message kind the rewind plugin appends; it is machinery, never conversation. */
const REWIND_MARKER_KIND = 'dsh-rewind'

/**
 * `source.kind` values that are machinery rather than something the user or the
 * model said.
 *
 * A deny-list, deliberately: a new injecting plugin is a new kind that this list
 * has not learned yet, and treating unknown kinds as content costs a stale
 * summary in a digest, while treating them as machinery can mistake a
 * compaction for a rollback.
 */
const MACHINERY_KINDS = new Set([
  'runtime-context',
  'skill-catalog',
  'tool-result',
  'system-reminder',
  'time-context',
  'model-selection',
  REWIND_MARKER_KIND,
])

/**
 * Whether a step continues the turn already running.
 *
 * Between steps DSH appends the results of the previous message's calls as
 * `role: 'tool'` messages, after the human turn. That is the signal: a human
 * message followed by a tool result can only be a continuation, because a new
 * user message arrives with injected reminders and never with tool results.
 * @param messages - the step's projected messages.
 * @returns true when a tool result follows the newest human message.
 */
function continuesTurn(messages) {
  if (!Array.isArray(messages)) return false
  let human = -1
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'user' && message?.source?.kind === 'user') human = index
  }
  if (human < 0) return false
  for (let index = human + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message?.role === 'tool' || message?.source?.kind === 'tool') return true
  }
  return false
}

/**
 * The newest human-authored user message's text, which is what the CLI answers.
 *
 * DSH interleaves the human turn with injected context: a runtime-context
 * snapshot, the skill catalog, and possibly tool results all carry
 * `role: 'user'` and arrive *after* the human's text. Taking "the last user
 * message" would therefore hand the CLI a system reminder instead of the
 * question — the model then answers the reminder. The `source.kind` on each
 * message is what distinguishes them, so this walks backwards looking for a
 * genuinely human-authored turn and falls back to the last user message only
 * when the projection carries no source information at all.
 *
 * Earlier turns are already in the CodeBuddy session on disk, so replaying
 * them would double-count them. Non-text blocks (images, files) are not
 * representable in a CLI text frame, so they are replaced by a short
 * placeholder that keeps the model from believing content went missing.
 * @param messages - the turn's projected messages.
 * @returns the prompt text, or `''` when no user message has any.
 */
function latestUserText(messages) {
  if (!Array.isArray(messages)) return ''
  const users = messages.filter(message => message?.role === 'user')
  const chosen = chooseUserMessage(users)
  if (chosen === undefined) return ''
  const parts = []
  for (const block of chosen.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    // Neutral placeholders only: the image bytes themselves ride in the same
    // CLI frame (see #imagesFor), so a 'cannot be transferred' wording once
    // contradicted the picture the model could actually see. This text only
    // marks the block's position; when no bytes are forwarded (no attachment
    // service), the model sees an unnamed gap it can ask about.
    else if (block?.type === 'image') parts.push('[图片]')
    else if (block?.type === 'file') parts.push('[附件]')
  }
  return parts.join('\n').trim()
}

/**
 * Pick the message that carries what the person actually typed.
 *
 * DSH labels every injected reminder `role: 'user'` too, and several plugins
 * append them *after* the human turn — `time-context` is one, and its text
 * ("Time sampled while preparing turn …") is a timestamp with no question in
 * it. Choosing by position alone therefore hands the CLI a reminder instead of
 * the request, and the model correctly answers that there is no request.
 *
 * Rather than deny-list kinds, which silently breaks whenever a new injecting
 * plugin ships, this keys on the one thing that identifies a human turn: its
 * source is `kind: 'user'`. Anything else is machinery and is skipped. The
 * deny-list survives only as a fallback for compositions that inject no
 * `kind: 'user'` source at all.
 * @param users - the turn's `role: 'user'` messages, in order.
 * @returns the chosen message, or `undefined` when there is none.
 */
function chooseUserMessage(users) {
  const human = users.filter(message => message?.source?.kind === 'user')
  if (human.length > 0) return human[human.length - 1]
  // No explicitly human source: fall back to the last message that is not one
  // of the reminders known to be appended after the request.
  const injected = new Set(['runtime-context', 'skill-catalog', 'tool-result', 'system-reminder', 'time-context'])
  const remaining = users.filter(message => !injected.has(message?.source?.kind))
  if (remaining.length > 0) return remaining[remaining.length - 1]
  return users[users.length - 1]
}

/**
 * Whether one projected message belongs to the conversation itself.
 *
 * Assistant answers, human turns, and tool results are the conversation. The
 * injected `role: 'user'` reminders DSH threads between turns are machinery, and
 * so is the marker the rewind plugin appends: carrying either into a digest or
 * a fingerprint would make "what the model was told" depend on which plugins
 * happen to be installed.
 * @param message - a projected DSH message.
 * @returns true when the message is conversation content.
 */
function isConversationMessage(message) {
  const role = message?.role
  if (role !== 'assistant' && role !== 'user' && role !== 'tool') return false
  if (role !== 'user') return true
  const kind = message?.source?.kind
  // Only known machinery is dropped. An unknown kind is assumed to be content:
  // a summariser's own message has to stay in the fingerprint, or a compacted
  // projection would look exactly like a rollback and the rebuild would throw
  // away a conversation that is still intact.
  return kind === undefined || !MACHINERY_KINDS.has(kind)
}

/**
 * A stable, cheap fingerprint of one message's conversation content.
 *
 * Message ids are not compared: a rewrite (fork, edit, rewind) mints new ids for
 * content that may be identical, and an FNV-1a of role plus text answers the one
 * question this is asked — "is this the same thing the model already saw?".
 * @param message - a projected DSH message.
 * @returns `'role:hash'`.
 */
function messageSignature(message) {
  const role = String(message?.role ?? '')
  const text = handoffMessageText(message)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${role}:${hash.toString(16)}`
}

/**
 * The conversation-only fingerprint sequence for one step's messages.
 * @param messages - the step's projected messages.
 * @returns the signatures, in order.
 */
export function conversationSignature(messages) {
  if (!Array.isArray(messages)) return []
  return messages.filter(isConversationMessage).map(messageSignature)
}

/**
 * Whether the newer fingerprint continues the older one without rewriting it.
 *
 * A rollback removes a suffix, so the surviving history is a prefix of what the
 * model already saw — optionally followed by the message the user re-sent. Two
 * shapes have to be told apart from that:
 *
 * - **compaction** replaces the *head* with a summary and keeps the tail. There
 *   the CLI's untouched transcript is the better copy, so it is not rewritten.
 * - **forking** opens a new session id, which never reaches this comparison.
 *
 * @param previous - the fingerprint recorded before the last turn ran.
 * @param current - the fingerprint of the step about to run.
 * @returns true when nothing was rolled back.
 */
export function continuesSignature(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current)) return false
  if (current.length === 0) return previous.length === 0
  let common = 0
  while (common < previous.length && common < current.length && previous[common] === current[common]) {
    common += 1
  }
  // The same history, or one that grew: nothing was rewritten.
  if (common === previous.length) return true
  // `current` lost its tail: a rollback that carried no new message.
  if (common === current.length) return false
  // `current` kept everything up to its last message, which is the new one.
  if (common === current.length - 1) return false
  // Anything else replaced part of the history in the middle. Context
  // compaction does exactly that, and there the CLI's untouched transcript is
  // the *better* copy, so it is left alone: a false "no rewrite" costs a stale
  // detail, while a false "rewrite" would throw away a conversation that is
  // still intact.
  return true
}

export {
  MACHINERY_KINDS,
  REWIND_MARKER_KIND,
  chooseUserMessage,
  continuesTurn,
  isConversationMessage,
  latestUserText,
  messageSignature,
}
