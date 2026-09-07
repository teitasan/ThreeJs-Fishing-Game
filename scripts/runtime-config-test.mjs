#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  isMultiplayerAvailable,
  multiplayerWsUrl,
  multiplayerVoiceJoinUrl,
} from '../src/config/runtime.js';

const savedLocation = globalThis.location;

function withLocation(origin) {
  globalThis.location = {
    origin: new URL(origin).origin,
    hostname: new URL(origin).hostname,
    protocol: new URL(origin).protocol,
    host: new URL(origin).host,
  };
}

try {
  withLocation('http://localhost:8787');
  assert.equal(isMultiplayerAvailable(), true);
  assert.equal(multiplayerWsUrl(), 'ws://localhost:8787/ws?room=lake-1');
  assert.equal(multiplayerVoiceJoinUrl(), 'http://localhost:8787/api/voice/join?room=lake-1');
  assert.equal(multiplayerWsUrl('pond-2'), 'ws://localhost:8787/ws?room=pond-2');

  withLocation('https://lakeside-fishing.example.workers.dev');
  assert.equal(isMultiplayerAvailable(), true);
  assert.equal(multiplayerWsUrl(), 'wss://lakeside-fishing.example.workers.dev/ws?room=lake-1');

  withLocation('https://teitasan.github.io/ThreeJs-Fishing-Game/');
  assert.equal(isMultiplayerAvailable(), false);
  assert.equal(multiplayerWsUrl(), 'wss://teitasan.github.io/ws?room=lake-1');
} finally {
  globalThis.location = savedLocation;
}

console.log('OK runtime config: multiplayer gated on GitHub Pages, same-origin URLs elsewhere');
