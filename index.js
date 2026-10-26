/**
 * deep-fish-pond —— 把「刷B站」发出去的那句评论，画到鲸鱼娘身上
 * ============================================================================
 * 它不改 dsh-bili-scroll 的一行代码，只吃它留下的稳定产物：
 *   <DSH_HOME>/bili-duty/seen.md 的「## 评论记录」表格
 *   一行 = 一条真发出去的评论（BV / rpid / root / 时间 / 正文前 20 字）
 *
 * 流程：
 *   1. 盯 seen.md（fs.watch + 去抖）→ 解析出新增的 rpid
 *   2. 用登录态把这条评论的**正文**拉回来（拿不到就用表里的 20 字预览）
 *   3. 渲染 20 秒 MP4 + 静态 PNG（Pillow 排版 / ffmpeg 合成，素材已去「豆包 AI 生成」水印）
 *   4. 展示槽位只有 20 秒：这 20 秒里再来新评论，直接记「跳过」，不排队、不补画
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, watch, statSync, createReadStream, readdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = 'deep-fish-pond'
export const inject = ['tools', 'webServer']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const BILI_HOME = join(DSH_HOME, 'bili-duty')
const SEEN_FILE = join(BILI_HOME, 'seen.md')
const ART_HOME = join(BILI_HOME, 'art')
const OUT_HOME = join(BILI_HOME, 'out')
const STATE_FILE = join(ART_HOME, 'state.json')
const SETTINGS_FILE = join(ART_HOME, 'settings.json')
const LOG_FILE = join(ART_HOME, 'art.log')

const SLOT_MS = 20_000          // 一条评论占住画面 20 秒
const DEBOUNCE_MS = 400
const BUILD = '2026-10-26c'    // 每次改宿主就换一下，方便看日志确认版本

const BV_RE = /BV[0-9A-Za-z]{10}/
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const readJson = (file, fallback) => {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

/**
 * 设置：气泡字号（浏览器里的 CSS 像素，实时生效）。
 * 以前存的是「卡片字号」，那套已经废了——不再烘焙图片。
 */
const readSettings = () => {
  const raw = readJson(SETTINGS_FILE, {})
  if (typeof raw.bubbleFontPx === 'number' && Number.isFinite(raw.bubbleFontPx)) {
    return { bubbleFontPx: raw.bubbleFontPx }
  }
  return { bubbleFontPx: 15 }
}

/** 这条记录能不能说出口：精选用「标题＋挡位」，评论用原话 */
const hasSayable = (r) => (r.kind === 'digest' ? Boolean(r.text && r.title) : Boolean(r.text))
const writeJson = (file, value) => {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch (e) { log(`写不进去 ${file}：${e?.message ?? e}`) }
}
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function log(line) {
  const text = `${new Date().toISOString()}  ${line}`
  try {
    mkdirSync(ART_HOME, { recursive: true })
    appendFileSync(LOG_FILE, text + '\n', 'utf8')
  } catch { /* 日志写不了也不能拖垮插件 */ }
}

/** 从判重表里抠出「## 评论记录」这一段的行 */
export function parseCommentRows(markdown) {
  const rows = []
  let inside = false
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('## ')) {
      inside = line.includes('评论记录')
      continue
    }
    if (!inside || !line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    const bv = BV_RE.exec(cells[0])?.[0]
    const rpid = /^\d{6,}$/.test(cells[1]) ? Number(cells[1]) : 0
    if (!bv || !rpid) continue
    rows.push({
      bv,
      rpid,
      root: /^\d{6,}$/.test(cells[2] || '') ? Number(cells[2]) : 0,
      at: cells[3] || '',
      preview: cells[4] || '',
    })
  }
  return rows
}

