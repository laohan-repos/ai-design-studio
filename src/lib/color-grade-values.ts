import type { ColorGrade } from './color-grade'

export function hasColorGradeChanges(settings: ColorGrade) {
  const { protectNeutrals: _, curves, hsl, colorWheels, ...basic } = settings
  return Object.values(basic).some(Boolean) || Object.values(curves ?? {}).some(points => points.some(point => point.x !== point.y))
    || Object.values(hsl ?? {}).some(band => band.hue || band.saturation || band.lightness)
    || Object.values(colorWheels ?? {}).some(zone => zone.saturation)
}
