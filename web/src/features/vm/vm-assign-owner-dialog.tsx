import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usersQueryOptions } from '@/features/users/queries'
import {
  assignableUsers,
  resolveOwnerUsername,
  vmOriginLabel,
} from '@/features/vm/vm-owner'

export function VmAssignOwnerDialog({
  vm,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  vm: Vm | null
  open: boolean
  pending?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (userId: string) => void
}) {
  const users = useQuery({
    ...usersQueryOptions(),
    enabled: open,
  })
  const options = assignableUsers(users.data?.items)
  const [userId, setUserId] = useState('')

  useEffect(() => {
    if (!open || !vm) return
    const list = assignableUsers(users.data?.items)
    const current = String(vm.owner_user_id || '').trim()
    if (current && list.some((u) => u.id === current)) {
      setUserId(current)
      return
    }
    setUserId(list[0]?.id || '')
  }, [open, vm?.id, vm?.owner_user_id, users.data?.items])

  const empty = !users.isLoading && options.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>分配给租户</DialogTitle>
          <DialogDescription>
            {vm ? (
              <>
                槽位 <span className='font-mono'>{vm.id}</span> · 当前{' '}
                {resolveOwnerUsername(vm.owner_user_id, users.data?.items)}（
                {vmOriginLabel(vm.origin)}）
              </>
            ) : (
              '选择要接收该槽位的租户账号'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className='space-y-2'>
          <Select
            value={userId}
            onValueChange={setUserId}
            disabled={pending || users.isLoading || empty}
          >
            <SelectTrigger aria-label='租户用户'>
              <SelectValue
                placeholder={
                  users.isLoading
                    ? '加载用户…'
                    : empty
                      ? '无可用租户'
                      : '选择用户'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {options.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.username}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {empty ? (
            <p className='text-xs text-muted-foreground'>
              请先在「用户」页创建启用的租户（role=user）账号。
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            disabled={pending || !userId}
            onClick={() => userId && onConfirm(userId)}
          >
            确认分配
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
