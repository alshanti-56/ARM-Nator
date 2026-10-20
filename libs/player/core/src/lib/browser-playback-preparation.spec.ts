import {strict as assert} from 'node:assert';
import test from 'node:test';
import {browserPlaybackPreparation} from './browser-playback-preparation';
test('direct browser preparation uses path hints and creates distinct ownership without fetching',()=>{
  const first=browserPlaybackPreparation('https://media.example/movie.mp4?token=fixture');
  const second=browserPlaybackPreparation(first.url);
  assert.equal(first.format,'progressive');assert.equal(first.container,'mp4');assert.equal(first.processingMode,'direct');
  assert.notEqual(first.id,second.id);
  assert.equal(browserPlaybackPreparation('https://media.example/watch?file=movie.m3u8').format,'unknown');
});
