/**
 * 服务端数据变了以后草稿要不要跟着换。几块表单共用一份查询缓存时，
 * 别的块保存会改写缓存；本块有未保存改动就保留草稿，没改动才跟服务端同步。
 */
export function resyncDraft<D>(
  draft: D | null,
  base: D | null,
  next: D,
  differs: (a: D, b: D) => boolean
): D {
  if (draft === null || base === null) return next
  if (!differs(draft, base)) return next
  return differs(draft, next) ? draft : next
}
