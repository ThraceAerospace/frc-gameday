import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/**
 * Load a dependency-free TypeScript module for Node's built-in test runner.
 *
 * This helper intentionally supports modules whose runtime imports are absent;
 * type-only imports are erased by TypeScript before the module is evaluated.
 */
export async function loadStandaloneTypeScriptModule(repositoryPath) {
  const absolutePath = path.resolve(process.cwd(), repositoryPath);
  const source = await readFile(absolutePath, "utf8");
  const result = ts.transpileModule(source, {
    fileName: absolutePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (errors.length > 0) {
    const message = errors
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      )
      .join("\n");
    throw new Error(`Unable to transpile ${repositoryPath}:\n${message}`);
  }

  const encoded = Buffer.from(result.outputText).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}
