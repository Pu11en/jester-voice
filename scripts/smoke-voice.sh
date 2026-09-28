#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

node --input-type=module <<'NODE'
import { AudioPlayerStatus } from '@discordjs/voice';
import { loadConfig } from '../src/config.mjs';
import { createVoice } from '../src/voice.mjs';

function waitForStatus(player, status, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      player.off('stateChange', check);
      reject(new Error(`player did not reach ${status} within ${timeoutMs} ms`));
    }, timeoutMs);
    const check = (_oldState, newState) => {
      if (newState.status !== status) return;
      clearTimeout(timeout);
      player.off('stateChange', check);
      resolve();
    };
    player.on('stateChange', check);
    if (player.state.status === status) check(player.state, player.state);
  });
}

const config = await loadConfig();
const voice = createVoice({ config });
try {
  await voice.connect();
  const pcm = Buffer.alloc(48_000 * 4);
  for (let i = 0; i < 48_000; i += 1) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * i / 48_000) * 4_000);
    pcm.writeInt16LE(value, i * 4);
    pcm.writeInt16LE(value, i * 4 + 2);
  }
  const playing = waitForStatus(voice.player, AudioPlayerStatus.Playing, 5_000);
  voice.play('smoke-tone', pcm);
  await playing;
  await waitForStatus(voice.player, AudioPlayerStatus.Idle, 5_000);
  console.log(`Played one second tone; Discord reported ${voice.playedMs('smoke-tone')} ms played.`);
} finally {
  await voice.destroy();
}
NODE
