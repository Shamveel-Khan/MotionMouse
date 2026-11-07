// Synthetic-only checks. Supplied for the user; not executed by the agent.
import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateFlow } from '../frontend/src/optical-flow.ts';

const width = 160, height = 120;
function texture(seed = 12345) {
  const image = new Uint8Array(width * height);
  for (let i = 0; i < image.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    image[i] = 20 + (seed >>> 24) % 180;
  }
  return image;
}
function translate(image, dx, dy) {
  const result = new Uint8Array(image.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tx = x + dx, ty = y + dy;
      if (tx >= 0 && tx < width && ty >= 0 && ty < height) result[ty * width + tx] = image[y * width + x];
    }
  }
  return result;
}

test('stationary texture reports no motion', () => {
  const image = texture();
  const result = estimateFlow(image, image, width, height);
  assert.ok(result.quality >= 0.6);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
});

test('detects scene displacement in both directions', () => {
  const image = texture();
  for (const [dx, dy] of [[3, -2], [-4, 3]]) {
    const result = estimateFlow(image, translate(image, dx, dy), width, height);
    assert.ok(result.quality >= 0.6);
    assert.ok(Math.abs(result.dx - dx) < 0.4);
    assert.ok(Math.abs(result.dy - dy) < 0.4);
  }
});

test('uniform brightness changes are not translation', () => {
  const image = texture();
  const brighter = Uint8Array.from(image, value => value + 15);
  const result = estimateFlow(image, brighter, width, height);
  assert.ok(result.quality >= 0.6);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
});

test('a blank surface does not produce confident motion', () => {
  const blank = new Uint8Array(width * height).fill(100);
  const result = estimateFlow(blank, blank, width, height);
  assert.equal(result.quality, 0);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
});

test('unrelated frames are rejected instead of moving the cursor', () => {
  const result = estimateFlow(texture(1), texture(987654), width, height);
  assert.equal(result.quality, 0);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
});
