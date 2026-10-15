import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Undo2, UserRoundPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { usersQueryOptions } from '@/features/users/queries'
import { Field } from '@/features/vm/detail-section-primitives'
import { vmQueryOptions, vmsListQueryOptions } from '@/features/vm/queries'
import { VmAssignOwnerDialog } from '@/features/vm/vm-assign-owner-dialog'
import {
  canReclaimVm,
  patchVmOwner,
  resolveOwnerUsername,
  vmOriginLabel,
} from '@/features/vm/vm-owner'

/** 完整详情页（不在 VmActionsProvider 内）上的 admin 属主操作。 */
export function VmOwnerAdminCard({ vm }: { vm: Vm }) {
  const me = useQuery(meQueryOptions())
  const admin = me.data?.role === 'admin'
  const users = useQuery({
    ...usersQueryOptions(),
    enabled: admin,
    staleTime: 60_000,
  })
  const qc = useQueryClient()
  const [assignOpen, setAssignOpen] = useState(false)
  const [reclaimOpen, setReclaimOpen] = useState(false)

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
      qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const { mutate: setOwner, isPending } = useMutation({
    mutationFn: (user_id: string | null) => patchVmOwner(vm.id, user_id),
    onSuccess: async (_data, user_id) => {
      toast.success(user_id ? '已分配给租户' : '已收回进平台池')
      setAssignOpen(false)
      setReclaimOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (!admin) return null

  return (
    <>
      <Card>
        <CardHeader className='pb-2'>
          <CardTitle className='text-sm'>租户属主</CardTitle>
        </CardHeader>
        <CardContent className='space-y-3 pt-0'>
          <Field label='当前属主'>
            <span className='text-xs'>
              {resolveOwnerUsername(vm.owner_user_id, users.data?.items)}
            </span>
          </Field>
          <Field label='来源'>
            <span className='text-xs text-muted-foreground'>
              {vmOriginLabel(vm.origin)}
            </span>
          </Field>
          <div className='flex flex-wrap gap-2'>
            <Button
              size='sm'
              variant='outline'
              disabled={isPending}
              onClick={() => setAssignOpen(true)}
            >
              <UserRoundPlus /> 分配给租户
            </Button>
            {canReclaimVm(vm) ? (
              <Button
                size='sm'
                variant='outline'
                disabled={isPending}
                onClick={() => setReclaimOpen(true)}
              >
                <Undo2 /> 收回
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <VmAssignOwnerDialog
        vm={vm}
        open={assignOpen}
        pending={isPending}
        onOpenChange={setAssignOpen}
        onConfirm={(userId) => setOwner(userId)}
      />
      <ConfirmDialog
        open={reclaimOpen}
        onOpenChange={setReclaimOpen}
        title='收回槽位'
        desc={
          <>
            将把 <span className='font-mono'>{vm.id}</span>{' '}
            收回平台池，当前租户将不再看到该槽。
          </>
        }
        cancelBtnText='取消'
        confirmText='确认收回'
        destructive
        isLoading={isPending}
        handleConfirm={() => setOwner(null)}
      />
    </>
  )
}
