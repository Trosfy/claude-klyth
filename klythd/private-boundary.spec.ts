// Only the two registries may cross into private modules; plugin tests stay outside that tree.
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { dirname, join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dir, '..')
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (dir === root && ['node_modules', '.git', '.claude'].includes(entry.name)) return []
    const path = join(dir, entry.name)
    return entry.isDirectory() ? sources(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : []
  })
}
const registries = new Set(['hooks/extras.ts', 'scripts/extras.ts'])
export function violations(files: readonly { path: string; text: string }[]): string[] {
  return files.flatMap(({ path, text }) => {
    const errors = path.startsWith('private/') && path.endsWith('.test.ts') ? [`${path}: plugin test in private tree`] : []
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const check = (specifier: string) => {
      if (!specifier.startsWith('.')) return
      const target = relative(root, resolve(root, dirname(path), specifier)).split(sep).join('/')
      if (target.startsWith('private/') && !path.startsWith('private/') && !registries.has(path)) errors.push(`${path}: private import`)
      if (path.startsWith('private/') && /^(hooks|scripts)\/extras(?:\.[cm]?[jt]s)?$/.test(target)) errors.push(`${path}: registry back-import`)
    }
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text)
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) check(node.moduleReference.expression.text)
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text)
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) check(node.argument.literal.text)
      ts.forEachChild(node, visit)
    }
    visit(source)
    return errors
  })
}

test('private module boundary and plugin test placement', () => {
  expect(violations(sources(root).map(file => ({ path: relative(root, file).split(sep).join('/'), text: readFileSync(file, 'utf8') })))).toEqual([])
})

test('boundary rejects nested private imports, registry cycles and misplaced plugin tests', () => {
  expect(violations([
    { path: 'hooks/bad.ts', text: "import { value } from '../private/client'" },
    { path: 'tests/nested/bad.ts', text: "const value = import('../../private/client')" },
    { path: 'private/client.ts', text: "import { value } from '../hooks/extras'" },
    { path: 'private/bad.test.ts', text: '' },
    { path: 'hooks/type.ts', text: "type Value = import('../private/client').Value" },
    { path: 'private/cycle.ts', text: "export { value } from '../scripts/extras'" },
  ])).toHaveLength(6)
  expect(violations([{ path: 'hooks/extras.ts', text: "export { value } from '../private/client'" }, { path: 'private/client.ts', text: "import { value } from '../hooks/extra-client'" }])).toEqual([])
})
