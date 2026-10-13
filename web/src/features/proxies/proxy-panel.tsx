import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * 代理页的分区容器。只用描边做层级（不叠阴影），和舰队脉搏同一套语言：
 * 页面上的卡片都是「一块工作面」，不是浮起来的装饰。
 *
 * `plain`：放进抽屉时用，抽屉标题已经说明是什么，不再套一层卡片和标题。
 */
export function ProxyPanel({
  title,
  meta,
  plain = false,
  className,
  children,
}: {
  title: string
  meta?: React.ReactNode
  plain?: boolean
  className?: string
  children: React.ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn(!plain && 'rounded-xl border bg-card p-4', className)}
    >
      <div
        className={cn(
          'mb-3 flex items-center justify-between gap-2',
          plain && !meta && 'sr-only'
        )}
      >
        <h3
          id={id}
          className={cn(
            'text-sm font-semibold tracking-[-0.01em]',
            plain && 'sr-only'
          )}
        >
          {title}
        </h3>
        {meta}
      </div>
      {children}
    </section>
  )
}
