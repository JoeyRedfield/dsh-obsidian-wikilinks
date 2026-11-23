# dsh-obsidian-wikilinks

[![npm](https://img.shields.io/npm/v/dsh-obsidian-wikilinks)](https://www.npmjs.com/package/dsh-obsidian-wikilinks) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

让 DeepSeek Harness 会话正文里的 `[[wiki 链接]]` **标蓝、可点击**，点开就是对应的笔记。

[English](README.md) | 中文

- **普通点击** → 在右侧栏用 Markdown 预览打开笔记（`.md` 渲染正文，frontmatter 渲染成字段表）。
- **⌘ / Ctrl / Alt + 点击** → 交给系统默认应用打开（macOS 上 `.md` 一般归 Obsidian）。
- **悬停**显示解析后的绝对路径；解析失败会变红虚线并提示「没找到笔记」，不会静默失败。

## 解析规则

`[[目标]]` 按 Obsidian 语法处理：

1. 去掉 `|别名`、`#标题`、`^块引用`；
2. 先按原文当路径试一次，不行再补 `.md` 重试——写 `[[学习/ai相关/foo]]` 和 `[[学习/ai相关/foo.md]]` 都行；
3. 还失败就用文件名做一次 workspace search，命中同名 `.md` 时取第一条；
4. 相对路径按会话工作区根解析，绝对路径原样使用。

`![[图片]]` 是 Obsidian 的嵌入语法，不当作笔记链接，原样保留。

## 安装

已发布到 [npm](https://www.npmjs.com/package/dsh-obsidian-wikilinks)，纯 JavaScript，无需构建。

插件市场：打开 **Plugins → Plugin Market**，搜索 `obsidian-wikilinks`。

命令行：

```sh
dsh plugin --profile <profile> add dsh-obsidian-wikilinks
```

本地开发时用 link 装当前目录：

```sh
# profile 的 package.json：dependencies 与 dsh.profile.bundles 各加一条
"dsh-obsidian-wikilinks": "link:/path/to/dsh-obsidian-wikilinks"
```

装完刷新一次 Web 页面（⌘R）。

## 实现要点（为什么是 DOM 后处理）

DSH 没有 inline markdown 钩子：渲染器里 AST 的纯文本分支直接返回原字符串，只有 inline code 会交给 `fileMentions`；`conversation.chat.markdown.fence` 只包裹代码围栏；替换 `conversation.chat.node` 的 assistant step 需要重写整个 `AssistantNodeView`。所以插件改文本节点：

- 在 `conversation.chat.turnTail` 槽位挂一个隐藏锚点——这是唯一一个把会话作用域组件塞进每个 Turn、同时给到 `sessionId` 和 `openFile` 的落点；
- 用 `closest('[data-chat-flow]')` 找到会话流根，每个流根共享**一个** `MutationObserver`（引用计数，最后一个 Turn 卸载时断开）；
- 只装饰 `[data-text-interaction-source]` 容器里的文本（已定稿消息），跳过 `[data-streaming]`、`code`、`pre`、`a`、`button`、`svg` 和已装饰节点；
- 变更用 `requestAnimationFrame` 合并批量处理。

## 已知限制

- 流式输出期间不标蓝，消息定稿后才生效。
- 只处理会话正文；右侧栏的笔记预览、输入框不处理。
- 极少数情况下 React 重写已替换的文本节点会让某一行暂时没标蓝，切换会话或刷新即恢复。
- 没有设置页；想改成「默认点击直接交给 Obsidian」，把 `client.js` 里 `activate()` 的 `external` 判断反过来即可。

## 许可

[MIT](LICENSE)
