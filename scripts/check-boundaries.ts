import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';

export function violations(file: string, content: string): string[] {
  const source = file.endsWith('.vue')
    ? [parse(content).descriptor.script?.content, parse(content).descriptor.scriptSetup?.content]
        .filter(Boolean)
        .join('\n')
    : content;
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(tree) === 'require')
    ) {
      if (node.arguments[0] && ts.isStringLiteral(node.arguments[0]))
        imports.push(node.arguments[0].text);
      else imports.push('UNVERIFIABLE_DYNAMIC_IMPORT');
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  const normalized = file.replaceAll('\\', '/');
  return imports
    .filter((specifier) => {
      const target = specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(normalized), specifier))
        : specifier;
      const node = specifier.startsWith('node:') || builtinModules.includes(specifier);
      if (specifier === 'UNVERIFIABLE_DYNAMIC_IMPORT') return true;
      if (normalized.startsWith('src/')) {
        if (target.startsWith('server/') || node) return true;
        if (
          normalized.startsWith('src/shared/') &&
          (target.startsWith('src/features/') ||
            target === 'src/App.vue' ||
            target === 'src/main.ts')
        )
          return true;
      }
      if (normalized.startsWith('server/') && target.startsWith('src/')) return true;
      return (
        normalized.startsWith('shared/') &&
        (node || target.startsWith('server/') || target.startsWith('src/') || specifier === 'vue')
      );
    })
    .map(
      (specifier) =>
        `${file}: запрещён импорт ${specifier}; соблюдайте границы из PROJECT_RULES.md`,
    );
}
export function checkTree(root: string) {
  const errors: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(ts|vue)$/.test(file))
        errors.push(...violations(file, readFileSync(path.join(root, file), 'utf8')));
    }
  }
  for (const dir of ['src', 'server', 'shared']) walk(dir);
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkTree(process.cwd());
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('Границы импортов соблюдены.');
}
