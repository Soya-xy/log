import * as ts from 'typescript'

export interface InsertionContext {
  source: string
  offset: number
  currentLine: number
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

export function computeInsertionLine(ctx: InsertionContext): number | undefined {
  const sf = ts.createSourceFile('tmp.ts', ctx.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let bestNode: ts.Node | undefined

  function visit(node: ts.Node) {
    // Check if offset is within this node
    if (ctx.offset >= node.pos && ctx.offset < node.end) {
      // If this is a target kind and spans multiple lines beyond current
      if (targetKinds.has(node.kind)) {
        const endLine = sf.getLineAndCharacterOfPosition(node.end).line
        if (endLine > ctx.currentLine) {
          // Choose the outermost enclosing node that ends latest
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

  if (!bestNode) return undefined
  
  const endLine = sf.getLineAndCharacterOfPosition(bestNode.end).line
  return endLine + 1
}
