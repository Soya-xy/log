import * as vscode from 'vscode'
import { getActiveTextEditor, useConfiguration } from '@vscode-use/utils'
import { computeConsoleSegments, RemoveConsoleConfigInternal } from './removeUtil'

const removeConfig = useConfiguration<RemoveConsoleConfigInternal>('log.removeConsole')
const workspaceConfig = useConfiguration<{ includeGlobs: string[]; excludeGlobs: string[]; confirm: boolean }>('log.removeConsole.workspace')

let previewDecorationType: vscode.TextEditorDecorationType | undefined
let previewDecorationTimer: ReturnType<typeof setTimeout> | undefined

function toGlobUnion(patterns: string[] | undefined) {
  const list = (patterns || []).filter(Boolean)
  if (!list.length) return undefined
  if (list.length === 1) return list[0]
  return `{${list.join(',')}}`
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function decodeUtf8(bytes: Uint8Array) {
  let text = Buffer.from(bytes).toString('utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  return text
}

async function readWorkspaceText(uri: vscode.Uri) {
  const bytes = await vscode.workspace.fs.readFile(uri)
  return normalizeNewlines(decodeUtf8(bytes))
}

export async function removeConsoleLogs() {
  const editor = getActiveTextEditor()
  if (!editor) return
  const doc = editor.document
  const text = doc.getText()
  const cfg = removeConfig()
  const segments = computeConsoleSegments(text, cfg)
  if (!segments.length) return
  await editor.edit(builder => {
    segments.sort((a,b)=> b.start - a.start).forEach(seg => {
      builder.delete(new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)))
    })
  })
  vscode.window.setStatusBarMessage(`Removed ${segments.length} console statements`, 3000)
}

export async function previewRemoveConsoleLogs() {
  const editor = getActiveTextEditor()
  if (!editor) return
  const doc = editor.document
  const text = doc.getText()
  const cfg = removeConfig()
  const segments = computeConsoleSegments(text, cfg)
  if (!segments.length) {
    vscode.window.showInformationMessage('No console statements detected.')
    return
  }
  // Decorate ranges
  const decorations: vscode.DecorationOptions[] = segments.map(seg => ({
    range: new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)),
  }))
  if (previewDecorationTimer) clearTimeout(previewDecorationTimer)
  previewDecorationType?.dispose()
  previewDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
    isWholeLine: false,
    outline: '1px solid rgba(255,0,0,0.4)'
  })
  editor.setDecorations(previewDecorationType, decorations)
  vscode.window.showInformationMessage(`Previewing ${segments.length} console statements. Run removal command to apply.`)
  // Auto clear after 5s
  previewDecorationTimer = setTimeout(() => {
    previewDecorationType?.dispose()
    previewDecorationType = undefined
    previewDecorationTimer = undefined
  }, 5000)
}