/** 从日报里抠出「### BVxxx」块，卡上写「我的一句话」（没有就退回标题） */
export function parseReportBlocks(markdown) {
  const out = []
  let cur = null
  for (const raw of String(markdown).split(/\r?\n/)) {
    const line = raw.trim()
    const head = /^###\s+(BV[0-9A-Za-z]{10})\s*$/.exec(line)
    if (head) { cur = { bv: head[1], title: '', line: '', tag: '' }; out.push(cur); continue }
    if (line.startsWith('## ') || line.startsWith('# ')) { cur = null; continue }
    if (!cur) continue
    const kv = /^-\s*([^：:]{1,12})[：:]\s*(.+)$/.exec(line)
    if (!kv) continue
    const k = kv[1].trim().replace(/\*/g, '')
    const v = kv[2].trim().replace(/^\*\*/, '').replace(/\*\*$/, '')
    if (k === '标题') cur.title = v
    else if (k === '我的一句话') cur.line = v
    else if (k === '档位') cur.tag = v
  }
  return out
    .map((b) => ({ bv: b.bv, title: b.title, tag: b.tag, text: b.line || b.title }))
    .filter((b) => b.text)
}

/* ───────────── 取评论正文（和 dsh-bili-scroll 的复核用同一套只读接口） ───────────── */

function credential() {
  const file = join(BILI_HOME, 'bili_credential.json')
  if (!existsSync(file)) return null
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'))
    return c?.sessdata ? c : null
  } catch { return null }
}

