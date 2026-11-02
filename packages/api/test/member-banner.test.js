import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bootstrapCatCatalog } from '../dist/config/cat-catalog-store.js';
import { loadResolvedCatConfig, parseRawCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import {
  MemberConfigurationConflict,
  memberConfigurationRevision,
  updateMemberWithRevision,
} from '../dist/config/member-config-revision.js';
import { createRuntimeCat, updateRuntimeCat } from '../dist/config/runtime-cat-catalog.js';

test('a member banner survives catalogue reload, stays variant-local, and can be removed', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'member-banner-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, 'cat-template.json');
  copyFileSync(new URL('../../../cat-template.json', import.meta.url), template);
  bootstrapCatCatalog(root, template);
  const member = (catId, breedId) => ({
    catId,
    ...(breedId ? { breedId } : {}),
    name: catId,
    displayName: catId,
    avatar: '/avatars/default.png',
    color: { primary: '#765843', secondary: '#eadccc' },
    mentionPatterns: [`@${catId}`],
    roleDescription: 'preview',
    configurationSource: 'native_tool',
    clientId: 'anthropic',
    carrier: 'cli',
    defaultModel: '',
    mcpSupport: false,
    cli: { command: 'claude', outputFormat: 'stream-json' },
  });
  await createRuntimeCat(root, { ...member('banner-one'), banner: '/uploads/avatar-sunset.jpg' });
  await createRuntimeCat(root, member('banner-two', 'banner-one'));
  let cats = toAllCatConfigs(loadResolvedCatConfig(template));
  assert.equal(cats['banner-one'].banner, '/uploads/avatar-sunset.jpg');
  assert.equal(cats['banner-two'].banner, undefined);
  await updateRuntimeCat(root, 'banner-two', { banner: '/uploads/avatar-study.webp' });
  cats = toAllCatConfigs(loadResolvedCatConfig(template));
  assert.equal(cats['banner-two'].banner, '/uploads/avatar-study.webp');
  assert.equal(cats['banner-one'].banner, '/uploads/avatar-sunset.jpg');
  await updateRuntimeCat(root, 'banner-one', { banner: null });
  cats = toAllCatConfigs(loadResolvedCatConfig(template));
  assert.equal(cats['banner-one'].banner, undefined);
  assert.equal(cats['banner-two'].banner, '/uploads/avatar-study.webp');
});

function templateFixture(context, banner) {
  const root = mkdtempSync(join(tmpdir(), 'template-banner-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const template = join(root, 'cat-template.json');
  const config = JSON.parse(readFileSync(new URL('../../../cat-template.json', import.meta.url), 'utf8'));
  const breed = config.breeds[0];
  const variant = breed.variants.find((entry) => entry.id === breed.defaultVariantId);
  variant.banner = banner;
  writeFileSync(template, JSON.stringify(config));
  bootstrapCatCatalog(root, template);
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(config));
  return { root, template, config, variant, catId: variant.catId ?? breed.catId };
}

test('removing a template-provided banner remains removed after reload and can be replaced', async (context) => {
  const { root, template, catId } = templateFixture(context, '/backgrounds/cafe-night.jpg');
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(template))[catId].banner, '/backgrounds/cafe-night.jpg');
  await updateRuntimeCat(root, catId, { banner: null });
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(template))[catId].banner, undefined);
  await updateRuntimeCat(root, catId, { banner: '/uploads/new-banner.webp' });
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(template))[catId].banner, '/uploads/new-banner.webp');
});

test('a template-only banner removal changes its member revision and rejects an older editor', async (context) => {
  const { root, template, config, variant, catId } = templateFixture(context, '/backgrounds/cafe-night.jpg');
  const path = join(root, '.cat-cafe/cat-catalog.json');
  // The catalogue has no override; only the template provides the effective banner.
  delete variant.banner;
  writeFileSync(path, JSON.stringify(config));
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(template))[catId].banner, '/backgrounds/cafe-night.jpg');
  const before = memberConfigurationRevision(root, catId);
  assert.ok(before);
  const siblingId = Object.keys(toAllCatConfigs(config)).find((id) => id !== catId);
  assert.ok(siblingId);
  const siblingRevision = memberConfigurationRevision(root, siblingId);
  await updateMemberWithRevision(root, catId, before, { banner: null });
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(template))[catId].banner, undefined);
  const after = memberConfigurationRevision(root, catId);
  assert.notEqual(after, before, 'absent and null overrides express different persisted intent');
  assert.equal(memberConfigurationRevision(root, siblingId), siblingRevision, 'another member keeps its revision');
  const removed = readFileSync(path, 'utf8');
  await assert.rejects(
    async () => updateMemberWithRevision(root, catId, before, { banner: '/uploads/stale-banner.jpg' }),
    MemberConfigurationConflict,
  );
  assert.equal(readFileSync(path, 'utf8'), removed);
  await updateMemberWithRevision(root, catId, after, { banner: '/uploads/new-banner.webp' });
  assert.equal(toAllCatConfigs(loadResolvedCatConfig(template))[catId].banner, '/uploads/new-banner.webp');
});

for (const banner of ['https://tracker.example/banner.jpg', '/uploads/../secret.png', 'data:image/png;base64,AAAA']) {
  test(`persisted banner validation rejects ${banner} before the writer changes disk`, async (context) => {
    const { root, template, config, variant, catId } = templateFixture(context, '/backgrounds/cafe-night.jpg');
    const path = join(root, '.cat-cafe/cat-catalog.json');
    const before = readFileSync(path, 'utf8');
    await assert.rejects(async () => updateRuntimeCat(root, catId, { banner }));
    assert.equal(readFileSync(path, 'utf8'), before);
    variant.banner = banner;
    assert.throws(() => parseRawCatConfig(JSON.stringify(config)));
    writeFileSync(template, JSON.stringify(config));
    writeFileSync(path, JSON.stringify(config));
    assert.throws(() => loadResolvedCatConfig(template));
  });
}
