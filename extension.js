const vscode = require('vscode');

const EXTENSION_NAME = 'TermPad';
const HISTORY_KEY = 'termPad.history';
const LEGACY_HISTORY_KEY = 'commandEditor.history';
const BLOCK_START_MARKER = '# ^^^';
const BLOCK_END_MARKER = '# $$$';
const OPEN_BACKUP_ACTION = 'Open Backup';

const termPadDocuments = new Set();

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  await migrateLegacyHistory(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('termPad.open', () => openTermPad(context)),
    vscode.commands.registerCommand('termPad.send', () => sendFromEditor(context)),
    vscode.commands.registerCommand('termPad.saveHistoryFromEditor', () => saveHistoryFromEditor(context)),
    vscode.commands.registerCommand('termPad.closeWithoutSaving', closeWithoutSaving),
    vscode.commands.registerCommand('termPad.clearHistory', () => clearHistory(context)),
    vscode.window.onDidChangeActiveTextEditor(updateTermPadContext),
    vscode.workspace.onDidCloseTextDocument((document) => {
      termPadDocuments.delete(document.uri.toString());
      updateTermPadContext(vscode.window.activeTextEditor);
    })
  );

  updateTermPadContext(vscode.window.activeTextEditor);
}

function deactivate() {}

/**
 * @param {vscode.ExtensionContext} context
 */
async function openTermPad(context) {
  const document = await vscode.workspace.openTextDocument({
    content: formatHistoryForEditor(getHistory(context)),
    language: getConfig().get('editorLanguage', 'shellscript')
  });
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false
  });
  const cursor = new vscode.Position(document.lineCount - 1, 0);

  termPadDocuments.add(document.uri.toString());
  updateTermPadContext(editor);
  editor.selection = new vscode.Selection(cursor, cursor);
  editor.revealRange(new vscode.Range(cursor, cursor));
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function sendFromEditor(context) {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showWarningMessage('No active editor to read a command from.');
    return;
  }

  const commandEntry = getCommandEntry(editor);

  if (!commandEntry.command) {
    vscode.window.showWarningMessage('No command found to send.');
    return;
  }

  const sent = await sendToTerminal(commandEntry.command);

  if (!sent) {
    return;
  }

  await appendHistory(context, commandEntry.history);

  if (isTermPadDocument(editor.document)) {
    await closeActiveEditorWithoutSaving();
  }
}

