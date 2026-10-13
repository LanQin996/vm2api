import { useMutation } from '@tanstack/react-query'
import { Activity, Globe } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useRefreshProxies } from './queries'

/** 整池测通 / 测地理。天天用的两下，放在页头而不是收进设置抽屉。 */
export function ProxyBulkActions({ empty }: { empty: boolean }) {
  const refresh = useRefreshProxies()
  const probeAll = useMutation({
    mutationFn: () => api('/api/panel/proxies/probe', { method: 'POST' }),
    onSuccess: async () => {
      toast.success('代理探测完成')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const geoAll = useMutation({
    mutationFn: () =>
      api<{ results?: { ok?: boolean }[] }>('/api/panel/proxies/geo', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      }),
    onSuccess: async (data) => {
      const rows = data.results || []
      const ok = rows.filter((r) => r.ok).length
      toast.success(`地理检测完成 ${ok}/${rows.length}`)
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <>
      <Button
        variant='outline'
        size='sm'
        onClick={() => probeAll.mutate()}
        disabled={probeAll.isPending || empty}
        loading={probeAll.isPending}
        title='只测 SOCKS TCP，不打 Anthropic'
      >
        <Activity aria-hidden='true' />
        全部测通
      </Button>
      <Button
        variant='outline'
        size='sm'
        onClick={() => geoAll.mutate()}
        disabled={geoAll.isPending || empty}
        loading={geoAll.isPending}
        title='经每条代理查出口 IP 的国家 / 城市 / 时区'
      >
        <Globe aria-hidden='true' />
        全部测地理
      </Button>
    </>
  )
}
