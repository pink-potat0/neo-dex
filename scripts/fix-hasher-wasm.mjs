import { copyFile, mkdir } from "node:fs/promises";
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

console.log("Copied hasher wasm files for browser runtime.");