export async function removeConsoleLogsWorkspace() {
  const cfgRemove = removeConfig()
  const cfgWs = workspaceConfig()
  const folders = vscode.workspace.workspaceFolders
  if (!folders || !folders.length) return
  const include = cfgWs.includeGlobs?.length ? cfgWs.includeGlobs : ['**/*.{js,jsx,ts,tsx}']
  const exclude = cfgWs.excludeGlobs?.length ? cfgWs.excludeGlobs : ['**/node_modules/**','**/dist/**']
  const includeGlob = toGlobUnion(include)
  const excludeGlob = toGlobUnion(exclude)

  if (cfgWs.confirm) {
    const ans = await vscode.window.showWarningMessage('Remove console statements in workspace?', { modal: true }, 'Yes')
    if (ans !== 'Yes') return
  }

  // Dry-run or execute?
  const mode = await vscode.window.showQuickPick(['Execute removal','Dry run (count only)'], { placeHolder: 'Select workspace console removal mode' })
  if (!mode) return
  const dryRun = mode.startsWith('Dry run')

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: dryRun ? 'Analyzing console statements...' : 'Removing console statements...', cancellable: true }, async (progress, token) => {
    let affectedFiles = 0
    let totalRemoved = 0
    let failedFiles = 0
    let saveFailedFiles = 0

    const allUris = await vscode.workspace.findFiles(includeGlob || '**/*.{js,jsx,ts,tsx}', excludeGlob)
    const total = allUris.length
    if (!total) {
      vscode.window.showInformationMessage('No files matched workspace removal include/exclude globs.')
      return
    }
    let processed = 0
    let lastReported = 0

    const concurrency = 10
    let index = 0
    async function worker() {
      while (index < allUris.length) {
        if (token.isCancellationRequested) return
        const current = allUris[index++]
        try {
          const diskText = await readWorkspaceText(current)
          if (diskText.includes('console')) {
            if (dryRun) {
              const segments = computeConsoleSegments(diskText, cfgRemove)
              if (segments.length) {
                affectedFiles++
                totalRemoved += segments.length
              }
            }
            else {
              // Pre-check with normalized disk text to avoid opening docs that won't match the configured methods.
              // Offsets may differ (CRLF), so this is only used as a yes/no filter; edits are based on TextDocument text.
              const maybeSegments = computeConsoleSegments(diskText, cfgRemove)
              if (maybeSegments.length) {
                if (token.isCancellationRequested) return
                const doc = await vscode.workspace.openTextDocument(current)
                const segments = computeConsoleSegments(doc.getText(), cfgRemove)
                if (segments.length) {
                  affectedFiles++
                totalRemoved += segments.length
                if (token.isCancellationRequested) return
                const edit = new vscode.WorkspaceEdit()
                segments.sort((a, b) => b.start - a.start).forEach((seg) => {
                  edit.delete(current, new vscode.Range(doc.positionAt(seg.start), doc.positionAt(seg.end)))
                })
                const applied = await vscode.workspace.applyEdit(edit)
                if (!applied) {
                  failedFiles++
                }
                else {
                  if (token.isCancellationRequested) return
                  const saved = await doc.save()
                  if (!saved) saveFailedFiles++
                  }
                }
              }
            }
          }
        } catch {
          failedFiles++
        }
        processed++
        if (processed - lastReported >= 20 || processed === total) {
          const prev = lastReported
          lastReported = processed
          const pct = total ? Math.round((processed / total) * 100) : 100
          progress.report({
            increment: total ? ((processed - prev) / total) * 100 : undefined,
            message: `${dryRun ? 'Analyzing' : 'Removing'} ${processed}/${total} (${pct}%) - affected: ${affectedFiles}, console: ${totalRemoved}, failed: ${failedFiles}${saveFailedFiles ? `, save failed: ${saveFailedFiles}` : ''}`,
          })
        }
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, allUris.length) }, () => worker())
    await Promise.all(workers)
    if (token.isCancellationRequested) {
      vscode.window.showInformationMessage(`Canceled. Processed ${processed}/${total}. Files affected: ${affectedFiles}, console statements ${dryRun ? 'found' : 'removed'}: ${totalRemoved}, failed files: ${failedFiles}${saveFailedFiles ? `, save failed: ${saveFailedFiles}` : ''}`)
      return
    }
    progress.report({ message: `${dryRun ? 'Analyzed' : 'Removed'} - Processed: ${processed}/${total}, affected: ${affectedFiles}, console: ${totalRemoved}, failed: ${failedFiles}${saveFailedFiles ? `, save failed: ${saveFailedFiles}` : ''}` })
    vscode.window.showInformationMessage(`${dryRun ? 'Dry run complete.' : 'Workspace removal complete.'} Processed: ${processed}/${total}. Files affected: ${affectedFiles}, console statements ${dryRun ? 'found' : 'removed'}: ${totalRemoved}, failed files: ${failedFiles}${saveFailedFiles ? `, save failed: ${saveFailedFiles}` : ''}`)
  })
}
