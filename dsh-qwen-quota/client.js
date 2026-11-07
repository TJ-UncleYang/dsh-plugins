window.__ModuleLoader__.load({
  id: 'dsh-qwen-quota',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ZH = {
      label: '千问额度',
      remaining: '剩余 {percent}%',
      reset: '{date} 重置',
      loading: '千问额度 读取中',
      offline: '千问额度 读不到',
      hint: '点一下立即刷新',
      plan: '{plan} 套餐',
      days: '还剩 {days} 天',
    }

    const EN = {
      label: 'Qwen quota',
      remaining: '{percent}% left',
      reset: 'resets {date}',
      loading: 'Qwen quota: reading',
      offline: 'Qwen quota unavailable',
      hint: 'click to refresh',
      plan: '{plan} plan',
      days: '{days} days left',
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) =>
        values[key] === undefined || values[key] === null ? '' : String(values[key]),
      )
    }

    function shortDate(value) {
      if (typeof value !== 'string') return ''
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
      return match ? match[2] + '-' + match[3] : value
    }

    function QuotaPill({ t }) {
      const [data, setData] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)

      const tr = (key, fallback) => {
        try {
          const value = t(key)
          if (typeof value === 'string' && value.length > 0 && value !== key) return value
        } catch (error) {
          /* locale seat unavailable: fall through */
        }
        return fallback
      }

      const load = React.useCallback(async (force) => {
        setBusy(true)
        try {
          const response = await fetch('/dsh-qwen-quota' + (force ? '?refresh=1' : ''), {
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const next = await response.json()
          setData(next)
          setFailed(next.status === 'error')
        } catch (error) {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        let follow = null
        const tick = () => {
          // 每分钟让宿主侧现读一次千问页面，4 秒后再取回读到的结果；
          // 宿主自己还有一条低频的兜底刷新，这里不依赖它。
          void load(true)
          if (follow) clearTimeout(follow)
          follow = setTimeout(() => {
            follow = null
            void load(false)
          }, 4000)
        }
        tick()
        const timer = setInterval(tick, 60 * 1000)
        return () => {
          clearInterval(timer)
          if (follow) clearTimeout(follow)
        }
      }, [load])

      const percent = data && typeof data.percent === 'number' ? data.percent : null
      const plan = data && typeof data.plan === 'string' ? data.plan : null
      const days = data && typeof data.daysLeft === 'number' ? data.daysLeft : null
      const reset = data ? shortDate(data.resetAt) : ''

      const dotColor = failed
        ? 'var(--dsw-alias-state-idle-primary)'
        : percent === null
          ? 'var(--dsw-alias-state-idle-primary)'
          : percent >= 40
            ? 'var(--dsw-alias-state-success-primary)'
            : percent >= 15
              ? 'var(--dsw-alias-state-warn-primary)'
              : 'var(--dsw-alias-state-error-primary)'

      let text
      if (failed) text = tr('offline', '千问额度 读不到')
      else if (percent === null) text = tr('loading', '千问额度 读取中')
      else {
        const parts = [fill(tr('remaining', '剩余 {percent}%'), { percent })]
        if (reset) parts.push(fill(tr('reset', '{date} 重置'), { date: reset }))
        text = tr('label', '千问额度') + ' ' + parts.join(' · ')
      }

      const tipParts = []
      if (plan) tipParts.push(fill(tr('plan', '{plan} 套餐'), { plan }))
      if (days !== null) tipParts.push(fill(tr('days', '还剩 {days} 天'), { days }))
      if (data && data.updatedAt) {
        tipParts.push(new Date(data.updatedAt).toLocaleTimeString())
      }
      if (data && data.status === 'error' && data.error) tipParts.push(String(data.error))
      tipParts.push(tr('hint', '点一下立即刷新'))
      const tip = tipParts.filter(Boolean).join(' · ')

      return h(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          title: tip,
          onClick: () => {
            void load(true)
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              void load(true)
            }
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: '100%',
            padding: '0 2px',
            border: 'none',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            fontSize: 12,
            lineHeight: '18px',
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.7 : 1,
            whiteSpace: 'nowrap',
            userSelect: 'none',
          },
        },
        [
          h('span', {
            key: 'dot',
            style: {
              width: 6,
              height: 6,
              borderRadius: 3,
              flex: '0 0 auto',
              background: dotColor,
            },
          }),
          h(
            'span',
            {
              key: 'text',
              style: { fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis' },
            },
            text,
          ),
        ],
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposeZh = ctx.locale.register('dsh-qwen-quota', 'zh', ZH)
          const disposeEn = ctx.locale.register('dsh-qwen-quota', 'en', EN)
          return () => {
            disposeZh()
            disposeEn()
          }
        })

        const t = ctx.locale.bind('dsh-qwen-quota')

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'qwen-quota', order: 6 },
            () => h(QuotaPill, { t }),
          ),
        )
      },
    }
  },
})
