import type { DrawSession } from '../session.js'
import { sequenceTool } from './sequence.js'
import type { DrawTool } from './tool.js'

/**
 * Click to add a vertex, double-click (or Enter, or `DrawApi.finish()`) to end the line,
 * Backspace to take the last vertex back, Escape to abandon it.
 *
 * A line does not close on its first vertex — that gesture belongs to the polygon tool, and
 * a line that silently became a ring because the user's last click landed near their first
 * would be a genuinely baffling thing to have happen.
 */
export function lineTool(session: DrawSession): DrawTool {
  return sequenceTool(session, 'line')
}
