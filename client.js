/**
 * deep-fish-pond —— 浏览器半端：右下角那个「大肥鱼塘」
 * ============================================================================
 * ⭐ 2026-10-24 重构：**不再烘焙卡片图片**。
 *    以前是把台词画进 PNG/WebP，字号一改就得重绘、旧图还排在队列前面——
 *    使用者连着几次觉得「怎么调字都没变」。现在宿主只记文字，排版全在这里实时做：
 *    字号是 CSS，改完立刻生效，不产生任何文件。
 *
 * ⭐ 对话框规则（使用者明确要求）：
 *    · 不许挡住小鲸鱼 —— 气泡挂在鲸鱼**左/右侧外面**，不压在它身上；
 *    · 允许超出鱼塘这一格的边界（气泡本来就要比 200px 的框宽）。
 *
 * ⭐ 其它：左键拖动、右键菜单（说精选 / 说评论 / 悬浮 / 设置 / 退出）。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'deep-fish-pond',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = `${location.origin}/api/deep-fish-pond`
    const SIZE = 200          // 鲸鱼那一格
    const GAP = 16
    const CLEAR = 12
    const LINE_MS = 18_000    // 一句台词放多久
    const IDLE_GAP_MS = 45_000 // 静了这么久还没新台词，就自己挑一句说
    const SWAP_MS = 7_000     // idle ↔ swim
    const FADE = '.45s'
    const POS_KEY = 'deep-fish-pond.pos'
    const NAVY = '#1a2440'

    function findSendButton() {
      let best = null
      const list = document.querySelectorAll('button[aria-label], button[title], button[type="submit"]')
      for (const b of list) {
        const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')
        if (/发送|send/i.test(label)) return b
        if (!best && b.getAttribute('type') === 'submit') best = b
      }
      return best
    }

    /* ────────────── 台词队列（纯文字） ────────────── */

    function usePondMedia() {
      const [line, setLine] = React.useState(null)
      const [queue, setQueue] = React.useState([])
      const [loop, setLoop] = React.useState('idle')
      const cursor = React.useRef(null)
      const timer = React.useRef(null)
      const pool = React.useRef([])          // 今天所有能说的台词，空闲时自己轮着说
      const turn = React.useRef(0)
      const lastEnd = React.useRef(Date.now())

      const endLine = () => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        setLine(null)
        lastEnd.current = Date.now()
        setLoop((v) => (v === 'idle' ? 'swim' : 'idle'))
      }

      const say = (item) => {
        setLine({
          seq: item.seq,
          text: String(item.text || ''),
          kind: item.kind,
          title: String(item.title || ''),
          tag: String(item.tag || ''),
        })
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(endLine, LINE_MS)
      }

      React.useEffect(() => {
        const t = setInterval(() => setLoop((v) => (v === 'idle' ? 'swim' : 'idle')), SWAP_MS)
        return () => clearInterval(t)
      }, [])

      /* 台词池：拿一次，之后每 5 分钟刷新（日报/评论都可能变） */
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const d = await (await fetch(API + '/cards?kind=digest&limit=50', { credentials: 'same-origin' })).json()
            if (alive && d && Array.isArray(d.cards)) pool.current = d.cards
          } catch { /* 忽略 */ }
        }
        load()
        const iv = setInterval(load, 300_000)
        return () => { alive = false; clearInterval(iv) }
      }, [])

      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const q = cursor.current === null ? '' : '?since=' + cursor.current
            const r = await fetch(API + '/status' + q, { credentials: 'same-origin' })
            const d = await r.json()
            if (!alive || !d || typeof d.seq !== 'number') return
            if (cursor.current === null) { cursor.current = d.seq; return }
            const fresh = (d.cards || []).filter((c) => c && c.text)
            if (fresh.length) {
              cursor.current = d.seq
              setQueue((old) => old.concat(fresh).slice(-12))
            }
          } catch { /* 宿主没起来就只显示鲸鱼 */ }
        }
        tick()
        const iv = setInterval(tick, 4000)
        return () => { alive = false; clearInterval(iv) }
      }, [])

      React.useEffect(() => {
        if (line || !queue.length) return
        const next = queue[0]
        setQueue((old) => old.slice(1))
        say(next)
      }, [line, queue])

      /* ⭐ 自己说：没人点菜单、也不再有新台词的时候，隔一会儿自己挑一句说。
         否则鱼塘永远是哑的，只能靠右键——那是工具，不是宠物。 */
      React.useEffect(() => {
        const t = setInterval(() => {
          if (line || queue.length) return
          if (Date.now() - lastEnd.current < IDLE_GAP_MS) return
          const list = pool.current
          if (!list.length) return
          turn.current = (turn.current + 1) % list.length
          say(list[turn.current])
        }, 5000)
        return () => clearInterval(t)
      }, [line, queue])

      const enqueueList = (items) => {
        const list = (items || []).filter((c) => c && c.text)
        if (!list.length) return false
        if (timer.current) { clearTimeout(timer.current); timer.current = null }
        setLine(null)
        setQueue(list.slice(-12))
        return true
      }

      return { line, loop, playing: Boolean(line), enqueueList }
    }

    /* ────────────── 小鲸鱼 + 对话框 ────────────── */

    const whaleLayer = (visible) => ({
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      display: 'block',
      opacity: visible ? 1 : 0,
      transition: `opacity ${FADE} ease`,
      pointerEvents: 'none',
      userSelect: 'none',
      WebkitUserDrag: 'none',
    })

    function Whale({ media }) {
      // ⚠️ 只看 loop，不看 playing。
      //    旧逻辑是「播卡片时把鲸鱼藏起来」，因为卡片图里本来就画着鲸鱼；
      //    现在台词是叠上去的气泡，鲸鱼必须一直露着——否则气泡一出现，人和池塘全没了。
      return [
        h('img', { key: 'idle', src: API + '/asset/idle', alt: '', draggable: false, style: whaleLayer(media.loop === 'idle') }),
        h('img', { key: 'swim', src: API + '/asset/swim', alt: '', draggable: false, style: whaleLayer(media.loop === 'swim') }),
      ]
    }

    /** 气泡：贴在鲸鱼左侧或右侧外面，绝不压住它。
     *  ⚠️ 必须给**明确的 width**：气泡是绝对定位、挂在 200px 的容器外面，
     *    若只写 maxWidth，浏览器会按「容器宽度 - 偏移」算可用宽度（负数），
     *    于是被压成一条很窄的竖条 —— 就是「对话框太窄」的原因。 */
    function Bubble({ line, fontPx, side, width }) {
      if (!line) return null

      // 精选用「标题：… 挡位：…」，挡位标红；评论保持原话。
      // 两段共用同一个 fontSize，所以字一样大。
      const parts = []
      if (line.kind === 'digest' && line.title) {
        parts.push({ text: '标题：' + line.title })
        if (line.tag) {
          parts.push({ text: '　挡位：' })
          parts.push({ text: line.tag, red: true })
        }
      } else if (line.text) {
        parts.push({ text: line.text })
      }
      if (!parts.length) return null

      const box = {
        position: 'absolute',
        top: '14px',
        width: (width || 320) + 'px',
        minWidth: '120px',
        padding: '8px 11px',
        borderRadius: '12px',
        background: '#ffffff',
        color: NAVY,
        border: `2px solid ${NAVY}`,
        boxShadow: '0 10px 22px rgba(0,0,0,.28)',
        fontSize: fontPx + 'px',
        lineHeight: 1.38,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        pointerEvents: 'none',
        zIndex: 2,
      }
      if (side === 'left') box.right = (SIZE + 14) + 'px'
      else box.left = (SIZE + 14) + 'px'

      const tail = {
        position: 'absolute',
        top: '22px',
        width: '13px',
        height: '13px',
        background: '#ffffff',
        borderTop: `2px solid ${NAVY}`,
        borderRight: `2px solid ${NAVY}`,
        transform: 'rotate(45deg)',
      }
      if (side === 'left') { tail.right = '-8px'; tail.transform = 'rotate(45deg)' }
      else { tail.left = '-8px'; tail.transform = 'rotate(225deg)' }

      return h('div', { style: box },
        h('div', { style: tail }),
        parts.map((p, i) => h('span', {
          key: i,
          style: p.red ? { color: '#e53935', fontWeight: 700 } : undefined,
        }, p.text)),
      )
    }

    /* ────────────── 应用内悬浮（退路） ────────────── */

    function InlineFloat({ onClose, fontPx }) {
      const media = usePondMedia()
      const [pos, setPos] = React.useState(() => ({
        x: Math.max(8, window.innerWidth - SIZE - 120),
        y: Math.max(8, window.innerHeight - SIZE - 160),
      }))

      const onDown = (e) => {
        e.preventDefault()
        const start = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
        const move = (ev) => setPos({
          x: Math.max(0, Math.min(window.innerWidth - SIZE, ev.clientX - start.dx)),
          y: Math.max(0, Math.min(window.innerHeight - 28, ev.clientY - start.dy)),
        })
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      return h('div', {
        style: {
          position: 'fixed',
          left: pos.x + 'px',
          top: pos.y + 'px',
          width: SIZE + 'px',
          height: (SIZE + 24) + 'px',
          zIndex: 45,
          background: 'var(--dsw-alias-bg-layer-1, rgba(28,30,36,.96))',
          border: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.35))',
          borderRadius: '12px',
          boxShadow: '0 16px 36px rgba(0,0,0,.45)',
          pointerEvents: 'auto',
        },
      },
        h('div', {
          onPointerDown: onDown,
          style: {
            height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '0 8px', cursor: 'move', fontSize: '11px', userSelect: 'none',
            color: 'var(--dsw-alias-label-secondary, #c3c8ce)',
            background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.06))',
          },
        },
          h('span', null, '大肥鱼塘'),
          h('button', { onClick: onClose, style: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '13px', lineHeight: 1 } }, '✕')),
        h('div', { style: { position: 'relative', width: '100%', height: SIZE + 'px' } },
          h(Whale, { media }),
          h(Bubble, { line: media.line, fontPx, side: pos.x > 330 ? 'left' : 'right', width: 300 })),
      )
    }

    /* ────────────── 主组件 ────────────── */

    function Pond() {
      const media = usePondMedia()
      const [pos, setPos] = React.useState({ x: 0, y: 0 })
      const manual = React.useRef((() => {
        try {
          const v = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
          return v && typeof v.x === 'number' && typeof v.y === 'number' ? v : null
        } catch { return null }
      })())
      const [menu, setMenu] = React.useState(null)
      const [hidden, setHidden] = React.useState(false)
      const [floating, setFloating] = React.useState(false)
      const [inline, setInline] = React.useState(false)
      const [dragging, setDragging] = React.useState(false)
      const [toast, setToast] = React.useState('')
      const [panel, setPanel] = React.useState(null)
      const [fontPx, setFontPx] = React.useState(15)

      const say = (text) => {
        setToast(text)
        window.setTimeout(() => setToast((cur) => (cur === text ? '' : cur)), 2600)
      }

      React.useEffect(() => {
        try { fetch(API + '/diag?stage=client-rendered', { credentials: 'same-origin' }).catch(() => {}) } catch { /* 无所谓 */ }
        fetch(API + '/settings', { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d) => { if (d && typeof d.bubbleFontPx === 'number') setFontPx(d.bubbleFontPx) })
          .catch(() => {})
      }, [])

      /* 定位 */
      React.useEffect(() => {
        const place = () => {
          if (manual.current) {
            const m = manual.current
            setPos({
              x: Math.max(0, Math.min(window.innerWidth - SIZE, m.x)),
              y: Math.max(0, Math.min(window.innerHeight - SIZE, m.y)),
            })
            return
          }
          let right = GAP
          let bottom = GAP
          const send = findSendButton()
          if (send && typeof send.getBoundingClientRect === 'function') {
            const r = send.getBoundingClientRect()
            const box = { l: window.innerWidth - right - SIZE, t: window.innerHeight - bottom - SIZE, r: window.innerWidth - right, b: window.innerHeight - bottom }
            const safe = { l: r.left - CLEAR, t: r.top - CLEAR, r: r.right + CLEAR, b: r.bottom + CLEAR }
            const hit = !(box.r <= safe.l || box.l >= safe.r || box.b <= safe.t || box.t >= safe.b)
            if (hit) {
              const lift = window.innerHeight - safe.t + CLEAR
              if (lift + SIZE <= window.innerHeight - GAP) bottom = lift
              else right = window.innerWidth - safe.l + CLEAR
            }
          }
          setPos({
            x: Math.round(window.innerWidth - Math.max(GAP, right) - SIZE),
            y: Math.round(window.innerHeight - Math.max(GAP, bottom) - SIZE),
          })
        }
        place()
        window.addEventListener('resize', place)
        const t = setInterval(place, 1200)
        return () => { window.removeEventListener('resize', place); clearInterval(t) }
      }, [])

      /* 拖动 */
      const dragHandlers = React.useRef(null)
      const startDrag = (e) => {
        if (e.button !== 0) return
        // 菜单开着的时候，点鱼塘/人物 = 关菜单，而不是开始拖
        if (menu) { setMenu(null); return }
        e.preventDefault()
        if (dragHandlers.current) {
          window.removeEventListener('pointermove', dragHandlers.current.move)
          window.removeEventListener('pointerup', dragHandlers.current.up)
        }
        const start = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
        setDragging(true)
        const move = (ev) => {
          if (move.pending) return
          move.pending = true
          const cx = ev.clientX
          const cy = ev.clientY
          window.requestAnimationFrame(() => {
            move.pending = false
            const nx = Math.max(0, Math.min(window.innerWidth - SIZE, cx - start.dx))
            const ny = Math.max(0, Math.min(window.innerHeight - SIZE, cy - start.dy))
            manual.current = { x: Math.round(nx), y: Math.round(ny) }
            setPos({ x: Math.round(nx), y: Math.round(ny) })
          })
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          dragHandlers.current = null
          setDragging(false)
          try { localStorage.setItem(POS_KEY, JSON.stringify(manual.current)) } catch { /* 无所谓 */ }
        }
        dragHandlers.current = { move, up }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }

      /* 菜单关掉 */
      React.useEffect(() => {
        if (!menu) return
        const close = () => setMenu(null)
        const onKey = (e) => { if (e.key === 'Escape') close() }
        window.addEventListener('keydown', onKey)
        window.addEventListener('wheel', close, { passive: true })
        return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('wheel', close) }
      }, [menu])

      /* 桌面窗关了就把鱼塘收回来 */
      React.useEffect(() => {
        if (!floating) return
        let alive = true
        const tick = async () => {
          try {
            const d = await (await fetch(API + '/float', { credentials: 'same-origin' })).json()
            if (alive && d && d.running === false) setFloating(false)
          } catch { /* 忽略 */ }
        }
        tick()
        const iv = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(iv) }
      }, [floating])

      const replay = async (kind, label) => {
        setMenu(null)
        try {
          const r = await fetch(`${API}/cards?kind=${kind}&limit=20`, { credentials: 'same-origin' })
          const d = await r.json()
          if (!d || !d.ok || !d.cards || !d.cards.length) { say(`今天还没有${label}`); return }
          media.enqueueList(d.cards)
          say(`重放${label} · ${d.cards.length} 句`)
        } catch (e) { say('取台词失败：' + String(e?.message ?? e)) }
      }

      const startFloatRequest = async () => {
        const r = await fetch(API + '/float?action=start', { method: 'POST', credentials: 'same-origin' })
        return r.json()
      }

      const waitSetupReady = async (rounds) => {
        for (let i = 0; i < rounds; i += 1) {
          await new Promise((r) => setTimeout(r, 3000))
          try {
            const s = await (await fetch(API + '/setup', { credentials: 'same-origin' })).json()
            if (s && s.ready) return true
          } catch { /* 继续等 */ }
        }
        return false
      }

      const floatToDesktop = async () => {
        setMenu(null)
        try {
          let d = await startFloatRequest()
          if (d && d.ok && d.running) { setFloating(true); say('桌面鱼塘已弹出（右键它可关闭）'); return }

          // 桌面窗要 Python + Pillow：没装就现场装一次（插件自己的 venv）
          if (d && d.ready === false) {
            say('桌面环境还没装，正在装（一次性，约一分钟）…')
            await fetch(API + '/setup', { method: 'POST', credentials: 'same-origin' })
            if (!(await waitSetupReady(40))) { say('装失败了，右键 → 设置 里有日志'); return }
            d = await startFloatRequest()
            if (d && d.ok && d.running) { setFloating(true); say('装好了，桌面鱼塘已弹出'); return }
          }
        } catch { /* 下一档 */ }
        setInline(true)
        say('开不了独立窗口，已切成应用内悬浮')
      }

      const dockBack = async () => {
        setMenu(null)
        try {
          await fetch(API + '/float?action=stop', { method: 'POST', credentials: 'same-origin' })
          setFloating(false)
          say('已收回 DSH')
        } catch (e) { say('收回失败：' + String(e?.message ?? e)) }
      }

      const openSettings = async () => {
        setMenu(null)
        let px = fontPx
        try {
          const d = await (await fetch(API + '/settings', { credentials: 'same-origin' })).json()
          if (d && typeof d.bubbleFontPx === 'number') px = d.bubbleFontPx
        } catch { /* 用当前值 */ }
        setPanel({ bubbleFontPx: px })
      }

      const saveSettings = async () => {
        const px = Math.max(10, Math.min(34, Math.round(panel?.bubbleFontPx || fontPx)))
        setFontPx(px)          // 立刻生效，不用等保存
        try {
          const d = await (await fetch(API + '/settings', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bubbleFontPx: px }),
          })).json()
          if (d && d.ok) { setPanel(null); say(`字号已保存：${d.bubbleFontPx}px`) }
          else say('保存失败')
        } catch (e) { say('保存失败：' + String(e?.message ?? e)) }
      }

      const item = (label, onClick) => h('button', {
        key: label,
        onClick,
        style: {
          display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px',
          border: '0', borderRadius: '7px', background: 'transparent', color: 'inherit',
          font: 'inherit', cursor: 'pointer',
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.22))' },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent' },
      }, label)

      if (inline) {
        return h(InlineFloat, { onClose: () => setInline(false), fontPx })
      }

      const compact = hidden || floating
      // 气泡宽度：屏幕够宽就给 340，窄屏按可用空间收，最少 200
      const bubbleWidth = Math.min(340, Math.max(200, window.innerWidth - SIZE - 48))
      const bubbleSide = pos.x > bubbleWidth + 30 ? 'left' : 'right'

      return h('div', {
        onPointerDown: compact ? undefined : startDrag,
        onContextMenu: (e) => {
          e.preventDefault()
          e.stopPropagation()
          try { fetch(API + '/diag?stage=menu-open', { credentials: 'same-origin' }).catch(() => {}) } catch { /* 无所谓 */ }
          setMenu({
            x: Math.min(e.clientX, window.innerWidth - 164),
            y: Math.min(e.clientY, window.innerHeight - 190),
          })
        },
        title: compact ? '大肥鱼塘（右键菜单 / 点一下恢复）' : '左键拖动 · 右键菜单',
        style: {
          position: 'fixed',
          left: pos.x + 'px',
          top: pos.y + 'px',
          width: (compact ? 30 : SIZE) + 'px',
          height: (compact ? 30 : SIZE) + 'px',
          zIndex: 40,
          background: 'transparent',
          cursor: compact ? 'pointer' : 'grab',
          pointerEvents: 'auto',
        },
      },
        compact
          ? h('div', {
            onClick: () => { if (floating) dockBack(); else setHidden(false) },
            style: {
              width: '30px', height: '30px', borderRadius: '50%',
              border: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.35))',
              background: 'var(--dsw-alias-bg-layer-2, rgba(40,42,48,.9))',
              color: 'var(--dsw-alias-label-secondary, #cfd3d8)',
              fontSize: '15px', lineHeight: '30px', textAlign: 'center',
              opacity: 0.75, userSelect: 'none',
            },
          }, '🐟')
          : h('div', {
            style: { position: 'absolute', inset: '0', filter: dragging ? 'none' : 'drop-shadow(0 10px 18px rgba(0,0,0,.28))', pointerEvents: 'none' },
          }, h(Whale, { media })),

        !compact && media.line && media.line.text
          ? h(Bubble, { line: media.line, fontPx, side: bubbleSide, width: bubbleWidth })
          : null,

        toast ? h('div', {
          style: {
            position: 'absolute', left: '50%', bottom: 'calc(100% + 6px)', transform: 'translateX(-50%)',
            whiteSpace: 'nowrap', fontSize: '11px', padding: '4px 9px', borderRadius: '8px',
            background: 'var(--dsw-alias-bg-layer-1, rgba(30,32,38,.95))',
            color: 'var(--dsw-alias-label-primary, #e8eaed)',
            border: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.3))',
            pointerEvents: 'none',
          },
        }, toast) : null,

        menu ? h('div', {
          style: { position: 'fixed', inset: '0', zIndex: 59 },
          // 用 pointerdown 而不是 mousedown：容器上的 startDrag 会 preventDefault，
          // 那样 mousedown 根本不会派发，点鱼塘就关不掉菜单了。
          onPointerDown: (e) => { e.stopPropagation(); setMenu(null) },
          onContextMenu: (e) => { e.preventDefault(); e.stopPropagation(); setMenu(null) },
        }) : null,

        menu ? h('div', {
          style: {
            position: 'fixed', left: menu.x + 'px', top: menu.y + 'px', width: '152px', zIndex: 60,
            padding: '4px', borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-1, rgba(32,34,40,.98))',
            color: 'var(--dsw-alias-label-primary, #e8eaed)',
            border: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.32))',
            boxShadow: '0 12px 28px rgba(0,0,0,.45)', fontSize: '12px',
          },
          onPointerDown: (e) => e.stopPropagation(),
          onMouseDown: (e) => e.stopPropagation(),
        },
          item('说精选', () => replay('digest', '精选')),
          item('说评论', () => replay('comment', '评论')),
          item(floating ? '悬浮于 DSH' : '悬浮于桌面', floating ? dockBack : floatToDesktop),
          item('设置', openSettings),
          item('退出', () => { setMenu(null); setHidden(true) }),
        ) : null,

        panel ? h('div', {
          style: {
            position: 'fixed',
            left: Math.max(8, Math.min(window.innerWidth - 224, pos.x)) + 'px',
            top: Math.max(8, (pos.y > 220 ? pos.y - 200 : pos.y + SIZE + 10)) + 'px',
            width: '216px', zIndex: 60, padding: '10px', borderRadius: '10px',
            background: 'var(--dsw-alias-bg-layer-1, rgba(32,34,40,.98))',
            color: 'var(--dsw-alias-label-primary, #e8eaed)',
            border: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.32))',
            boxShadow: '0 12px 28px rgba(0,0,0,.45)', fontSize: '12px', pointerEvents: 'auto',
          },
          onMouseDown: (e) => e.stopPropagation(),
        },
          h('div', { style: { opacity: 0.72, fontSize: '11px' } }, '对话框字号（实时）'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0' } },
            h('button', {
              onClick: () => setPanel((p) => {
                const v = Math.max(10, (p?.bubbleFontPx || fontPx) - 1)
                setFontPx(v)
                return { ...p, bubbleFontPx: v }
              }),
              style: { width: '30px', height: '26px', border: 0, borderRadius: '7px', background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08))', color: 'inherit', cursor: 'pointer', font: 'inherit' },
            }, '−'),
            h('div', { style: { minWidth: '50px', textAlign: 'center', fontSize: '15px' } }, String(panel.bubbleFontPx) + 'px'),
            h('button', {
              onClick: () => setPanel((p) => {
                const v = Math.min(34, (p?.bubbleFontPx || fontPx) + 1)
                setFontPx(v)
                return { ...p, bubbleFontPx: v }
              }),
              style: { width: '30px', height: '26px', border: 0, borderRadius: '7px', background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.08))', color: 'inherit', cursor: 'pointer', font: 'inherit' },
            }, '+'),
          ),
          h('div', { style: { opacity: 0.55, fontSize: '10px', lineHeight: '14px' } },
            '调整时实时预览；点保存写进设置，下次打开还是这个字号。'),
          h('div', { style: { display: 'flex', gap: '6px', marginTop: '10px' } },
            h('button', { onClick: saveSettings, style: { flex: 1, padding: '6px 0', border: 0, borderRadius: '7px', background: '#3b82f6', color: '#fff', cursor: 'pointer', font: 'inherit' } }, '保存'),
            h('button', { onClick: () => setPanel(null), style: { padding: '6px 10px', border: 0, borderRadius: '7px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', opacity: 0.7 } }, '关闭'),
          ),
          h('div', { style: { borderTop: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.25))', marginTop: '10px', paddingTop: '8px' } },
            h('div', { style: { opacity: 0.72, fontSize: '11px' } }, '桌面悬浮窗（Python + Pillow）'),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } },
              h('button', {
                onClick: async () => {
                  say('开始装桌面环境…')
                  try {
                    await fetch(API + '/setup', { method: 'POST', credentials: 'same-origin' })
                  } catch { /* 忽略 */ }
                },
                style: { flex: 1, padding: '6px 0', border: '1px solid var(--dsw-alias-bg-layer-3, rgba(127,127,127,.35))', borderRadius: '7px', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
              }, '安装 / 重装'),
            ),
            h('div', { style: { opacity: 0.5, fontSize: '10px', lineHeight: '14px', marginTop: '4px' } },
              '装一次就够；日志在 ~/.dsh/deep-fish-pond/setup.log'),
          ),
        ) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        const ping = (stage) => { try { fetch(`${API}/diag?stage=${encodeURIComponent(stage)}`, { credentials: 'same-origin' }).catch(() => {}) } catch { /* 无所谓 */ } }
        ping('client-applied:' + (slots ? 'slots-ok' : 'no-slots'))
        if (!slots) return
        slots.inject('shell.overlay', () => {
          ping('slot-injected')
          return slots.register(
            { name: 'shell.overlay', id: 'deep-fish-pond', order: 60, label: '大肥鱼塘' },
            () => h(Pond),
          )
        })
      },
    }
  },
})
