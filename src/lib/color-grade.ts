import { z } from 'zod'
import { hasColorGradeChanges } from './color-grade-values'

const amount = z.number().min(-100).max(100)
const unit = z.number().min(0).max(1)
export const curvePoint = z.object({ x: unit, y: unit })
const curve = z.array(curvePoint).min(2).max(12).refine(points => {
  return points[0].x === 0 && points.at(-1)?.x === 1 && points.every((point, index) => !index || point.x - points[index - 1].x >= 0.001)
}, '曲线输入需严格递增，且包含输入 0 和 1')
export const colorBands = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta'] as const
const bands = z.object({ hue: z.number().min(-60).max(60).optional(), saturation: amount.optional(), lightness: amount.optional() })
const wheel = z.object({ hue: z.number().min(0).max(360), saturation: z.number().min(0).max(35) })

const colorGradeShape = z.object({
  exposure: z.number().min(-2).max(2).optional().describe('曝光 EV'),
  temperature: amount.optional().describe('正值偏暖，负值偏冷'),
  tint: amount.optional().describe('正值偏洋红，负值偏绿'),
  contrast: amount.optional(), shadows: amount.optional(), highlights: amount.optional(),
  whites: amount.optional(), blacks: amount.optional(), saturation: amount.optional(),
  protectNeutrals: z.number().min(0).max(100).optional().describe('减弱对低饱和区域的色彩改动，亮度调整照常'),
  curves: z.object({ rgb: curve.optional(), red: curve.optional(), green: curve.optional(), blue: curve.optional() }).optional()
    .describe('先用 rgb 总曲线调明暗，再用各通道曲线调色。x 为输入，y 为输出，均为 0–1'),
  hsl: z.partialRecord(z.enum(colorBands), bands).optional().describe('八个色带的色相、饱和度与明度调整'),
  colorWheels: z.object({ shadows: wheel.optional(), midtones: wheel.optional(), highlights: wheel.optional() }).optional()
    .describe('为阴影、中间调和高光分别上色，hue 取色轮角度，saturation 为力度')
})

export type ColorGrade = z.output<typeof colorGradeShape>
export const colorGrade = colorGradeShape.refine(hasColorGradeChanges, '请设置至少一项有效调色参数')
export type ColorBand = typeof colorBands[number]
export type CurvePoint = z.output<typeof curvePoint>
export type CurveChannel = keyof NonNullable<ColorGrade['curves']>
export type ColorZone = keyof NonNullable<ColorGrade['colorWheels']>
export type ColorValues = { rgb: [number, number, number]; luminance: number; saturation: number; darkClipping: number; lightClipping: number; pixelCount: number }
export type PhotoColors = {
  imageWidth: number; imageHeight: number
  histogram: { luminance: number[]; red: number[]; green: number[]; blue: number[] }
  summary: ColorValues
  samples: (ColorValues & { label: string })[]
}
