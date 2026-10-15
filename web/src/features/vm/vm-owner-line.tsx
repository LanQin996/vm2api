import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { meQueryOptions } from '@/features/auth/queries'
import { usersQueryOptions } from '@/features/users/queries'
import { resolveOwnerUsername, vmOriginLabel } from '@/features/vm/vm-owner'

/** Admin-only：列表 / 卡片上的租户属主读数。 */
export function VmOwnerLine({ vm, className }: { vm: Vm; className?: string }) {
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'admin'
  const users = useQuery({
    ...usersQueryOptions(),
    enabled: admin,
    staleTime: 60_000,
  })
  if (!admin) return null
  const label = resolveOwnerUsername(vm.owner_user_id, users.data?.items)
  const origin = vmOriginLabel(vm.origin)
  return (
    <p className={className} title={`来源：${origin}`}>
      租户 {label}
      <span className='text-muted-foreground'> · {origin}</span>
    </p>
  )
}
