#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module <<'NODE'
import { Brain } from "./src/brain.mjs";

const brain = new Brain();
try {
  await brain.prewarm();
  for await (const sentence of brain.ask("Say hello in one short sentence.")) {
    console.log(sentence);
  }
} finally {
  await brain.close();
}
NODE
