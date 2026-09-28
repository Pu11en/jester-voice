import assert from "node:assert/strict";
import test from "node:test";
import { AudioPlayerStatus } from "@discordjs/voice";
import {
  createPcmInput,
  createPlayedTimeTracker,
  downmixResample48kTo16kMono,
  voiceDebugWarning,
} from "./voice.mjs";

test("voice debug output never exposes session tokens or keys", () => {
  assert.equal(voiceDebugWarning('{"session_id":"secret","token":"secret","secret_key":[1,2]}'), null);
  assert.equal(voiceDebugWarning("[DAVE] Failed to decrypt a packet (2 consecutive fails)"),
    "[voice] DAVE audio packet decrypt failed");
});

function stereo(samples, left = (i) => samples[i], right = left) {
  const pcm = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i += 1) {
    pcm.writeInt16LE(left(i), i * 4);
    pcm.writeInt16LE(right(i), i * 4 + 2);
  }
  return pcm;
}

test("downmixes stereo and decimates 48 kHz PCM to 16 kHz mono", () => {
  const pcm = stereo([10, 20, 30, 40, 50, 60], () => 1000, () => -1000);
  const result = downmixResample48kTo16kMono(pcm);
  assert.equal(result.length, 4);
  assert.deepEqual([result.readInt16LE(0), result.readInt16LE(2)], [0, 0]);
});

test("keeps conversion phase and emits complete 32 ms worker frames", () => {
  const frames = [];
  const input = createPcmInput((frame) => frames.push(Buffer.from(frame)));
  const source = stereo(Array.from({ length: 1_536 }, () => 0), () => 1_000, () => 200);
  const chunkSizes = [20, 508, 1_004, 36];
  let chunkIndex = 0;
  for (let offset = 0; offset < source.length;) {
    const size = Math.min(chunkSizes[chunkIndex++ % chunkSizes.length], source.length - offset);
    input.write(source.subarray(offset, offset + size));
    offset += size;
  }
  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, 512 * 2);
  assert.equal(frames[0].readInt16LE(0), 600);
  assert.equal(frames[0].readInt16LE(frames[0].length - 2), 600);
});

test("counts only time spent in the playing state", () => {
  let time = 0;
  const played = createPlayedTimeTracker(() => time);
  played.begin("reply-1");
  played.transition(AudioPlayerStatus.Buffering, AudioPlayerStatus.Playing);
  time = 325;
  assert.equal(played.playedMs("reply-1"), 325);
  played.transition(AudioPlayerStatus.Playing, AudioPlayerStatus.Buffering);
  time = 900;
  assert.equal(played.playedMs("reply-1"), 325);
  played.transition(AudioPlayerStatus.Buffering, AudioPlayerStatus.Playing);
  time = 1_075;
  played.transition(AudioPlayerStatus.Playing, AudioPlayerStatus.Idle);
  assert.equal(played.playedMs("reply-1"), 500);
});
