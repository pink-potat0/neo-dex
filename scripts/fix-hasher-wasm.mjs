import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = process.cwd();
const sourceDir = resolve(root, "node_modules/@lightprotocol/hasher.rs/dist");
const targets = [
  {
    src: resolve(sourceDir, "hasher_wasm_simd_bg.wasm"),
    dest: resolve(sourceDir, "browser-fat/es/hasher_wasm_simd_bg.wasm"),
  },
  {
    src: resolve(sourceDir, "light_wasm_hasher_bg.wasm"),
    dest: resolve(sourceDir, "browser-fat/es/light_wasm_hasher_bg.wasm"),
  },
];

for (const { src, dest } of targets) {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

const privacyTargets = [
  resolve(root, "node_modules/privacycash/dist/deposit.js"),
  resolve(root, "node_modules/privacycash/dist/depositSPL.js"),
];

const waitLoopPattern =
  /logger\.info\('Waiting for transaction confirmation\.\.\.'\);[\s\S]*?retryTimes\+\+;\s*\n\s*}\s*\n}/m;
const waitLoopReplacement = [
  "logger.info('Deposit relayed to Privacy Cash. Balance sync continues asynchronously.');",
  "return { tx: signature };",
  "}",
].join("\n    ");

for (const file of privacyTargets) {
  try {
    const current = await readFile(file, "utf8");
    if (current.includes("Balance sync continues asynchronously.")) continue;
    if (!waitLoopPattern.test(current)) continue;
    const next = current.replace(waitLoopPattern, waitLoopReplacement);
    await writeFile(file, next, "utf8");
  } catch {
    /* ignore if privacycash is not installed yet */
  }
}

console.log("Copied hasher wasm files for browser runtime.");
