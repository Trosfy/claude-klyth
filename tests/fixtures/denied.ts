// The engine's refusal of an action in auto mode when its classifier gave no verdict, as `classic.PermissionDenied`
// carries it (probed on Claude Code 2.1.294 with `--permission-mode auto`): the reason, the mode, the tool and its whole
// input, the call's id, the working directory, and `agent_id` inside a subagent only. The reason is the engine's word
// for the case; the model reads a different text, which klyth never matches.
export const CLASSIFIER_UNAVAILABLE = 'Classifier unavailable'

type More = { cwd?: string; permission_mode?: string; agent_id?: string; reason?: string }

// A refusal of `tool_name` with `tool_input` in call `tool_use_id`, in /w (the kit's working directory) unless `more` says otherwise.
export const denied = (tool_name: string, tool_input: Record<string, unknown>, tool_use_id: string, more: More = {}) => ({
  tool_name,
  tool_input,
  tool_use_id,
  reason: CLASSIFIER_UNAVAILABLE,
  permission_mode: 'auto',
  cwd: '/w',
  ...more,
})
