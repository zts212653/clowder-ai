import assert from 'node:assert/strict';
import test from 'node:test';

import { buildUpdatedYaml, extractPlaceholders, extractVarComments } from './populate-hook-variables.mjs';

test('extracts unique placeholders and their inline descriptions in source order', () => {
  const raw = [
    '<!-- Variable: {{FIRST}} - first description -->',
    '{{FIRST}} / {{SECOND}} / {{FIRST}}',
    '<!-- Variable: {{SECOND}} — second description -->',
  ].join('\n');

  assert.deepEqual(extractPlaceholders(raw), ['FIRST', 'SECOND']);
  assert.deepEqual(
    [...extractVarComments(raw)],
    [
      ['FIRST', 'first description'],
      ['SECOND', 'second description'],
    ],
  );
});

test('merges variable metadata without losing existing descriptions or placeholders', () => {
  const original = [
    'id: sample-hook',
    'title: Sample',
    '',
    '# Variable metadata (canonical source for Console editor)',
    'variables:',
    '  - name: FIRST',
    '    description: existing description',
    '    placeholder: "existing placeholder"',
    '',
    '# Override constraints',
    'disableable: true',
    '',
  ].join('\n');
  const raw = [
    '<!-- Variable: {{FIRST}} - source description should not win -->',
    '<!-- Variable: {{SECOND}} - source description -->',
    '{{FIRST}} / {{SECOND}} / {{FIRST}}',
  ].join('\n');

  const updated = buildUpdatedYaml(original, 'sample-hook', raw);
  assert.ok(updated);
  assert.match(updated, /description: existing description/);
  assert.match(updated, /placeholder: "existing placeholder"/);
  assert.match(updated, /description: source description/);
  assert.equal((updated.match(/- name: FIRST/g) ?? []).length, 1);
  assert.equal((updated.match(/- name: SECOND/g) ?? []).length, 1);
  assert.equal(buildUpdatedYaml(updated, 'sample-hook', raw), updated);
});

test('inserts metadata before override constraints and ignores templates without variables', () => {
  const original = ['id: sample-hook', 'title: Sample', '', '# Override constraints', 'disableable: true', ''].join(
    '\n',
  );

  const updated = buildUpdatedYaml(original, 'sample-hook', '{{CONTENT}}');
  assert.ok(updated);
  assert.ok(updated.indexOf('variables:') < updated.indexOf('# Override constraints'));
  assert.equal(buildUpdatedYaml(original, 'sample-hook', 'no placeholders here'), null);
});
