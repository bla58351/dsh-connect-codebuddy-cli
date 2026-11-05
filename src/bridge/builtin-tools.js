/**
 * Tool names DSH ships itself.
 *
 * The `tools` service keeps no provenance: a definition is a plain object in a
 * named table, and `tools/change` announces that something changed without
 * saying who registered it. So the only classification available to a plugin is
 * a name list, which is what this module is.
 *
 * The list was read out of the tool packages this DSH build ships
 * (`@deepseek-ai/dsh-tool-*` plus the plan/workflow entries). A tool missing
 * from it is reported as "非内置", not as a proven third-party one: a future
 * DSH release that adds a tool would otherwise be labelled wrongly, and the page
 * must never claim knowledge it does not have.
 *
 * @module dsh-connect-codebuddy-cli/builtin-tools
 */

/** Names registered by the shipped `@deepseek-ai/dsh-tool-*` packages. */
export const BUILTIN_TOOL_NAMES = new Set([
  // shell
  'bash',
  'pwsh',
  // filesystem
  'read',
  'read_image',
  'write',
  'edit',
  'str_replace_editor',
  'glob',
  'grep',
  // web
  'web_fetch',
  'web_search',
  // conversation and planning
  'ask_user_question',
  'todo_write',
  'exit_plan_mode',
  'present',
  'skill',
  // goals
  'create_goal',
  'get_goal',
  'update_goal',
  // jobs
  'job_kill',
  'job_list',
  'job_output',
  // schedules
  'schedule_create',
  'schedule_delete',
  'schedule_list',
  'schedule_update',
  // session history
  'session_search',
  'session_trace',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  // subagents and teams
  'list_subagent_models',
  'send_message',
  'interrupt_agent',
  // terminals
  'terminal_open',
  'terminal_close',
  'terminal_list',
  'terminal_read',
  'terminal_send',
  'terminal_signal',
  // workflow and workspace
  'workflow',
  'working_directory',
  'load_workspace_dependencies',
  'ralph',
  // cordis introspection
  'cordis_inspect_list',
  'cordis_inspect_query',
])

/**
 * Classify one registered tool.
 *
 * @param name - the tool name.
 * @returns `'builtin'` when DSH ships it, otherwise `'external'`.
 */
export function toolOrigin(name) {
  return BUILTIN_TOOL_NAMES.has(String(name)) ? 'builtin' : 'external'
}