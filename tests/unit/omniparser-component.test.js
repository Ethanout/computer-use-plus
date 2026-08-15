'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { OmniParserComponentClient, VisionCascadeClient, normalizeOmniParserResult } = require('../../src/omniparser-component');

test('OmniParser component converts image coordinates to screen coordinates', () => {
  const layout = normalizeOmniParserResult({
    version: 1,
    coordinateSpace: 'image',
    image: { width: 200, height: 100 },
    nodes: [{ id: 'contact', caption: 'Person', bbox: [20, 10, 60, 30], confidence: 0.9 }]
  }, { x: 100, y: 200, width: 400, height: 200 }, { windowId: 'qq' });
  assert.deepEqual(layout.windows[0].nodes[0].bounds, { x: 140, y: 220, width: 80, height: 40 });
  assert.equal(layout.windows[0].nodes[0].text, 'Person');
});

test('OmniParser component sends only an owned local image to a verified worker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cup-omni-'));
  const image = path.join(root, 'capture.png');
  fs.writeFileSync(image, Buffer.from('png'));
  const calls = [];
  const components = {
    activeManifestByCapability: () => ({ id: 'omni', version: '2', runtime: {}, capabilities: ['omniparser-detector'] })
  };
  const workers = {
    status: () => ({}),
    async start(id) { calls.push(['start', id]); },
    async request(id, payload) {
      calls.push(['request', id, payload]);
      return { version: 1, coordinateSpace: 'normalized', nodes: [{ bounds: { x: 0.1, y: 0.2, width: 0.2, height: 0.3 }, confidence: 0.8 }] };
    }
  };
  const client = new OmniParserComponentClient(components, workers, { allowedRoots: [root] });
  const layout = await client.inspectImage(image, { x: 10, y: 20, width: 100, height: 200 }, { windowId: 'w1', query: { text: 'button', secret: 'omit' } });
  assert.equal(layout.windows[0].nodes.length, 1);
  assert.equal(calls[1][2].image.path, fs.realpathSync(image));
  assert.deepEqual(calls[1][2].options.query, { text: 'button' });
  await assert.rejects(() => client.inspectImage(__filename, { x: 0, y: 0, width: 1, height: 1 }), /omniparser_image_path_not_allowed/);
});

test('vision cascade falls back when the local component fails', async () => {
  const local = { available: true, status: () => ({ configured: true }), inspectImage: async () => { throw new Error('local_failed'); } };
  const remote = { available: true, status: () => ({ configured: true }), inspectImage: async () => ({ windows: [] }) };
  const client = new VisionCascadeClient([local, remote]);
  assert.deepEqual(await client.inspectImage('unused', {}), { windows: [] });
});

