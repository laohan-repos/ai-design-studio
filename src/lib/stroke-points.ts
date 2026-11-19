import type { PosterPoint } from './poster'

type Segment = { start: number; end: number; index: number; error: number }

// Spend the point budget on the largest deviations in the path, retaining both endpoints.
export function resampleStroke(points: PosterPoint[], limit: number, width: number, height: number) {
  if (points.length <= limit) return points

  function segment(start: number, end: number): Segment {
    const first = points[start]
    const dx = (points[end].x - first.x) * width
    const dy = (points[end].y - first.y) * height
    const lengthSquared = dx ** 2 + dy ** 2
    let index = start, error = 0
    for (let i = start + 1; i < end; i++) {
      const x = (points[i].x - first.x) * width
      const y = (points[i].y - first.y) * height
      const position = lengthSquared ? Math.min(1, Math.max(0, (x * dx + y * dy) / lengthSquared)) : 0
      const distance = (x - position * dx) ** 2 + (y - position * dy) ** 2
      if (distance > error) { index = i; error = distance }
    }
    return { start, end, index, error }
  }

  const retained = [0, points.length - 1]
  const candidates = [segment(0, points.length - 1)]
  while (retained.length < limit) {
    const best = candidates.reduce((chosen, candidate, index) => candidate.error > candidates[chosen].error ? index : chosen, 0)
    const { start, end, index, error } = candidates[best]
    if (error < 1e-8) break
    retained.push(index)
    candidates.splice(best, 1, segment(start, index), segment(index, end))
  }
  return retained.sort((a, b) => a - b).map(index => points[index])
}
