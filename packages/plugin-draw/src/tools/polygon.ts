import type { DrawSession } from '../session.js'
import { sequenceTool } from './sequence.js'
import type { DrawTool } from './tool.js'

/**
 * Click to add a corner; close the ring by double-clicking or by clicking its first corner;
 * Backspace removes the last corner; Escape abandons the ring.
 *
 * The ring is handed to the store open — `[c0, c1, c2, c0]` — and the store's normaliser
 * closes it, winds it counter-clockwise and quantises it to the working CRS's precision
 * grid. This tool does not attempt any of that itself, because doing it twice is how the
 * two implementations drift apart.
 */
export function polygonTool(session: DrawSession): DrawTool {
  return sequenceTool(session, 'polygon')
}
