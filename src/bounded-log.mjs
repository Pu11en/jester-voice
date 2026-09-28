import { appendFile, readFile, stat, writeFile } from "node:fs/promises";

/** Append one record and retain the newest complete records within a byte cap. */
export async function appendBounded(path, line, maxBytes, headerLines = 0) {
  await appendFile(path, line, "utf8");
  const info = await stat(path);
  if (info.size <= maxBytes) return;
  const content = await readFile(path, "utf8");
  const lines = content.split(/(?<=\n)/);
  const header = lines.splice(0, headerLines).join("");
  let tail = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (Buffer.byteLength(header + lines[index] + tail) > maxBytes) break;
    tail = lines[index] + tail;
  }
  await writeFile(path, header + tail, "utf8");
}
