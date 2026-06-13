# TermPad

TermPad is a VS Code extension for drafting terminal commands in a real editor before sending them to the active terminal.

It is designed for Remote SSH and other high-latency terminal workflows: prepare commands with normal editor features, keep a shell-independent command history, then send exactly what you need when you are ready.

## Features

- Open an editable terminal command scratchpad with `Ctrl+Alt+G`.
- Use normal editor features while preparing commands: search, replace, Vim bindings, multi-cursor editing, snippets, and AI tools.
- Send the selected text, a marked block, a backslash-continued command, or the current line to the active terminal with `Ctrl+Alt+Enter`.
- Close a TermPad scratch buffer without sending or save prompts with `Ctrl+Alt+W`.
- Save edited history back from the scratchpad.
- Clear history with an automatic timestamped backup.
- Store history in VS Code global extension state. In Remote SSH, TermPad runs on the workspace extension host, so history is kept with that remote environment.

## Basic Usage

1. Run `TermPad: Open` or press `Ctrl+Alt+G`.
2. Edit or write a command in the scratchpad.
3. Press `Ctrl+Alt+Enter` to send it to the active terminal.

TermPad closes the scratchpad automatically after sending from a TermPad buffer. Sent commands are appended to TermPad history only after they are sent.

## Sending Commands

TermPad chooses what to send in this order:

1. Selected text.
2. The marked block around the cursor.
3. The backslash-continued command around the cursor.
4. The current line.

### Marked Blocks

Use `# ^^^` and `# $$$` to mark explicit multi-line command blocks:

```bash
# ^^^
docker compose \
  -f docker-compose.yml \
  up --build
# $$$
```

When the cursor is inside that block, `TermPad: Send Selection, Block, or Current Line` sends only the lines between the markers. The markers remain part of the history entry.

### Backslash Continuation

TermPad supports simple Bash-style line continuation with a trailing backslash:

```bash
find . \
  -name '*.js' \
  -print
```

Place the cursor on any line in the continued command and press `Ctrl+Alt+Enter`.

### Selected Blocks

If you select multiple lines and send them, TermPad sends the selected text and stores the history entry wrapped with block markers:

```bash
# ^^^
selected command lines
# $$$
```

## Editing History

Open TermPad, edit the history buffer like normal text, then run `TermPad: Save History From Editor`.

History parsing is intentionally simple:

- A `# ^^^` ... `# $$$` block is one history entry.
- A backslash-continued command is one history entry.
- Any other non-empty line is one history entry.
- Blank lines are ignored.
- Malformed blocks are rejected instead of being saved.

`TermPad: Clear History` writes a timestamped text backup before clearing and shows the backup path in a notification.

## Commands

- `TermPad: Open`
- `TermPad: Send Selection, Block, or Current Line`
- `TermPad: Save History From Editor`
- `TermPad: Close Without Saving`
- `TermPad: Clear History`

## Default Keybindings

| Keybinding | Command |
| --- | --- |
| `Ctrl+Alt+G` | `TermPad: Open` |
| `Ctrl+Alt+Enter` | `TermPad: Send Selection, Block, or Current Line` |
| `Ctrl+Alt+W` | `TermPad: Close Without Saving` |

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `termPad.maxHistory` | `200` | Maximum number of commands kept in shared history. |
| `termPad.createTerminalWhenMissing` | `true` | Create a terminal when there is no active terminal to receive a command. |
| `termPad.revealTerminalOnSend` | `true` | Reveal the active terminal after sending a command. |
| `termPad.editorLanguage` | `shellscript` | Language mode used for TermPad scratch buffers. |

## Development

Open this folder in VS Code and press `F5` to launch an Extension Development Host.

To package the extension locally:

```bash
npm install -g @vscode/vsce
vsce package
```

Then install the generated `.vsix` with:

```bash
code --install-extension termpad-0.1.0.vsix
```

Before publishing, make sure the `publisher` field in `package.json` matches your Visual Studio Marketplace publisher ID.
