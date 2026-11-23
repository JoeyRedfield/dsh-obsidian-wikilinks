# dsh-obsidian-wikilinks

[![npm](https://img.shields.io/npm/v/dsh-obsidian-wikilinks)](https://www.npmjs.com/package/dsh-obsidian-wikilinks) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Turn `[[wiki links]]` in DeepSeek Harness chat transcripts into **blue, clickable links** that open the matching note.

English | [中文](README.zh.md)

- **Click** → opens the note in the right sidebar Markdown preview (frontmatter renders as a field table).
- **⌘ / Ctrl / Alt + click** → hands the file to the system default app — Obsidian, if it owns `.md`.
- **Hover** shows the resolved absolute path. Links that cannot be resolved get a red dashed style and a “note not found” tooltip instead of failing silently.

## Resolution rules

`[[target]]` is parsed the Obsidian way:

1. drop the `|alias`, `#heading` and `^block` parts;
2. try `target` as a path, then retry with `.md` appended — both `[[notes/foo]]` and `[[notes/foo.md]]` work;
3. still unresolved? one workspace search by file name, and the first `.md` hit wins;
4. relative targets resolve against the session workspace root; absolute paths are used as-is.

`![[image]]` is an Obsidian embed, not a note link, and is left untouched.

## Install

Published on [npm](https://www.npmjs.com/package/dsh-obsidian-wikilinks) — plain JavaScript, no build step.

From the plugin market: open **Plugins → Plugin Market** and search for `obsidian-wikilinks`.

From a terminal:

```sh
dsh plugin --profile <profile> add dsh-obsidian-wikilinks
```

For local development, install the checkout by link instead:

```sh
# profile package.json: add to dependencies and to dsh.profile.bundles
"dsh-obsidian-wikilinks": "link:/path/to/dsh-obsidian-wikilinks"
```

Refresh the web page once (⌘R) after installing.

## Why DOM decoration

DSH has no inline-Markdown extension point. In the shipped renderer the plain-text branch of an AST node returns the raw string, and only inline code is handed to `fileMentions`; the `conversation.chat.markdown.fence` slot wraps fenced code blocks only; replacing the `conversation.chat.node` assistant step would mean reimplementing the whole `AssistantNodeView`. So the plugin post-processes text:

- it registers a hidden anchor on the `conversation.chat.turnTail` slot (the only per-turn seat that hands a session-scoped component both `sessionId` and `openFile`);
- `closest('[data-chat-flow]')` finds the transcript flow root, and each flow root gets **one** `MutationObserver`, shared per root and reference-counted so it disconnects when the last turn unmounts;
- only text nodes inside `[data-text-interaction-source]` are decorated (settled messages), skipping `[data-streaming]`, `code`, `pre`, `a`, `button`, `svg` and anything already decorated;
- mutations are batched into a `requestAnimationFrame`.

## Limitations

- Messages are decorated once they settle; during streaming the text stays plain.
- Chat transcripts only — the sidebar note preview and the composer input are untouched.
- A rare React re-render race can leave one line undecorated until the view repaints; switching sessions or reloading restores it.
- No settings UI. To make a plain click open Obsidian instead, flip the `external` check in `activate()` in `client.js`.

## License

[MIT](LICENSE)
