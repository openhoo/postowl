import { readFile, writeFile } from "node:fs/promises";

const cargoManifestPath = new URL("../src-tauri/Cargo.toml", import.meta.url);
const packageManifestPath = new URL("../package.json", import.meta.url);
const tauriConfigPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const check = process.argv.slice(2).includes("--check");

const cargoManifest = await readFile(cargoManifestPath, "utf8");
const packageHeader = cargoManifest.match(/^\[package\]\s*$/m);
const packageStart = packageHeader?.index;
const packageEnd =
  packageStart === undefined
    ? -1
    : cargoManifest.indexOf("\n[", packageStart + packageHeader[0].length);
const packageSection =
  packageStart === undefined
    ? ""
    : cargoManifest.slice(packageStart, packageEnd < 0 ? undefined : packageEnd);
const version = packageSection.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];

if (!version) {
  throw new Error("Could not read [package].version from src-tauri/Cargo.toml");
}

const targets = [
  ["package.json", packageManifestPath],
  ["src-tauri/tauri.conf.json", tauriConfigPath],
];
let drifted = false;

for (const [name, path] of targets) {
  const source = await readFile(path, "utf8");
  const document = JSON.parse(source);

  if (document.version === version) continue;
  drifted = true;

  if (check) {
    console.error(`${name}: expected version ${version}, found ${String(document.version)}`);
    continue;
  }

  document.version = version;
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`${name}: synchronized version to ${version}`);
}

if (check && drifted) process.exitCode = 1;
