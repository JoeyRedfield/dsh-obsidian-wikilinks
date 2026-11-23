/**
 * Browser half of dsh-obsidian-wikilinks: 让会话正文里的 `[[wiki 链接]]` 标蓝、可点。
 *
 * 为什么用 DOM 后处理：MarkdownText 只把 inlineCode 交给 `fileMentions`，
 * 纯文本分支原样返回（`case "text": return e.value`），流式解析时甚至连
 * mentions 都不接；`conversation.chat.markdown.fence` 只包裹代码围栏。所以没有
 * 官方 inline 钩子，只能在会话流里做文本节点替换。
 *
 * 落点：`conversation.chat.turnTail`（list，session 作用域）——每个 Turn 尾部一个
 * 隐藏锚点，顺带拿到 `sessionId` 与 `openFile`，DOM 恰好落在会话流内部。
 * `el.closest('[data-chat-flow]')` 得到流根，每个流根共享一个 MutationObserver，
 * 只装饰 `[data-text-interaction-source]`（已定稿消息）里的文本节点，跳过流式根
 * `[data-streaming]`、代码、已有链接和按钮。
 *
 * 点击：普通点击 = `openFile(绝对路径)`（右侧栏预览）；⌘/Ctrl/Alt 点击 =
 * `remote.session.openWorkspacePath`（系统默认应用，macOS 上一般是 Obsidian）。
 * 路径解析：先按原文、再补 `.md` 直接 stat，都失败再按文件名 search 兜底。
 *
 * 本文件被 `@deepseek-ai/dsh-client-modules` 直接塞进 combo script，必须是无
 * 依赖、无 JSX、无 import 的普通脚本。
 *
 * @module dsh-obsidian-wikilinks/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-obsidian-wikilinks',
  factory: (require) => {
    const React = require('react')
    /** Short alias for `React.createElement`. */
    const h = React.createElement

    const SEAT = 'conversation.chat.turnTail'
    const ENTRY_ID = 'dsh-obsidian-wikilinks-anchor'
    const STYLE_ID = 'dsh-obsidian-wikilinks/style.css'

    /** 会话聊天流的根（ChatView 的 column）。 */
    const FLOW = '[data-chat-flow]'
    /** MarkdownText / 用户气泡上标记"可交互的已定稿文本"。 */
    const SCOPE = '[data-text-interaction-source]'
    /** 流式中的 MarkdownText 根：React 还会重写文本，先别动。 */
    const STREAMING = '[data-streaming]'
    /** 不装饰的区域：代码、链接、按钮、表单、图表，以及我们自己生成的链接。 */
    const SKIP = 'code, pre, kbd, samp, a, button, textarea, input, select, script, style, svg, [data-dsw-wl]'
    const LINK_TAG = 'data-dsw-wl'
    const STATE_TAG = 'data-dsw-wl-state'
    const PATTERN = /\[\[([^\[\]\n]{1,300})\]\]/g
    /** 一个永不 abort 的 signal：点击解析是短请求，页面卸载时无所谓。 */
    const SIGNAL = new AbortController().signal

    const CSS = `
.dsw-wl {
  color: var(--dsw-alias-brand-primary, #4c8dff);
  text-decoration: none;
  cursor: pointer;
  border-radius: 3px;
  transition: background-color 0.12s ease, text-decoration-color 0.12s ease;
}
.dsw-wl:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
  background-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4c8dff) 12%, transparent);
}
.dsw-wl:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, #4c8dff);
  outline-offset: 1px;
}
.dsw-wl[${STATE_TAG}="resolving"] {
  opacity: 0.55;
}
.dsw-wl[${STATE_TAG}="missing"] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
  text-decoration: underline dashed;
  text-underline-offset: 2px;
  cursor: not-allowed;
}
`

    /** Client 服务句柄，由 `apply` 填充。 */
    let services = { remote: undefined, sidebarRight: undefined }

    /** 会话流根 → 共享装饰器。turnTail 会随虚拟滚动反复挂载，所以按引用计数复用。 */
    const roots = new WeakMap()

    /**
     * 把一个会话流根与装饰器绑定，并返回一个释放句柄。
     * @param {Element} root 会话流根（`[data-chat-flow]`）。
     * @param {string} sessionId 该会话的 id。
     * @param {(path: string) => void} openFile 宿主提供的"打开文件"回调。
     */
    function acquireRoot(root, sessionId, openFile) {
      let control = roots.get(root)
      if (control === undefined) {
        control = { root, count: 0, sessionId, openFile, frame: 0, observer: null }
        control.observer = new MutationObserver(() => { schedule(control) })
        control.observer.observe(root, { childList: true, subtree: true })
        roots.set(root, control)
      }
      control.count += 1
      control.sessionId = sessionId
      control.openFile = openFile
      schedule(control)
      return {
        control,
        release() {
          control.count -= 1
          if (control.count > 0) return
          control.observer.disconnect()
          if (control.frame !== 0) cancelAnimationFrame(control.frame)
          roots.delete(root)
        },
      }
    }

    /**
     * 合并同一帧内的多次变更，避免流式渲染时反复全量扫描。
     * @param {object} control 会话流控制器。
     */
    function schedule(control) {
      if (control.frame !== 0) return
      control.frame = requestAnimationFrame(() => {
        control.frame = 0
        decorate(control)
      })
    }

    /**
     * 扫描流根，把带 `[[...]]` 的文本节点拆成"文本 + 链接"。
     * @param {object} control 会话流控制器。
     */
    function decorate(control) {
      const root = control.root
      if (!root.isConnected) return
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const pending = []
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue
        if (value === null || value.indexOf('[[') < 0) continue
        const parent = node.parentElement
        if (parent === null) continue
        if (parent.closest(SKIP) !== null) continue
        if (parent.closest(SCOPE) === null) continue
        if (parent.closest(STREAMING) !== null) continue
        pending.push(node)
      }
      for (const node of pending) splitNode(control, node)
    }

    /**
     * 把单个文本节点里的 `[[...]]` 换成链接，其余原样保留。
     * @param {object} control 会话流控制器。
     * @param {Text} node 待拆分的文本节点。
     */
    function splitNode(control, node) {
      const value = node.nodeValue ?? ''
      PATTERN.lastIndex = 0
      const pieces = []
      let last = 0
      let match
      while ((match = PATTERN.exec(value)) !== null) {
        const start = match.index
        // `![[图.png]]` 是 Obsidian 的嵌入语法，不当作笔记链接。
        if (start > 0 && value[start - 1] === '!') continue
        if (start > last) pieces.push({ text: value.slice(last, start) })
        pieces.push({ text: match[0], target: match[1] })
        last = start + match[0].length
      }
      if (last === 0) return
      if (last < value.length) pieces.push({ text: value.slice(last) })
      const fragment = document.createDocumentFragment()
      for (const piece of pieces) {
        if (piece.target === undefined) fragment.appendChild(document.createTextNode(piece.text))
        else fragment.appendChild(createLink(control, piece.target, piece.text))
      }
      node.replaceWith(fragment)
    }

    /**
     * 造一个蓝色链接锚点。
     * @param {object} control 会话流控制器。
     * @param {string} target `[[ ]]` 里的原文（可能带 `|别名`、`#标题`）。
     * @param {string} label 实际显示的文字（保留方括号原样）。
     * @returns {HTMLAnchorElement} 链接元素。
     */
    function createLink(control, target, label) {
      const link = document.createElement('a')
      link.setAttribute(LINK_TAG, target)
      link.setAttribute('role', 'link')
      link.setAttribute('tabindex', '0')
      link.className = 'dsw-wl'
      link.textContent = label
      link.title = '在侧边栏打开：' + target + '\n⌘ / Alt 点击用 Obsidian 打开'
      link.addEventListener('click', (event) => { activate(control, link, target, event) })
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(control, link, target, event)
      })
      return link
    }

    /**
     * 解析并打开一个 wiki 链接目标。
     * @param {object} control 会话流控制器。
     * @param {HTMLAnchorElement} link 被点击的链接。
     * @param {string} target `[[ ]]` 里的原文。
     * @param {Event} event 触发事件。
     */
    async function activate(control, link, target, event) {
      event.preventDefault()
      event.stopPropagation()
      const sessionId = control.sessionId
      if (sessionId === undefined || services.remote === undefined) return
      if (link.getAttribute(STATE_TAG) === 'resolving') return
      const external = event.metaKey || event.ctrlKey || event.altKey
      link.setAttribute(STATE_TAG, 'resolving')
      let absolute = null
      try {
        absolute = await locate(sessionId, target)
      } catch (error) {
        absolute = null
      }
      if (absolute === null) {
        link.setAttribute(STATE_TAG, 'missing')
        link.title = '没找到笔记：' + target
        return
      }
      link.removeAttribute(STATE_TAG)
      link.title = absolute
      if (external) {
        const opened = await services.remote.session.openWorkspacePath({ path: absolute })
        if (opened === undefined || opened.ok !== true) link.title = '打开失败：' + absolute
        return
      }
      if (typeof control.openFile === 'function') control.openFile(absolute)
      else openInSidebar(sessionId, absolute)
    }

    /**
     * 把笔记路径变成会话作用域的文件资源地址，作为 `openFile` 缺失时的兜底。
     * @param {string} sessionId 会话 id。
     * @param {string} path 绝对路径。
     * @returns {string} `dsh-resource://` 地址。
     */
    function fileAddress(sessionId, path) {
      const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
      const encoded = normalized.split('/').map((segment) => segment === ''
        ? ''
        : encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
      return 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + encoded
    }

    /**
     * 右侧栏打开：优先 `openResourceIn`，老版本回落到 `openResource`。
     * @param {string} sessionId 会话 id。
     * @param {string} path 绝对路径。
     */
    function openInSidebar(sessionId, path) {
      const sidebarRight = services.sidebarRight
      if (sidebarRight === undefined) return
      const address = fileAddress(sessionId, path)
      if (typeof sidebarRight.openResourceIn === 'function') sidebarRight.openResourceIn(sessionId, address, {})
      else if (typeof sidebarRight.openResource === 'function') sidebarRight.openResource(address)
    }

    /**
     * 去掉别名、标题、块引用，只留目标路径。
     * @param {string} raw `[[ ]]` 里的原文。
     * @returns {string} 目标路径。
     */
    function normalizeTarget(raw) {
      return raw.split('|')[0].split('#')[0].split('^')[0].trim()
    }

    /**
     * 把 wiki 目标解析成 Host 文件系统里的绝对路径。
     * @param {string} sessionId 会话 id。
     * @param {string} raw `[[ ]]` 里的原文。
     * @returns {Promise<string | null>} 找不到时返回 null。
     */
    async function locate(sessionId, raw) {
      const wanted = normalizeTarget(raw)
      if (wanted === '') return null
      const workspaceFiles = services.remote.workspaceFiles
      const candidates = /\.md$/i.test(wanted) ? [wanted] : [wanted, wanted + '.md']
      for (const candidate of candidates) {
        const stat = await workspaceFiles.stat(sessionId, candidate, SIGNAL)
        if (stat !== undefined && stat.ok === true) return stat.value.absolutePath
      }
      const name = wanted.split('/').pop()
      if (name === undefined || name === '') return null
      const found = await workspaceFiles.search(sessionId, {
        query: name,
        excludedPaths: [],
        includeHidden: false,
        respectGitignore: false,
      }, SIGNAL)
      if (found === undefined || found.ok !== true) return null
      const accept = [name.toLowerCase(), (name + '.md').toLowerCase()]
      for (const match of found.value.matches) {
        if (match.type !== 'file') continue
        const base = match.path.split('/').pop()
        if (base === undefined || accept.indexOf(base.toLowerCase()) < 0) continue
        const stat = await workspaceFiles.stat(sessionId, match.path, SIGNAL)
        if (stat !== undefined && stat.ok === true) return stat.value.absolutePath
      }
      return null
    }

    /**
     * 隐藏锚点：只为一个 Turn 提供"我在这个会话的会话流里"这件事。
     * @param {object} props slot props，含 `sessionId` 与 `openFile`。
     * @returns {React.ReactElement} 不可见 span。
     */
    function Anchor(props) {
      const host = React.useRef(null)
      const handle = React.useRef(null)
      const sessionId = props.sessionId
      const openFile = props.openFile

      React.useLayoutEffect(() => {
        const element = host.current
        if (element === null) return undefined
        const root = element.closest(FLOW)
        if (root === null) return undefined
        const acquired = acquireRoot(root, sessionId, openFile)
        handle.current = acquired
        return () => {
          handle.current = null
          acquired.release()
        }
        // 只在会话变化时重挂；openFile 每次渲染同步一次即可。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      React.useEffect(() => {
        const acquired = handle.current
        if (acquired === null) return
        acquired.control.sessionId = sessionId
        acquired.control.openFile = openFile
      })

      return h('span', { ref: host, hidden: true, 'aria-hidden': 'true' })
    }

    /**
     * 注入样式表，并在条目销毁时移除。
     * @returns {() => void} cleanup。
     */
    function installStyles() {
      if (document.getElementById(STYLE_ID) !== null) return () => {}
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    /**
     * Plugin entry point.
     * @param {object} ctx client context carrying `slots`, `remote`, `sidebarRight`.
     */
    function apply(ctx) {
      services = { remote: ctx.remote, sidebarRight: ctx.sidebarRight }
      ctx.effect(installStyles, 'obsidian wikilinks styles')
      ctx.slots.inject(SEAT, () =>
        ctx.slots.register(
          {
            name: SEAT,
            id: ENTRY_ID,
            order: 130,
          },
          Anchor,
        ),
      )
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots', 'remote', 'remote.workspaceFiles', 'remote.session', 'sidebarRight']
    return module.exports
  },
})
