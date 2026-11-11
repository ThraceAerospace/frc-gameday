import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const repositoryRoot = process.cwd();
const sourceRoot = path.join(repositoryRoot, "src");

async function collectTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectTypeScriptFiles(absolutePath)));
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(absolutePath);
    }
  }

  return files;
}

async function getImports(filePath) {
  const source = await readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  return sourceFile.statements
    .filter(
      (statement) =>
        (ts.isImportDeclaration(statement) ||
          ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier),
    )
    .map((statement) => statement.moduleSpecifier.text);
}

test("application and component modules do not bypass provider clients", async () => {
  const uiFiles = [
    ...(await collectTypeScriptFiles(path.join(sourceRoot, "app"))),
    ...(await collectTypeScriptFiles(path.join(sourceRoot, "components"))),
  ];
  const violations = [];

  for (const filePath of uiFiles) {
    for (const specifier of await getImports(filePath)) {
      if (/(?:^|\/)lib\/(?:tba|statbotics)\/client$/.test(specifier)) {
        violations.push(
          `${path.relative(repositoryRoot, filePath)} imports ${specifier}`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      "UI and route modules must use application-facing services, not low-level provider clients.",
      ...violations,
    ].join("\n"),
  );
});

test("raw generated provider schemas are imported only by their application type adapters", async () => {
  const files = await collectTypeScriptFiles(sourceRoot);
  const tbaGenerated = path.join(sourceRoot, "lib/tba/generated");
  const statboticsGenerated = path.join(sourceRoot, "lib/statbotics/generated");
  const allowedAdapters = new Set([
    path.join(sourceRoot, "lib/tba/types.ts"),
    path.join(sourceRoot, "lib/statbotics/types.ts"),
  ]);
  const violations = [];

  for (const filePath of files) {
    for (const specifier of await getImports(filePath)) {
      const target = specifier.startsWith("@/")
        ? path.join(sourceRoot, specifier.slice(2))
        : specifier.startsWith(".")
          ? path.resolve(path.dirname(filePath), specifier)
          : null;
      if (!target) continue;
      const isGeneratedSchema =
        target === tbaGenerated || target === statboticsGenerated;

      if (isGeneratedSchema && !allowedAdapters.has(filePath)) {
        violations.push(
          `${path.relative(repositoryRoot, filePath)} imports raw provider schema ${specifier}`,
        );
      }
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      "Import generated TBA/Statbotics schemas through the provider's application-facing types.ts module.",
      ...violations,
    ].join("\n"),
  );
});
