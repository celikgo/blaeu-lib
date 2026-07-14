import type { WorldBbox, WorldXY } from './types.js'

/**
 * A pointy-top hex lattice, in world units.
 *
 * `gridSize` is the **centre-to-centre spacing along a row** — the same thing it
 * means for the square grid, which is what lets `gridSize` stay one option rather
 * than becoming two. From it:
 *
 *   circumradius R = gridSize / √3      (centre → corner)
 *   row spacing    = 1.5 · R            (the standard pointy-top vertical stagger)
 *   odd rows are offset by gridSize / 2
 *
 * There is no attempt at a general hex library here. A game preset needs exactly two
 * operations — "where are the cells" (to draw them) and "which cell is nearest" (to
 * snap to one) — and a third-party hex dependency would buy neither.
 */

export function hexCircumradius(gridSize: number): number {
  return gridSize / Math.sqrt(3)
}

/** Vertical distance between hex rows. */
export function hexRowSpacing(gridSize: number): number {
  return 1.5 * hexCircumradius(gridSize)
}

/** The centre of the cell at axial-ish (column, row). Odd rows are staggered half a cell. */
export function hexCentre(column: number, row: number, gridSize: number): WorldXY {
  const stagger = (Math.abs(row) % 2) * (gridSize / 2)
  return [column * gridSize + stagger, row * hexRowSpacing(gridSize)]
}

/** The six corners of a pointy-top hex, closed (first === last), ready to be a ring. */
export function hexRing(centre: WorldXY, gridSize: number): readonly WorldXY[] {
  const radius = hexCircumradius(gridSize)
  const corners: WorldXY[] = []
  for (let i = 0; i < 6; i++) {
    // -30° puts a corner at the top: a *pointy*-top hex. Flat-top is the same lattice
    // transposed, and picking one and saying so beats an option nobody would set.
    const angle = ((60 * i - 30) * Math.PI) / 180
    corners.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)])
  }
  corners.push(corners[0]!)
  return corners
}

/**
 * The nearest hex centre.
 *
 * Deliberately a small local search rather than the cube-rounding algorithm: the
 * stagger makes the naive inverse ambiguous near a row boundary, and the nine
 * candidates around the estimate cost nine distance comparisons — on a pointer move,
 * next to the projection that produced `xy`, that is free, and it cannot be wrong.
 */
export function nearestHexCentre(xy: WorldXY, gridSize: number): WorldXY {
  const rowGuess = Math.round(xy[1] / hexRowSpacing(gridSize))

  let best: WorldXY = [0, 0]
  let bestDistance = Infinity

  for (let row = rowGuess - 1; row <= rowGuess + 1; row++) {
    const stagger = (Math.abs(row) % 2) * (gridSize / 2)
    const columnGuess = Math.round((xy[0] - stagger) / gridSize)
    for (let column = columnGuess - 1; column <= columnGuess + 1; column++) {
      const centre = hexCentre(column, row, gridSize)
      const dx = centre[0] - xy[0]
      const dy = centre[1] - xy[1]
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestDistance = distance
        best = centre
      }
    }
  }

  return best
}

/** Every hex centre whose cell overlaps `bounds`. Row-major, so the drawn grid is stable. */
export function hexCentresIn(bounds: WorldBbox, gridSize: number): readonly WorldXY[] {
  const [minX, minY, maxX, maxY] = bounds
  const radius = hexCircumradius(gridSize)
  const rowSpacing = hexRowSpacing(gridSize)

  const firstRow = Math.floor((minY - radius) / rowSpacing)
  const lastRow = Math.ceil((maxY + radius) / rowSpacing)

  const centres: WorldXY[] = []
  for (let row = firstRow; row <= lastRow; row++) {
    const stagger = (Math.abs(row) % 2) * (gridSize / 2)
    const firstColumn = Math.floor((minX - stagger - gridSize) / gridSize)
    const lastColumn = Math.ceil((maxX - stagger + gridSize) / gridSize)
    for (let column = firstColumn; column <= lastColumn; column++) {
      centres.push(hexCentre(column, row, gridSize))
    }
  }
  return centres
}
