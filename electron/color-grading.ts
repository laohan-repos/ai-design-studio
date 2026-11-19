import type { ColorBand, ColorGrade, ColorValues, CurvePoint, PhotoColors } from '../src/lib/color-grade'

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value))
const lightness = (red: number, green: number, blue: number) => 0.2126 * red + 0.7152 * green + 0.0722 * blue
type RGB = [number, number, number]

function ramp(value: number, from: number, to: number) {
  const t = clamp((value - from) / (to - from))
  return t * t * (3 - 2 * t)
}

function curveTable(points?: CurvePoint[]) {
  if (!points) return undefined
  const table = new Float32Array(1025)
  let segment = 0
  for (let i = 0; i < table.length; i++) {
    const x = i / 1024
    while (segment < points.length - 2 && x > points[segment + 1].x) segment++
    const [a, b] = [points[segment], points[segment + 1]]
    table[i] = a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)
  }
  return table
}

function evaluate(table: Float32Array | undefined, value: number) {
  if (!table) return value
  const index = clamp(value) * 1024
  const step = Math.min(1023, Math.floor(index))
  return table[step] + (table[step + 1] - table[step]) * (index - step)
}

function blendChannel(start: number, base: number, color: number, colorMask: number, strength: number) {
  return (start + (clamp(base + (color - base) * colorMask) - start) * strength) * 255
}

function toHsl(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const span = max - min, l = (max + min) / 2
  if (!span) return { h: 0, s: 0, l }
  const sector = max === r ? (g - b) / span : max === g ? 2 + (b - r) / span : 4 + (r - g) / span
  return { h: (sector * 60 + 360) % 360, s: span / (1 - Math.abs(2 * l - 1)), l }
}

function fromHsl(h: number, s: number, l: number): RGB {
  const hue = ((h % 360) + 360) % 360 / 60
  const span = (1 - Math.abs(2 * l - 1)) * s
  const secondary = span * (1 - Math.abs(hue % 2 - 1))
  const offset = l - span / 2
  switch (Math.floor(hue)) {
    case 0: return [span + offset, secondary + offset, offset]
    case 1: return [secondary + offset, span + offset, offset]
    case 2: return [offset, span + offset, secondary + offset]
    case 3: return [offset, secondary + offset, span + offset]
    case 4: return [secondary + offset, offset, span + offset]
    default: return [span + offset, offset, secondary + offset]
  }
}

const bandHue: Record<ColorBand, number> = { red: 0, orange: 32, yellow: 62, green: 118, cyan: 181, blue: 225, purple: 273, magenta: 317 }

