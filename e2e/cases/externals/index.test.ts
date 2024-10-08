import { join } from 'node:path';
import { buildAndGetResults, proxyConsole } from '@e2e/helper';
import stripAnsi from 'strip-ansi';
import { expect, test } from 'vitest';
import { composeModuleImportWarn } from '../../../packages/core/src/config';

test('should fail to build when `output.target` is not "node"', async () => {
  const fixturePath = join(__dirname, 'browser');
  const build = buildAndGetResults(fixturePath);
  await expect(build).rejects.toThrowError('Rspack build failed!');
});

test('auto externalize Node.js built-in modules when `output.target` is "node"', async () => {
  const fixturePath = join(__dirname, 'node');
  const { entries } = await buildAndGetResults(fixturePath);

  for (const external of [
    'import * as __WEBPACK_EXTERNAL_MODULE_fs__ from "fs"',
    'import * as __WEBPACK_EXTERNAL_MODULE_node_assert__ from "node:assert"',
    'import * as __WEBPACK_EXTERNAL_MODULE_react__ from "react"',
    'import * as __WEBPACK_EXTERNAL_MODULE_bar__ from "bar"',
    'module.exports = __WEBPACK_EXTERNAL_createRequire(import.meta.url)("foo");',
  ]) {
    expect(entries.esm).toContain(external);
  }

  for (const external of [
    'var external_fs_namespaceObject = require("fs");',
    'var external_node_assert_namespaceObject = require("node:assert");',
    'var external_react_namespaceObject = require("react");',
    'module.exports = require("bar");',
    'module.exports = require("foo");',
  ]) {
    expect(entries.cjs).toContain(external);
  }
});

test('should get warn when use require in ESM', async () => {
  const { logs, restore } = proxyConsole();
  const fixturePath = join(__dirname, 'module-import-warn');
  const { entries } = await buildAndGetResults(fixturePath);
  const logStrings = logs.map((log) => stripAnsi(log));

  for (const external of [
    'import * as __WEBPACK_EXTERNAL_MODULE_bar__ from "bar";',
    'import * as __WEBPACK_EXTERNAL_MODULE_foo__ from "foo";',
  ]) {
    expect(entries.esm).toContain(external);
  }

  for (const external of ['foo', 'bar']) {
    expect(
      logStrings.some((l) =>
        l.includes(stripAnsi(composeModuleImportWarn(external))),
      ),
    ).toBe(true);
  }

  restore();
});
