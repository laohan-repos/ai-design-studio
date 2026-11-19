import { z } from 'zod'

const id = z.string().trim().min(1).max(128)
const name = z.string().trim().min(1).max(100)

export const listArtworkGroupsInput = z.object({ canvasId: id })
export const createArtworkGroupInput = listArtworkGroupsInput.extend({ name })
export const deleteArtworkGroupInput = listArtworkGroupsInput.extend({ groupId: id })
export const renameArtworkGroupInput = deleteArtworkGroupInput.extend({ name })
export const reorderArtworkGroupsInput = listArtworkGroupsInput.extend({
  groupIds: z.array(id).refine(ids => new Set(ids).size === ids.length, '分组 ID 不能重复')
    .describe('画布中所有分组的 ID，按期望顺序排列'),
})
export const assignArtworksToGroupInput = listArtworkGroupsInput.extend({
  groupId: id.nullable().describe('分组 ID，传 null 将图片移回未分组'),
  artworkIds: z.array(id).min(1).max(512),
})

export const artworkGroupChangeInput = z.discriminatedUnion('type', [
  createArtworkGroupInput.extend({ type: z.literal('create') }),
  renameArtworkGroupInput.extend({ type: z.literal('rename') }),
  reorderArtworkGroupsInput.extend({ type: z.literal('reorder') }),
  deleteArtworkGroupInput.extend({ type: z.literal('delete') }),
  assignArtworksToGroupInput.extend({ type: z.literal('assign') }),
])

export type ArtworkGroupChangeInput = z.infer<typeof artworkGroupChangeInput>
export type ArtworkGroup = { id: string; name: string; artworkCount: number }
export type CanvasGrouping = { canvasId: string; groups: ArtworkGroup[]; ungroupedCount: number }
export type CanvasGroupingChange = CanvasGrouping & {
  groupId?: string
  assignment?: { groupId: string | null; artworkIds: string[] }
}
