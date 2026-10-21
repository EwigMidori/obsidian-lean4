import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Checks architectural promises which ordinary behavioral tests cannot enforce:
 * production behavior belongs to an object, and inner layers do not import the UI
 * or a particular Lean transport.
 */
class ArchitectureAudit {
  constructor() {
    this.root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    this.sourceRoot = path.join(this.root, "src");
    this.violations = [];
    this.files = [];
  }

  run() {
    this.visitDirectory(this.sourceRoot);
    for (const file of this.files) this.checkFile(file);
    if (this.violations.length > 0) {
      for (const violation of this.violations) console.error(violation);
      process.exitCode = 1;
      return;
    }
    console.log(
      `Architecture checks passed for ${this.files.length} production TypeScript files: ` +
        "no module-level functions; domain/application dependencies point inward.",
    );
  }

  visitDirectory(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) this.visitDirectory(filename);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        this.files.push(filename);
      }
    }
  }

  checkFile(filename) {
    const source = ts.createSourceFile(
      filename,
      fs.readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const relativePath = path.relative(this.sourceRoot, filename).replaceAll("\\", "/");
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement)) {
        this.report(source, statement, "module-level function; give this behavior a class owner");
      }
      if (ts.isExportAssignment(statement) && this.isFunctionValue(statement.expression)) {
        this.report(source, statement, "exported function value; give this behavior a class owner");
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.initializer && this.isFunctionValue(declaration.initializer)) {
            this.report(source, declaration, "module-level function value; give this behavior a class owner");
          }
        }
      }
    }
    const layer = relativePath.split("/")[0];
    if (layer !== "domain" && layer !== "application") return;
    this.checkImports(source, source, layer);
  }

  isFunctionValue(node) {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
      return this.isFunctionValue(node.expression);
    }
    return false;
  }

  checkImports(source, node, layer) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      this.checkDependency(source, node, node.moduleSpecifier.text, layer);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      this.checkDependency(source, node, node.moduleReference.expression.text, layer);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) {
        this.report(source, node, `${layer} uses a dynamic dependency that cannot be audited`);
      } else this.checkDependency(source, node, argument.text, layer);
    }
    ts.forEachChild(node, (child) => this.checkImports(source, child, layer));
  }

  checkDependency(source, node, dependency, layer) {
    if (!dependency.startsWith(".")) {
      this.report(source, node, `${layer} imports external dependency "${dependency}"`);
      return;
    }
    const target = path.resolve(path.dirname(source.fileName), dependency);
    const relativeTarget = path.relative(this.sourceRoot, target).replaceAll("\\", "/");
    const targetLayer = relativeTarget.split("/")[0];
    const allowed = layer === "domain" ? ["domain"] : ["domain", "application"];
    if (!allowed.includes(targetLayer)) {
      this.report(source, node, `${layer} imports outside its boundary: "${dependency}"`);
    }
  }

  report(source, node, message) {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    const relativePath = path.relative(this.root, source.fileName).replaceAll("\\", "/");
    this.violations.push(`${relativePath}:${location.line + 1}:${location.character + 1}: ${message}`);
  }
}

new ArchitectureAudit().run();
