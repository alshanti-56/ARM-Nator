import assert from 'node:assert/strict';
import test from 'node:test';
import { clampFloatingPlayerPosition } from './floating-player-position';

test('keeps an already visible floating player in its chosen position', () => {
  assert.deepEqual(clampFloatingPlayerPosition({ x: -100, y: -20 },
    { left: 200, top: 200, width: 560, height: 390 }, { width: 1000, height: 800 }), { x: -100, y: -20 });
});
test('brings a dragged player back into the window after resize or restore', () => {
  assert.deepEqual(clampFloatingPlayerPosition({ x: -600, y: 200 },
    { left: -200, top: 600, width: 560, height: 390 }, { width: 900, height: 700 }), { x: -392, y: -98 });
});
