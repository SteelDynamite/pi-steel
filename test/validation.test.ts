import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("full validation runs heavyweight suites sequentially and stops on failure", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:all"], "npm run check && npm run check:modules && npm run check:packed");
});

test("root, module, and packed test launchers cap test-file concurrency", () => {
  const packages = [".", ...readdirSync(join(root, "extensions"), { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => join("extensions", entry.name))];
  for (const directory of packages) {
    const pkg = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    const runners = Object.values(pkg.scripts as Record<string, string>)
      .flatMap(script => script.match(/\b(?:node|tsx)\s+[^&|;]*?--test(?=\s|$)[^&|;]*/g) ?? []);
    assert(runners.length > 0, `${directory}: expected a Node test runner`);
    for (const runner of runners) {
      assert.match(runner, /(?:^|\s)--test-concurrency=1(?:\s|$)/, `${directory}: ${runner}`);
    }
  }
  const packed = readFileSync(join(root, "scripts/check-packed.mjs"), "utf8");
  assert.match(packed, /'--test', '--test-concurrency=1'/, "packed tests need the same concurrency limit");
});
