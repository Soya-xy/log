import * as ts from 'typescript'

export interface InsertionContext {
  source: string
  offset: number
  currentLine: number
}

interface NormalizedInsertionContext extends InsertionContext {
  lineOffset: number
  isVueScript: boolean
}

// Kinds to consider when deciding expression boundary
const targetKinds = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.CallExpression,
  ts.SyntaxKind.NewExpression,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.ArrowFunction,
])

const vueOptionContainerProperties = new Set([
  'components',
  'computed',
  'directives',
  'filters',
  'inject',
  'methods',
  'props',
  'provide',
  'watch',
])

export function computeInsertionLine(ctx: InsertionContext): number | undefined {
  const normalized = normalizeVueScriptContext(ctx)
  const sf = ts.createSourceFile('tmp.ts', normalized.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let bestNode: ts.Node | undefined

  function visit(node: ts.Node) {
    // Check if offset is within this node
    if (normalized.offset >= node.pos && normalized.offset < node.end) {
      // If this is a target kind and spans multiple lines beyond current
      if (targetKinds.has(node.kind) && (!normalized.isVueScript || !isVueStructuralContainer(node))) {
        const endLine = sf.getLineAndCharacterOfPosition(node.end).line
        if (endLine > normalized.currentLine) {
          // Choose the outermost enclosing expression that ends latest, but not Vue option containers
          if (!bestNode || node.end > bestNode.end) {
            bestNode = node
          }
        }
      }
      // Continue visiting children
      node.forEachChild(visit)
    }
  }
  visit(sf)

  if (!bestNode)
    return undefined

  const endLine = sf.getLineAndCharacterOfPosition(bestNode.end).line
  return normalized.lineOffset + endLine + 1
}

function normalizeVueScriptContext(ctx: InsertionContext): NormalizedInsertionContext {
  const script = findVueScriptBlock(ctx.source, ctx.offset)
  if (!script)
    return { ...ctx, lineOffset: 0, isVueScript: false }

  const lineOffset = getLineOfPosition(ctx.source, script.contentStart)
  return {
    source: ctx.source.slice(script.contentStart, script.contentEnd),
    offset: ctx.offset - script.contentStart,
    currentLine: ctx.currentLine - lineOffset,
    lineOffset,
    isVueScript: true,
  }
}

function findVueScriptBlock(source: string, offset: number) {
  const pattern = /<script\b[^>]*>/gi
  let match: RegExpExecArray | null
  let contentStart = -1

  while (true) {
    match = pattern.exec(source)
    if (!match || match.index > offset)
      break

    contentStart = match.index + match[0].length
  }

  if (contentStart === -1 || offset < contentStart)
    return undefined

  const contentEnd = source.indexOf('</script>', contentStart)
  if (contentEnd === -1 || offset >= contentEnd)
    return undefined

  return { contentStart, contentEnd }
}

function getLineOfPosition(source: string, position: number) {
  return source.slice(0, position).split('\n').length - 1
}

function isVueStructuralContainer(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isExportAssignment(node.parent))
    return true

  if (!ts.isObjectLiteralExpression(node))
    return false

  const { parent } = node
  if (!parent)
    return false

  if (ts.isExportAssignment(parent))
    return true

  if (ts.isCallExpression(parent) && ts.isExportAssignment(parent.parent))
    return true

  if (ts.isPropertyAssignment(parent)) {
    const name = getPropertyNameText(parent.name)
    return !!name && vueOptionContainerProperties.has(name) && isVueComponentOptionsObject(parent.parent)
  }

  return false
}

function isVueComponentOptionsObject(node: ts.Node) {
  if (!ts.isObjectLiteralExpression(node))
    return false

  const { parent } = node
  return ts.isExportAssignment(parent) || (ts.isCallExpression(parent) && ts.isExportAssignment(parent.parent))
}

function getPropertyNameText(name: ts.PropertyName) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text

  return undefined
}