function headersFor(cred) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    Referer: 'https://www.bilibili.com/',
    Cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}`,
  }
}

async function jget(url, headers) {
  try {
    const r = await fetch(url, { headers })
    const t = await r.text()
    try { return JSON.parse(t) } catch { return { code: -999, message: 'not json' } }
  } catch (e) { return { code: -998, message: String(e?.message ?? e) } }
}

async function fetchCommentText(row, headers, cache) {
  if (!cache.has(row.bv)) {
    const v = await jget(`https://api.bilibili.com/x/web-interface/view?bvid=${row.bv}`, headers)
    cache.set(row.bv, v?.code === 0 ? v.data.aid : null)
    await sleep(300)
  }
  const aid = cache.get(row.bv)
  if (!aid) return null

  const pick = (list) => list?.find((r) => Number(r?.rpid) === row.rpid)?.content?.message
  if (row.root) {
    const d = await jget(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${row.root}&ps=20&pn=1`, headers)
    return pick(d?.data?.replies) || null
  }
  const d = await jget(`https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=2&next=0&ps=20`, headers)
  return pick(d?.data?.replies) || null
}

/* ───────────── 桌面宠物用的 Python 环境 ─────────────
 * 桌面悬浮窗要 Python + Pillow + tkinter。发布给别人时不能指望
 * ~/.dsh/bili-duty/.venv（那是 dsh-bili-scroll 的），所以插件自己建一份：
 *   <DSH_HOME>/deep-fish-pond/.venv
 * 没建好就退回 bili-scroll 的 venv / 系统 python，至少 DSH 内嵌那只还能用。
 */

const PY_HOME = join(DSH_HOME, 'deep-fish-pond')
const PY_VENV = join(PY_HOME, '.venv')
const PY_MARK = join(PY_HOME, '.venv-ok')
const SETUP_LOG = join(PY_HOME, 'setup.log')

function venvPython(name = 'python.exe') {
  const win = join(PY_VENV, 'Scripts', name)
  if (existsSync(win)) return win
  const posix = join(PY_VENV, 'bin', name.replace('.exe', ''))
  return existsSync(posix) ? posix : ''
}

function systemPython() {
  const bili = join(BILI_HOME, '.venv', 'Scripts', 'python.exe')
  if (existsSync(bili)) return bili
  const posix = join(BILI_HOME, '.venv', 'bin', 'python')
  if (existsSync(posix)) return posix
  return process.env.POND_PYTHON || 'python'
}

function biliPython(name = 'python.exe') {
  const win = join(BILI_HOME, '.venv', 'Scripts', name)
  if (existsSync(win)) return win
  const posix = join(BILI_HOME, '.venv', 'bin', name.replace('.exe', ''))
  return existsSync(posix) ? posix : ''
}

/** 运行桌面宠物用的解释器：优先自己的 venv，其次 bili-scroll 的，最后系统 */
function resolvePython() {
  return venvPython('python.exe') || systemPython()
}

/** 同上，但不弹控制台窗口 */
function resolvePythonW() {
  return venvPython('pythonw.exe') || venvPython('python.exe') || biliPython('pythonw.exe') || biliPython('python.exe') || systemPython()
}

/** 候选解释器：插件自己的 venv → dsh-bili-scroll 的 venv → 环境变量指定的 */
function pythonCandidates() {
  return [
    venvPython('python.exe'),
    biliPython('python.exe'),
    process.env.POND_PYTHON || '',
  ].filter(Boolean)
}

/** 真的跑一次 import，确认 Pillow + tkinter 都在（只看文件存在不够） */
function probePython(py) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(py, ['-c', 'import PIL, tkinter; print("pond-ok")'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch { return resolve(false) }
    let out = ''
    child.stdout?.on('data', (c) => { out += String(c) })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0 && out.includes('pond-ok')))
  })
}

/** 当前桌面环境的探测结果（启动时、装完后都会刷新） */
let floatProbe = { ready: null, py: '', reason: '还没探测' }

async function ensureFloatEnv() {
  if (floatProbe.ready === true && floatProbe.py && existsSync(floatProbe.py)) return floatProbe
  const tried = []
  for (const py of pythonCandidates()) {
    tried.push(py)
    // eslint-disable-next-line no-await-in-loop
    if (await probePython(py)) {
      floatProbe = { ready: true, py, reason: '' }
      log(`桌面环境就绪：${py}`)
      return floatProbe
    }
  }
  floatProbe = {
    ready: false,
    py: '',
    reason: tried.length
      ? `试过这些 python，都没有 Pillow / tkinter：${tried.join(' | ')}`
      : '系统里找不到可用的 python',
  }
  return floatProbe
}

/**
 * 能不能开桌面窗：以**探测结果**为准，不看文件存不存在。
 * 之前只认 PY_MARK（自己建 venv 成功），结果 DSH 的沙箱不让 python 在
 * ~/.dsh/deep-fish-pond 下建目录（WinError 5），于是永远「未就绪」。
 */
const floatReady = () => floatProbe.ready === true

/** 后台建 venv + 装 Pillow；进度写 setup.log */
function setupPython() {
  if (existsSync(PY_MARK)) return { ok: true, ready: true, mode: 'venv' }
  mkdirSync(PY_HOME, { recursive: true })
  const base = systemPython()
  try { writeFileSync(SETUP_LOG, '', 'utf8') } catch { /* 无所谓 */ }
  const log2 = (s) => { try { appendFileSync(SETUP_LOG, s + '\n', 'utf8') } catch { /* 无所谓 */ } }
  log2(`base python: ${base}`)

  const run = (cmd, argv, cb) => {
    const child = spawn(cmd, argv, {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    child.stdout?.on('data', (c) => log2(String(c).trim()))
    child.stderr?.on('data', (c) => log2(String(c).trim()))
    child.on('error', (e) => { log2('spawn 失败: ' + String(e?.message ?? e)); cb(false) })
    child.on('exit', (code) => cb(code === 0))
  }

  run(base, ['-m', 'venv', PY_VENV], (ok) => {
    if (!ok) {
      // 常见原因：DSH 沙箱不让 python 在插件家目录建目录（WinError 5）
      log2('建 venv 失败 —— 退到现成的 python 上探测 Pillow')
      ensureFloatEnv().then((p) => log2(p.ready ? `可用：${p.py}` : `还是不行：${p.reason}`))
      return
    }
    const py = venvPython('python.exe')
    if (!py) { log2('venv 里没有 python'); return }
    run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', '--disable-pip-version-check'], () => {
      // 国内直连 PyPI 很慢，默认走清华源
      run(py, ['-m', 'pip', 'install', 'pillow', '--disable-pip-version-check', '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'], (ok2) => {
        if (ok2) { try { writeFileSync(PY_MARK, `venv:${py}`, 'utf8') } catch { /* 无所谓 */ } }
        log2(ok2 ? 'Pillow 装好了' : 'Pillow 没装上 —— 改用现成的 python 探测')
        ensureFloatEnv().then((p) => log2(p.ready ? `可用：${p.py}` : `还是不行：${p.reason}`))
      })
    })
  })
  return { ok: true, started: true }
}

/* ───────────── 主逻辑 ───────────── */

export function apply(ctx) {
  mkdirSync(ART_HOME, { recursive: true })
  // 启动横幅：看 art.log 就知道跑的是哪一版（改完没重启时不会出现新版本号）
  log(`启动 ${BUILD}：评论通道不再丢弃（无 20 秒窗口），精选用标题+挡位`)

  const state = readJson(STATE_FILE, { seen: {}, renders: [], skipped: [] })
  state.seen ||= {}
  state.renders ||= []
  state.skipped ||= []
  state.busyUntil ||= 0
  state.seq ||= 0
  state.digestSeen ||= {}

  // 升级迁移：把旧的「跳过」标记作废。
  // 那条 20 秒窗口规则已经删了，但之前被它丢掉的评论还挂在 seen 里，
  // 不清掉的话你改完 seen.md 也永远不会重说。
  let revived = 0
  for (const [k, v] of Object.entries(state.seen)) {
    if (v && v.skipped) { delete state.seen[k]; revived += 1 }
  }
  if (revived) log(`清理了 ${revived} 条旧的「跳过」标记，它们会重新排队`)

  let slotUntil = 0
  let queue = Promise.resolve()
  let disposed = false
  let assetFlip = 0
  let watcher = null
  let timer = null
  let reportWatcher = null
  let digestTimer = null

  const save = () => writeJson(STATE_FILE, {
    seen: state.seen,
    renders: state.renders.slice(-300),
    skipped: state.skipped.slice(-300),
    busyUntil: slotUntil,
    seq: state.seq,
    digestSeen: state.digestSeen,
  })

  const tool = (spec) => ctx.tools.register({
    ...spec,
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
    },
    async execute(args) { return JSON.parse(JSON.stringify(await spec.execute(args))) },
  })

  /**
   * 记一句台词 —— 不再画卡片。
   * 卡片是把字烘进图片里：改字号要重绘、旧图还会排在队列前面，怎么调都觉得「没变」。
   * 现在只把文字记下来，排版交给浏览器实时做，字号随时可调、立即生效。
   */
  async function renderOne(row) {
    const isDigest = Boolean(row.digest)
    const seenKey = row.key || String(row.rpid)
    let text = String(row.preview || '').trim()
    let source = isDigest ? '日报（我的一句话）' : 'seen.md 预览'

    if (!isDigest) {
      // ⚠️ 这里原来有一条「20 秒窗口内又来了新评论就跳过」的规则。
      //    那是图片时代留下的：一张卡占住画面 20 秒，后来的只能丢。
      //    现在台词是排队播的，这条规则只会把同一批进来的 5、6 条评论
      //    悄悄扔掉（art.log 里一堆「跳过 rpid=…」就是这么来的），所以删掉。
      const cred = credential()
      if (cred) {
        const fetched = await fetchCommentText(row, headersFor(cred), new Map())
        if (fetched && fetched.trim()) {
          // 只在「接口原文和表里的预览确实是同一条」时才用接口原文。
          // 对不上说明这一行被人手动改过（或 rpid 变了），那就以表为准。
          const head = String(row.preview || '').trim().slice(0, 8)
          const live = fetched.trim()
          if (!head || live.startsWith(head)) { text = live; source = 'B站接口原文' }
          else source = '表里改过的正文'
        }
      }
    }
    if (!text) return { ok: false, error: '没有正文' }

    const record = {
      seq: ++state.seq,
      rpid: row.rpid,
      bv: row.bv,
      at: new Date().toISOString(),
      day: dayKey(),
      kind: isDigest ? 'digest' : 'comment',
      text,
      title: isDigest ? String(row.title || '') : '',
      tag: isDigest ? String(row.tag || '') : '',
      textSource: source,
      chars: text.length,
    }
    state.renders.push(record)
    if (!isDigest) state.seen[seenKey] = { at: record.at, said: true }
    save()
    log(`记一句 ${record.kind}（${row.bv}）：${text.slice(0, 28)}`)
    return { ok: true, ...record }
  }

  const enqueue = (row) => {
    queue = queue.then(() => renderOne(row)).catch((e) => log(`记台词出错 rpid=${row.rpid}：${e?.message ?? e}`))
    return queue
  }

  /** 读一遍 seen.md，把没见过的评论行挑出来 */
  function scan(reason) {
    if (disposed) return
    let markdown = ''
    try { markdown = readFileSync(SEEN_FILE, 'utf8') } catch { return }
    const rows = parseCommentRows(markdown)
    // 去重键 = rpid + 正文预览。
    // 只按 rpid 去重的话，你手动改表里的评论正文永远是「已处理」，鱼塘不会跟着变。
    const fresh = rows.filter((r) => !state.seen[`${r.rpid}:${r.preview}`])
    if (!fresh.length) return
    for (const row of fresh) {
      const key = `${row.rpid}:${row.preview}`
      state.seen[key] = { at: new Date().toISOString(), queued: true }
      log(`发现新评论 rpid=${row.rpid}（${row.bv}）来源：${reason}`)
      enqueue({ ...row, key })
    }
    save()
  }

  /** 读今天最新的日报，把还没画过的 BV 各画一张卡（这条通道不需要真的发评论） */
  function scanDigest(reason) {
    if (disposed) return
    let files = []
    try { files = readdirSync(OUT_HOME).filter((f) => f.toLowerCase().endsWith('.md')) } catch { return }
    if (!files.length) return
    files.sort()
    const file = files[files.length - 1]
    const day = file.replace(/\.md$/i, '')
    let md = ''
    try { md = readFileSync(join(OUT_HOME, file), 'utf8') } catch { return }

    // 去重看「有没有真的记过这句台词」，而不是看 digestSeen：
    // 老版本只把 BV 记进 digestSeen、字烘在图里（renders 里没有 text），
    // 升级后它们会被当成「已经处理过」，于是永远没有台词 —— 就是这次报的「有文件却没精选」。
    // 现在还要 title：老的纯文本记录没有标题/挡位，得按新格式补一遍。
    const said = new Set(
      state.renders.filter((r) => r.kind === 'digest' && r.text && r.title).map((r) => r.bv),
    )
    const fresh = parseReportBlocks(md).filter((b) => !said.has(b.bv))
    if (!fresh.length) return

    for (const block of fresh) {
      log(`日报里发现新条目 ${block.bv}（${reason}）：${block.text.slice(0, 24)}`)
      enqueue({ bv: block.bv, rpid: 0, root: 0, preview: block.text, digest: true, title: block.title, tag: block.tag })
    }
    save()
  }

  try {
    watcher = watch(BILI_HOME, { persistent: true }, (_evt, filename) => {
      if (filename && String(filename).toLowerCase() !== 'seen.md') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => scan('seen.md 变化'), DEBOUNCE_MS)
    })
    watcher.on('error', (e) => log(`盯 seen.md 出错：${e?.message ?? e}`))
  } catch (e) {
    log(`起不了监视器：${e?.message ?? e}`)
  }

  try {
    reportWatcher = watch(OUT_HOME, { persistent: true }, (_evt, filename) => {
      if (filename && !String(filename).toLowerCase().endsWith('.md')) return
      if (digestTimer) clearTimeout(digestTimer)
      digestTimer = setTimeout(() => scanDigest('日报变化'), DEBOUNCE_MS)
    })
    reportWatcher.on('error', (e) => log(`盯日报出错：${e?.message ?? e}`))
  } catch (e) {
    log(`起不了日报监视器：${e?.message ?? e}`)
  }

  // 启动时先对一遍：插件重启期间漏掉的行也接上（老行已在 state 里，不会重画）
  setTimeout(() => scan('启动扫描'), 1200).unref?.()
  setTimeout(() => scanDigest('启动扫描'), 2500).unref?.()
  // 启动时探一次桌面环境（只跑一次 python -c，很轻）
  setTimeout(() => { ensureFloatEnv().catch(() => {}) }, 3000).unref?.()

  tool({
    name: 'bili_art_status',
    description: '看「鱼塘」现在什么状态：两个入口（评论记录 / 日报精选）各画过几张、跳过几条、槽位占着没有。',
    // ⚠️ register 收的是**标准 JSON Schema**，不是「字段名→描述」的 map。
    //    写成 `parameters: {}` 会让模型 API 拿到 type:null，整轮请求全挂（2026-10-24 事故）。
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const busyLeft = Math.max(0, slotUntil - Date.now())
      return {
        ok: true,
        plugin: 'deep-fish-pond',
        watch: { comments: SEEN_FILE, commentsExists: existsSync(SEEN_FILE), digest: OUT_HOME },
        home: ART_HOME,
        slot: { busyMs: busyLeft, windowMs: SLOT_MS },
        counts: {
          renders: state.renders.length,
          comments: state.renders.filter((r) => r.kind !== 'digest').length,
          digest: state.renders.filter((r) => r.kind === 'digest').length,
          skipped: state.skipped.length,
        },
        seq: state.seq,
        last: state.renders.slice(-3),
        python: resolvePython(),
        floatEnv: { ready: floatReady(), venv: PY_VENV, log: SETUP_LOG },
      }
    },
  })

  /* 桌面悬浮窗的环境自检/安装（Pillow + tkinter） */
  tool({
    name: 'pond_setup',
    description: '准备桌面悬浮窗的 Python 环境：在插件自己的家目录建 venv 并装 Pillow。已经装好就直接返回 ready。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { ...setupPython(), ready: floatReady(), venv: PY_VENV, log: SETUP_LOG }
    },
  })

  /* ───────────── 浏览器那半要的接口（右下角鱼塘） ───────────── */

  const MIME = { '.mp4': 'video/mp4', '.png': 'image/png', '.webm': 'video/webm', '.webp': 'image/webp' }

  function serveFile(req, res, file) {
    const type = MIME[extname(String(file)).toLowerCase()] || 'application/octet-stream'
    if (!existsSync(file)) { res.statusCode = 404; res.end('not found'); return }
    let size = 0
    try { size = statSync(file).size } catch { res.statusCode = 404; res.end('not found'); return }

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', type)
    // 视频要能循环 / 拖进度：按 Range 切片回，别整段怼过去
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range || ''))
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
      if (start <= end && start < size) {
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
        res.setHeader('Content-Length', String(end - start + 1))
        createReadStream(file, { start, end }).pipe(res)
        return
      }
    }
    res.statusCode = 200
    res.setHeader('Content-Length', String(size))
    res.setHeader('Cache-Control', 'public, max-age=86400')
    createReadStream(file).pipe(res)
  }

  const sendJson = (res, code, body) => {
    try {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    } catch { /* 连接已经断了 */ }
  }

  const ASSET_FILE = { idle: 'idle.webp', swim: 'swim.webp' }

  // 浏览器半端每走一步就回来报一次，排查「界面为什么没出来」用
  const diag = []

  // 桌面鱼塘：一个独立的 python/tkinter 进程，脱离 DSH 窗口
  let floatProc = null

  const floatRunning = () => Boolean(floatProc && floatProc.exitCode === null && !floatProc.killed)

  function startFloat(base) {
    if (floatRunning()) return { ok: true, running: true, pid: floatProc.pid }
    try {
      // 用探测通过的那个解释器；没探测过就用默认顺序
      const py = (floatProbe.ready && floatProbe.py) ? floatProbe.py : resolvePythonW()
      const script = join(PLUGIN_DIR, 'render', 'pond_window.py')
      const child = spawn(py, [
        script,
        '--api', base,
        '--assets', join(PLUGIN_DIR, 'assets', 'art'),
        '--size', '220',
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      })
      child.on('exit', () => { if (floatProc === child) floatProc = null })
      child.unref()
      floatProc = child
      log(`桌面鱼塘起来了：pid=${child.pid}`)
      return { ok: true, running: true, pid: child.pid }
    } catch (e) {
      log(`桌面鱼塘起不来：${e?.message ?? e}`)
      return { ok: false, running: false, error: String(e?.message ?? e) }
    }
  }

  function stopFloat() {
    if (floatRunning()) {
      try { process.kill(floatProc.pid) } catch { /* 已经没了 */ }
      log('桌面鱼塘关掉了')
    }
    floatProc = null
    return { ok: true, running: false }
  }

  async function handlePond(req, res) {
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    const route = url.pathname
    try {
      if (req.method === 'GET' && route === '/api/deep-fish-pond/status') {
        const since = Number(url.searchParams.get('since') ?? '-1')
        const latest = state.renders.length ? state.renders[state.renders.length - 1] : null
        const cards = (Number.isFinite(since) && since >= 0
          ? state.renders.filter((r) => Number(r.seq || 0) > since)
          : []
        )
          .filter(hasSayable)
          .slice(-20)
          .map((r) => ({ seq: r.seq, bv: r.bv, at: r.at, kind: r.kind || 'comment', text: r.text, title: r.title || '', tag: r.tag || '' }))
        return sendJson(res, 200, {
          ok: true,
          build: BUILD,
          renders: state.renders.length,
          skipped: state.skipped.length,
          busyMs: Math.max(0, slotUntil - Date.now()),
          seq: state.seq,
          cards,
          latest: latest
            ? { rpid: latest.rpid, at: latest.at, asset: latest.asset, hasVideo: Boolean(latest.video), hasWebp: Boolean(latest.webp), hasCard: Boolean(latest.card) }
            : null,
        })
      }

      if (req.method === 'GET' && route.startsWith('/api/deep-fish-pond/asset/')) {
        const key = route.slice('/api/deep-fish-pond/asset/'.length).replace(/[^a-z]/gi, '')
        const base = ASSET_FILE[key]
        if (!base) return sendJson(res, 404, { ok: false, error: '没有这个素材' })
        return serveFile(req, res, join(PLUGIN_DIR, 'assets', 'art', base))
      }

      if (req.method === 'GET' && route === '/api/deep-fish-pond/card') {
        const seq = Number(url.searchParams.get('seq') || 0)
        const rpid = Number(url.searchParams.get('rpid') || 0)
        const kind = String(url.searchParams.get('kind') || 'webp')
        const rec = seq
          ? state.renders.find((r) => Number(r.seq) === seq)
          : state.renders.filter((r) => Number(r.rpid) === rpid).pop()
        const file = rec ? (kind === 'png' ? rec.card : kind === 'video' ? rec.video : (rec.webp || rec.video)) : ''
        if (!file) return sendJson(res, 404, { ok: false, error: '这条没有产物' })
        return serveFile(req, res, file)
      }

      // 桌面鱼塘进程：start / stop / status
      if (route === '/api/deep-fish-pond/float') {
        const action = String(url.searchParams.get('action') || (req.method === 'POST' ? 'start' : 'status'))
        if (action === 'stop') return sendJson(res, 200, stopFloat())
        if (action === 'status' || req.method === 'GET') {
          return sendJson(res, 200, { ok: true, running: floatRunning(), ready: floatReady(), py: floatProbe.py, reason: floatProbe.reason })
        }
        // 真去探一次（算上 pip 装完的情况），别只信缓存
        const env = await ensureFloatEnv()
        if (!env.ready) {
          return sendJson(res, 200, {
            ok: false, running: false, ready: false, reason: env.reason,
            error: `桌面悬浮窗需要 Python + Pillow：${env.reason}`,
          })
        }
        const host = String(req.headers?.host || '127.0.0.1:19387')
        return sendJson(res, 200, startFloat(`http://${host}`))
      }

      // 桌面悬浮窗环境：查状态 / 开始安装
      if (route === '/api/deep-fish-pond/setup') {
        if (req.method === 'GET') {
          let tail = ''
          try { tail = readFileSync(SETUP_LOG, 'utf8').slice(-1200) } catch { /* 没日志 */ }
          const env = await ensureFloatEnv()
          return sendJson(res, 200, { ok: true, ready: env.ready, py: env.py, reason: env.reason, venv: PY_VENV, log: tail })
        }
        return sendJson(res, 200, { ...setupPython(), ready: floatReady(), venv: PY_VENV })
      }

      // 设置（目前只有字号）
      if (route === '/api/deep-fish-pond/settings') {
        if (req.method === 'GET') return sendJson(res, 200, { ok: true, ...readSettings() })
        let body = ''
        try {
          for await (const chunk of req) body += chunk
          const patch = JSON.parse(body || '{}')
          const next = { ...readSettings() }
          const raw = Number(patch.bubbleFontPx)
          if (Number.isFinite(raw)) next.bubbleFontPx = Math.max(10, Math.min(34, Math.round(raw)))
          writeJson(SETTINGS_FILE, next)
          log(`气泡字号改成 ${next.bubbleFontPx}px`)
          return sendJson(res, 200, { ok: true, ...next })
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: String(e?.message ?? e) })
        }
      }

      // 兼容老客户端：不再重画任何东西，只是把「当前进度」告诉它
      if (req.method === 'POST' && route === '/api/deep-fish-pond/rerender') {
        return sendJson(res, 200, { ok: true, before: state.seq, seq: state.seq, ...readSettings() })
      }

      // 右键菜单用：按种类取回画过的卡（说精选 / 说评论）
      if (req.method === 'GET' && route === '/api/deep-fish-pond/cards') {
        const kind = String(url.searchParams.get('kind') || '')
        const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20))
        const list = state.renders
          .filter((r) => (kind ? (r.kind || 'comment') === kind : true))
          .filter(hasSayable)
          .slice(-limit)
          .map((r) => ({ seq: r.seq, bv: r.bv, at: r.at, kind: r.kind || 'comment', text: r.text, title: r.title || '', tag: r.tag || '' }))
        return sendJson(res, 200, { ok: true, count: list.length, cards: list })
      }

      // 浏览器半端自检：它到底有没有走到「注册槽位」「真的渲染」这两步
      if (req.method === 'GET' && route === '/api/deep-fish-pond/diag') {
        const stage = String(url.searchParams.get('stage') || '')
        if (stage) {
          diag.push({ at: new Date().toISOString(), stage })
          if (diag.length > 60) diag.shift()
          log(`浏览器半端：${stage}`)
        }
        return sendJson(res, 200, { ok: true, stage, log: diag, renders: state.renders.length })
      }

      return sendJson(res, 404, { ok: false, error: 'no route' })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/deep-fish-pond',
      handler: handlePond,
    }), 'deep-fish-pond: 鱼塘的 /api/deep-fish-pond 路由')
  } catch (e) { log(`HTTP 路由没挂上：${e?.message ?? e}`) }

  ctx.effect(() => () => {
    disposed = true
    if (timer) clearTimeout(timer)
    if (digestTimer) clearTimeout(digestTimer)
    try { watcher?.close() } catch { /* 收摊 */ }
    try { reportWatcher?.close() } catch { /* 收摊 */ }
    stopFloat()
    save()
  }, 'deep-fish-pond: 收监视器')
}