async function closeWithoutSaving() {
  const editor = vscode.window.activeTextEditor;

  if (!editor || !isTermPadDocument(editor.document)) {
    vscode.window.showWarningMessage('No TermPad buffer is active.');
    return;
  }

  await closeActiveEditorWithoutSaving();
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function saveHistoryFromEditor(context) {
  const editor = vscode.window.activeTextEditor;

  if (!editor || !isTermPadDocument(editor.document)) {
    vscode.window.showWarningMessage('No TermPad buffer is active.');
    return;
  }

  let entries;

  try {
    entries = parseHistoryEntries(editor.document.getText());
  } catch (error) {
    vscode.window.showWarningMessage(error.message);
    return;
  }

  const history = normalizeHistory(entries);
  await context.globalState.update(HISTORY_KEY, history);
  vscode.window.showInformationMessage(`${EXTENSION_NAME} history saved with ${history.length} entr${history.length === 1 ? 'y' : 'ies'}.`);
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function clearHistory(context) {
  const backupUri = await backupHistory(context);

  await context.globalState.update(HISTORY_KEY, []);

  const choice = await vscode.window.showInformationMessage(
    `${EXTENSION_NAME} history cleared. Backup saved: ${backupUri.fsPath}`,
    OPEN_BACKUP_ACTION
  );

  if (choice === OPEN_BACKUP_ACTION) {
    const document = await vscode.workspace.openTextDocument(backupUri);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}

/**
 * @param {string} command
 * @returns {Promise<boolean>}
 */
async function sendToTerminal(command) {
  const terminal = getTargetTerminal();

  if (!terminal) {
    return false;
  }

  terminal.sendText(command, true);

  if (getConfig().get('revealTerminalOnSend')) {
    terminal.show();
  }

  return true;
}

/**
 * @param {vscode.TextEditor} editor
 */
function getCommandEntry(editor) {
  if (!editor.selection.isEmpty) {
    const command = editor.document.getText(editor.selection).trim();

    return {
      command,
      history: wrapWithBlockMarkers(command)
    };
  }

  const markedBlock = getMarkedBlock(editor.document, editor.selection.active.line);

  if (markedBlock) {
    return markedBlock;
  }

  return getBackslashCommand(editor.document, editor.selection.active.line);
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} activeLine
 */
function getMarkedBlock(document, activeLine) {
  const startLine = findNearestBlockStart(document, activeLine);

  if (startLine === undefined) {
    return undefined;
  }

  const endLine = findBlockEnd(document, startLine);

  if (endLine === undefined || activeLine >= endLine) {
    return undefined;
  }

  const command = endLine > startLine + 1
    ? getLineRangeText(document, startLine + 1, endLine - 1).trim()
    : '';

  return {
    command,
    history: getLineRangeText(document, startLine, endLine).trim()
  };
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} activeLine
 */
function findNearestBlockStart(document, activeLine) {
  for (let lineNumber = activeLine; lineNumber >= 0; lineNumber -= 1) {
    const line = document.lineAt(lineNumber).text;

    if (isBlockStartMarker(line)) {
      return lineNumber;
    }

    if (isBlockEndMarker(line)) {
      return undefined;
    }
  }

  return undefined;
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} startLine
 */
function findBlockEnd(document, startLine) {
  for (let lineNumber = startLine + 1; lineNumber < document.lineCount; lineNumber += 1) {
    if (isBlockEndMarker(document.lineAt(lineNumber).text)) {
      return lineNumber;
    }
  }

  return undefined;
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} activeLine
 */
function getBackslashCommand(document, activeLine) {
  let startLine = activeLine;
  let endLine = activeLine;

  while (startLine > 0 && hasTrailingContinuation(document.lineAt(startLine - 1).text)) {
    startLine -= 1;
  }

  while (endLine < document.lineCount - 1 && hasTrailingContinuation(document.lineAt(endLine).text)) {
    endLine += 1;
  }

  const command = getLineRangeText(document, startLine, endLine).trim();

  return {
    command,
    history: command
  };
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} startLine
 * @param {number} endLine
 */
function getLineRangeText(document, startLine, endLine) {
  const start = new vscode.Position(startLine, 0);
  const endTextLine = document.lineAt(endLine);
  const end = new vscode.Position(endLine, endTextLine.text.length);

  return document.getText(new vscode.Range(start, end));
}

/**
 * @param {string} command
 */
function wrapWithBlockMarkers(command) {
  if (!command || hasBlockMarkers(command)) {
    return command;
  }

  return `${BLOCK_START_MARKER}\n${command}\n${BLOCK_END_MARKER}`;
}

/**
 * @param {string} text
 */
function hasBlockMarkers(text) {
  const lines = text.trim().split(/\r?\n/);

  return lines.length >= 2 && isBlockStartMarker(lines[0]) && isBlockEndMarker(lines[lines.length - 1]);
}

/**
 * @param {string} line
 */
function isBlockStartMarker(line) {
  return line.trim() === BLOCK_START_MARKER;
}

/**
 * @param {string} line
 */
function isBlockEndMarker(line) {
  return line.trim() === BLOCK_END_MARKER;
}

/**
 * @param {string} line
 */
function hasTrailingContinuation(line) {
  let backslashCount = 0;

  for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index -= 1) {
    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

/**
 * @param {string} content
 */
function parseHistoryEntries(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      continue;
    }

    if (isBlockEndMarker(line)) {
      throw new Error(`Unexpected ${BLOCK_END_MARKER} at line ${index + 1}.`);
    }

    if (!isBlockStartMarker(line)) {
      const commandLines = [line];

      while (hasTrailingContinuation(commandLines[commandLines.length - 1]) && index < lines.length - 1) {
        index += 1;
        commandLines.push(lines[index]);
      }

      entries.push(commandLines.join('\n').trim());
      continue;
    }

    const blockStartLine = index + 1;
    const blockLines = [line.trim()];
    let foundEnd = false;

    for (index += 1; index < lines.length; index += 1) {
      blockLines.push(lines[index]);

      if (isBlockEndMarker(lines[index])) {
        foundEnd = true;
        break;
      }
    }

    if (!foundEnd) {
      throw new Error(`Missing ${BLOCK_END_MARKER} for block starting at line ${blockStartLine}.`);
    }

    entries.push(blockLines.join('\n').trim());
  }

  return entries;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function getHistory(context) {
  const value = context.globalState.get(HISTORY_KEY, []);

  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {string} command
 */
async function appendHistory(context, command) {
  const maxHistory = getConfig().get('maxHistory', 200);
  const existing = getHistory(context);
  const history = [
    command.trim(),
    ...existing.filter((entry) => entry !== command.trim())
  ].filter(Boolean).slice(0, maxHistory);

  await context.globalState.update(HISTORY_KEY, history);
}

/**
 * @param {string[]} entries Entries ordered oldest to newest.
 */
function normalizeHistory(entries) {
  const maxHistory = getConfig().get('maxHistory', 200);
  const newestFirst = [];

  for (const entry of [...entries].reverse()) {
    const trimmed = entry.trim();

    if (trimmed && !newestFirst.includes(trimmed)) {
      newestFirst.push(trimmed);
    }

    if (newestFirst.length >= maxHistory) {
      break;
    }
  }

  return newestFirst;
}

/**
 * @param {string[]} history History ordered newest to oldest.
 */
function formatHistoryForEditor(history) {
  return history.length === 0 ? '' : `${[...history].reverse().join('\n\n')}\n`;
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function backupHistory(context) {
  const backupDirectory = vscode.Uri.joinPath(context.globalStorageUri, 'history-backups');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupUri = vscode.Uri.joinPath(backupDirectory, `history-backup-${timestamp}.txt`);
  const content = formatHistoryForEditor(getHistory(context));

  await vscode.workspace.fs.createDirectory(backupDirectory);
  await vscode.workspace.fs.writeFile(backupUri, Buffer.from(content, 'utf8'));

  return backupUri;
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function migrateLegacyHistory(context) {
  const hasTermPadHistory = Array.isArray(context.globalState.get(HISTORY_KEY));
  const legacyHistory = context.globalState.get(LEGACY_HISTORY_KEY);

  if (hasTermPadHistory || !Array.isArray(legacyHistory)) {
    return;
  }

  await context.globalState.update(HISTORY_KEY, legacyHistory);
}

function getTargetTerminal() {
  const activeTerminal = vscode.window.activeTerminal;

  if (activeTerminal) {
    return activeTerminal;
  }

  if (!getConfig().get('createTerminalWhenMissing')) {
    vscode.window.showWarningMessage('No active terminal to receive the command.');
    return undefined;
  }

  return vscode.window.createTerminal(EXTENSION_NAME);
}

/**
 * @param {vscode.TextDocument} document
 */
function isTermPadDocument(document) {
  return termPadDocuments.has(document.uri.toString());
}

/**
 * @param {vscode.TextEditor | undefined} editor
 */
function updateTermPadContext(editor) {
  vscode.commands.executeCommand('setContext', 'termPad.bufferActive', Boolean(editor && isTermPadDocument(editor.document)));
}

async function closeActiveEditorWithoutSaving() {
  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
}

function getConfig() {
  return vscode.workspace.getConfiguration('termPad');
}

module.exports = {
  activate,
  deactivate
};
