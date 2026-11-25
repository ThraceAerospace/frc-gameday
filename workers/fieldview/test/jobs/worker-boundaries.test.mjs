import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../src/", import.meta.url));

async function listTypeScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [fullPath] : [];
  }));
  return groups.flat();
}

test("consolidated Worker source does not import retired sibling projects", async () => {
  const files = await listTypeScriptFiles(sourceRoot);
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (source.includes("fieldview-runtime/src/") || source.includes("fieldview-jobs/src/")) {
      offenders.push(path.relative(sourceRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});