export function applyColorGrade(data: Uint8ClampedArray, settings: ColorGrade, mask?: Uint8ClampedArray) {
  const master = curveTable(settings.curves?.rgb)
  const red = curveTable(settings.curves?.red), green = curveTable(settings.curves?.green), blue = curveTable(settings.curves?.blue)
  const exposure = 2 ** ((settings.exposure ?? 0) / 2.2)
  const contrast = 1 + (settings.contrast ?? 0) * 0.006
  const shadows = (settings.shadows ?? 0) * 0.0021, highlights = (settings.highlights ?? 0) * 0.002
  const blacks = (settings.blacks ?? 0) * 0.0016, whites = (settings.whites ?? 0) * 0.0017
  const warmth = (settings.temperature ?? 0) * 0.0025
  const tint = (settings.tint ?? 0) * 0.0019
  const wbR = warmth + tint * 0.5, wbG = -tint, wbB = -warmth + tint * 0.5
  const wbL = lightness(wbR, wbG, wbB)
  const neutralProtection = (settings.protectNeutrals ?? 0) / 100
  const saturation = 1 + (settings.saturation ?? 0) / 100
  const bands = Object.entries(settings.hsl ?? {}).map(([name, band]) => ({ ...band, center: bandHue[name as ColorBand] }))
  const wheels = Object.entries(settings.colorWheels ?? {}).filter(([, wheel]) => wheel.saturation).map(([zone, wheel]) => {
    const color = fromHsl(wheel.hue, 1, 0.5)
    const l = lightness(...color)
    const change = color.map(channel => (channel - l) * wheel.saturation * 0.0045)
    return { zone, change }
  })

  for (let index = 0; index < data.length; index += 4) {
    const strength = mask ? mask[index + 3] / 255 : 1
    if (!strength || !data[index + 3]) continue
    const r = data[index] / 255, g = data[index + 1] / 255, b = data[index + 2] / 255
    const l = lightness(r, g, b)
    const shift = (l * exposure - 0.5) * contrast + 0.5 - l
      + shadows * ramp(l, 0, 0.1) * (1 - ramp(l, 0.24, 0.68))
      + highlights * ramp(l, 0.53, 0.97) + whites * ramp(l, 0.74, 1) + blacks * (1 - ramp(l, 0, 0.31))
    const baseR = clamp(evaluate(master, clamp(r + shift)))
    const baseG = clamp(evaluate(master, clamp(g + shift)))
    const baseB = clamp(evaluate(master, clamp(b + shift)))
    const baseLight = lightness(baseR, baseG, baseB)
    const colorMask = 1 - neutralProtection * (1 - ramp(Math.max(r, g, b) - Math.min(r, g, b), 0.025, 0.20))
    // Apply white balance as a chroma change so warming leaves the tone curve in control of brightness.
    const colorTaper = 0.35 + 0.65 * Math.sin(Math.PI * baseLight)
    let nextR = evaluate(red, clamp(baseLight + (baseR - baseLight) * saturation + (wbR - wbL) * colorTaper))
    let nextG = evaluate(green, clamp(baseLight + (baseG - baseLight) * saturation + (wbG - wbL) * colorTaper))
    let nextB = evaluate(blue, clamp(baseLight + (baseB - baseLight) * saturation + (wbB - wbL) * colorTaper))

    if (bands.length) {
      const color = toHsl(nextR, nextG, nextB)
      let hue = 0, sat = 0, light = 0, totalWeight = 0
      for (const band of bands) {
        const distance = Math.abs((color.h - band.center + 540) % 360 - 180)
        const weight = (1 - ramp(distance, 7, 47)) * ramp(color.s, 0.025, 0.23)
        hue += weight * (band.hue ?? 0)
        sat += weight * (band.saturation ?? 0)
        light += weight * (band.lightness ?? 0)
        totalWeight += weight
      }
      const weight = Math.max(1, totalWeight)
      const adjusted = fromHsl(color.h + hue / weight,
        clamp(color.s * (1 + sat / weight / 100)), clamp(color.l + light / weight * 0.003))
      nextR = adjusted[0]
      nextG = adjusted[1]
      nextB = adjusted[2]
    }
    for (const wheel of wheels) {
      const weight = wheel.zone === 'shadows' ? 1 - ramp(baseLight, 0.15, 0.54)
        : wheel.zone === 'highlights' ? ramp(baseLight, 0.53, 0.91) : ramp(baseLight, 0.12, 0.48) * (1 - ramp(baseLight, 0.52, 0.91))
      nextR += wheel.change[0] * weight
      nextG += wheel.change[1] * weight
      nextB += wheel.change[2] * weight
    }

    data[index] = blendChannel(r, baseR, nextR, colorMask, strength)
    data[index + 1] = blendChannel(g, baseG, nextG, colorMask, strength)
    data[index + 2] = blendChannel(b, baseB, nextB, colorMask, strength)
  }
}

export function summarizePixels(data: Uint8ClampedArray, histogram?: PhotoColors['histogram']): ColorValues {
  let sumR = 0, sumG = 0, sumB = 0, sumL = 0, saturation = 0, pixelCount = 0, dark = 0, bright = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
    const l = lightness(r, g, b)
    const upper = Math.max(r, g, b), lower = Math.min(r, g, b)
    sumR += r; sumG += g; sumB += b; sumL += l
    saturation += (upper - lower) / 255
    pixelCount++
    if (upper <= 3) dark++
    if (upper >= 252) bright++
    if (histogram) {
      histogram.red[r >> 3]++
      histogram.green[g >> 3]++
      histogram.blue[b >> 3]++
      histogram.luminance[Math.floor(l) >> 3]++
    }
  }
  const denominator = Math.max(1, pixelCount)
  const mean = (value: number) => Math.round(value * 100 / denominator) / 100
  return { rgb: [mean(sumR), mean(sumG), mean(sumB)], luminance: mean(sumL), saturation: mean(saturation),
    darkClipping: mean(dark * 100), lightClipping: mean(bright * 100), pixelCount }
}
