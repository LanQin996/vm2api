import { Skeleton } from '@/components/ui/skeleton'

/** 对应：状态分区总览 → 工具行 → 一台机架（头部 + 一段刀片）。默认视图是机架·大。 */
export function VmListSkeleton() {
  return (
    <div>
      <Skeleton className='mb-3 h-[92px] w-full rounded-xl' />
      <div className='mb-4 flex flex-wrap items-center gap-2'>
        <Skeleton className='h-8 w-16 rounded-md' />
        <Skeleton className='h-8 w-16 rounded-md' />
        <Skeleton className='h-8 w-64 rounded-md' />
        <div className='ms-auto flex gap-2'>
          <Skeleton className='h-8 w-28 rounded-md' />
          <Skeleton className='h-8 w-24 rounded-md' />
          <Skeleton className='h-8 w-20 rounded-md' />
        </div>
      </div>
      <div className='rounded-xl border'>
        <div className='flex items-center gap-6 border-b px-4 py-3'>
          <Skeleton className='h-9 w-40 rounded-md' />
          <Skeleton className='h-3 flex-1 rounded-full' />
          <Skeleton className='h-9 w-48 rounded-md' />
        </div>
        <div className='grid grid-cols-[repeat(auto-fill,minmax(min(100%,380px),1fr))] gap-2 p-3'>
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className='h-[268px] rounded-[10px]' />
          ))}
        </div>
      </div>
    </div>
  )
}
