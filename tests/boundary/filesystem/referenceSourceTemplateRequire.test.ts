import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { importReferenceSource } from "../../support/referenceSourceResourceScope.js";

it("retains CommonJS requires spelled as exact no-substitution templates", async () => {
  const root = await createTestTempDirectory("rea-reference-template-require-");
  await writeFile(
    join(root, "main.cjs"),
    [
      'require("quoted");',
      "require(`templated`);",
      'const name = "dep";',
      "require(`./${name}.js`);",
      "import(`./${name}.js`);",
    ].join("\n"),
  );

  const result = await importReferenceSource({
    root,
    caller: "reference-template-require-test",
    policy: { secretPatterns: [] },
  });
  if (!result.ok) throw result.error;
  expect(result.value.parse_failures).toEqual([]);
  for (const to of ["quoted", "templated"]) {
    expect(result.value.relationships).toContainEqual({
      from_path: "main.cjs",
      to,
      kind: "requires",
      resolution: "external",
      parse_state: "parsed",
    });
  }
  expect(
    result.value.relationships.filter((relationship) =>
      relationship.to.includes("dep"),
    ),
  ).toEqual([]);
  expect(result.value.relationships).toContainEqual({
    from_path: "main.cjs",
    to: "<dynamic-import>",
    kind: "imports",
    resolution: "unknown",
    parse_state: "partial",
  });
});
