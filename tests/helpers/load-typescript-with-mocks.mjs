import Module from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

/**
 * Load a TypeScript module after transpilation, replacing selected runtime
 * imports with deterministic test doubles. Type-only imports are erased.
 */
export async function loadTypeScriptModuleWithMocks(repositoryPath, mocks = {}) {
  const absolutePath = path.resolve(process.cwd(), repositoryPath);
  const source = await readFile(absolutePath, "utf8");
  const result = ts.transpileModule(source, {
    fileName: absolutePath,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
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

  const loadedModule = new Module(absolutePath);
  loadedModule.filename = absolutePath;
  loadedModule.paths = Module._nodeModulePaths(path.dirname(absolutePath));
  const originalRequire = loadedModule.require.bind(loadedModule);
  loadedModule.require = (specifier) =>
    Object.hasOwn(mocks, specifier) ? mocks[specifier] : originalRequire(specifier);
  loadedModule._compile(result.outputText, absolutePath);
  return loadedModule.exports;
}
