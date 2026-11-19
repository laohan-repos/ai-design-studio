export function hasPhotoArea(points: { x: number; y: number }[]) {
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]
    return sum + point.x * next.y - point.y * next.x
  }, 0)
  return Math.abs(area) > 0.000002
}
