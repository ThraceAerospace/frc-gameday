import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const repositoryRoot = process.cwd();
const componentRoot = path.join(repositoryRoot, "src/components");

// Existing declarations are grandfathered by exact file and name. Move them
// into src/types in deliberate, test-backed migrations and remove each entry.
// Any new declaration in a component fails this check, including additions to
// a file that already has legacy declarations.
const existingLocalTypes = {
  "event/HomeEventCard.tsx": ["HomeEventCardProps"],
  "insights/EventAnalyticsDashboard.tsx": [
    "MatchFlagSummary",
    "MatchReviewFlag",
    "SortKey",
    "SortRule",
    "Tab",
    "TeamAnalysisTab",
    "TeamMatchAnalysis",
    "TeamMatchRow",
    "TeamSeasonHistory",
  ],
  "event/HomeMatchCard.tsx": ["HomeMatchCardProps"],
  "event/RankingsStrip.tsx": ["RankingsStripProps"],
  "event/EventFooter.tsx": ["EventFooterProps"],
  "eventview/EventView.tsx": ["EventViewProps"],
  "eventview/ImminentMatchBanner.tsx": ["ImminentMatchBannerProps"],
  "eventview/StreamModal.tsx": ["Props", "Stream"],
  "eventview/StreamView.tsx": ["Props", "Stream", "TwitchPlayer", "Window"],
  "match/EventInsightView.tsx": ["AllianceColor", "AllianceEstimates"],
  "match/MatchCard.tsx": ["MatchCardProps", "PlayoffAlliance"],
  "match/MatchInsightsPanel.tsx": ["Props"],
  "match/MatchRow.tsx": ["MatchRowProps"],
  "match/NextMatchCountdown.tsx": ["NextMatchCountdownProps"],
  "match/ScoreBreakdown.tsx": ["FieldRow", "FieldSection", "ScoreBreakdownProps"],
  "remote/RemoteEventCard.tsx": ["Props"],
  "remote/RemoteSession.tsx": ["Props"],
  "remote/RemoteTileSurface.tsx": ["Props"],
  "surface/EventInsightsSurface.tsx": ["EventInsightsSurfaceProps"],
  "surface/TileView.tsx": ["SurfaceUpcomingMatchAlert", "TileViewProps"],
  "surface/TileViewSurface.tsx": ["TileViewSurfaceProps"],
  "surface/TileSurfaceSettingsView.tsx": ["TileSurfaceSettingsViewProps"],
  "team/TeamEventsSidebar.tsx": ["SidebarEvent"],
  "team/TeamModal.tsx": ["TeamModalProps"],
  "ui/PageContainer.tsx": ["Props"],
  "ui/PageHeader.tsx": ["Props"],
  "ui/SectionHeading.tsx": ["Props"],
  "ui/SurfaceCard.tsx": ["Props"],
};

async function collectTsxFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTsxFiles(absolutePath)));
    } else if (entry.name.endsWith(".tsx")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function collectTypeDeclarationNames(sourceFile) {
  const names = [];
  function visit(node) {
    if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names.sort();
}

test("component-local type declarations cannot grow beyond the inventoried legacy baseline", async () => {
  const files = await collectTsxFiles(componentRoot);
  const actualFiles = new Set();
  const violations = [];

  for (const filePath of files) {
    const relativePath = path.relative(componentRoot, filePath).split(path.sep).join("/");
    const source = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const actualNames = collectTypeDeclarationNames(sourceFile);
    const expectedNames = existingLocalTypes[relativePath] ?? [];

    if (actualNames.length > 0) actualFiles.add(relativePath);
    if (JSON.stringify(actualNames) !== JSON.stringify([...expectedNames].sort())) {
      violations.push(
        `${relativePath}: found [${actualNames.join(", ")}], expected [${[...expectedNames].sort().join(", ")}]`,
      );
    }
  }

  for (const legacyPath of Object.keys(existingLocalTypes)) {
    if (!actualFiles.has(legacyPath)) {
      violations.push(`${legacyPath}: inventoried declarations no longer exist; remove this baseline entry`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    [
      "Do not add new type aliases or interfaces inside React component files.",
      "Move shared application types into src/types and import them.",
      ...violations,
    ].join("\n"),
  );
});
