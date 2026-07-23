import { gzipSync } from "node:zlib";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const DIST_DIR = path.resolve("dist");
const MANIFEST_PATH = path.join(DIST_DIR, ".vite", "manifest.json");
const INITIAL_GRAPH_GZIP_LIMIT = 360 * 1024;
const ASYNC_GRAPH_GZIP_LIMIT = 220 * 1024;
const SINGLE_CHUNK_GZIP_LIMIT = 200 * 1024;
const TOTAL_JS_GZIP_LIMIT = 600 * 1024;
const FONT_TRANSFER_LIMIT = 500 * 1024;

const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
const entries = Object.entries(manifest);
const entryRecords = entries.filter(([, record]) => record?.isEntry === true);
if (entryRecords.length !== 1) {
  throw new Error(`Bundle budget expected exactly one manifest entry, found ${entryRecords.length}.`);
}

const files = await listFiles(DIST_DIR);
const jsFiles = files.filter((file) => file.endsWith(".js"));
const fontFiles = files.filter((file) => /\.(?:woff2?|ttf|otf)$/i.test(file));
const jsSizeByFile = new Map(
  await Promise.all(jsFiles.map(async (file) => [
    file,
    gzipSync(await readFile(path.join(DIST_DIR, file))).byteLength
  ]))
);

const [entryKey] = entryRecords[0];
const initialKeys = staticClosure(entryKey);
const initialFiles = filesForKeys(initialKeys);
const initialBytes = sumFiles(initialFiles);
const totalJsBytes = sumFiles(new Set(jsFiles));
const dynamicRoots = [...initialKeys]
  .flatMap((key) => manifest[key]?.dynamicImports ?? [])
  .filter((key, index, all) => all.indexOf(key) === index);
const asyncGraphs = dynamicRoots.map((key) => {
  const graphKeys = staticClosure(key);
  const graphFiles = filesForKeys(graphKeys);
  for (const file of initialFiles) graphFiles.delete(file);
  return { key, files: graphFiles, gzipBytes: sumFiles(graphFiles) };
});
const fontBytes = (
  await Promise.all(fontFiles.map((file) => readFile(path.join(DIST_DIR, file)).then((content) => content.byteLength)))
).reduce((sum, size) => sum + size, 0);

const failures = [];
if (initialBytes > INITIAL_GRAPH_GZIP_LIMIT) {
  failures.push(
    `initial static graph is ${formatKiB(initialBytes)} gzip (limit ${formatKiB(INITIAL_GRAPH_GZIP_LIMIT)}): ${describeFiles(initialFiles)}`
  );
}
for (const graph of asyncGraphs.filter((item) => item.gzipBytes > ASYNC_GRAPH_GZIP_LIMIT)) {
  failures.push(
    `async graph ${graph.key} is ${formatKiB(graph.gzipBytes)} gzip (limit ${formatKiB(ASYNC_GRAPH_GZIP_LIMIT)}): ${describeFiles(graph.files)}`
  );
}
for (const [file, gzipBytes] of [...jsSizeByFile].filter(([, bytes]) => bytes > SINGLE_CHUNK_GZIP_LIMIT)) {
  failures.push(`chunk ${file} is ${formatKiB(gzipBytes)} gzip (limit ${formatKiB(SINGLE_CHUNK_GZIP_LIMIT)})`);
}
if (totalJsBytes > TOTAL_JS_GZIP_LIMIT) {
  failures.push(`total JavaScript is ${formatKiB(totalJsBytes)} gzip (limit ${formatKiB(TOTAL_JS_GZIP_LIMIT)})`);
}
if (fontBytes > FONT_TRANSFER_LIMIT) {
  failures.push(`font transfer is ${formatKiB(fontBytes)} (limit ${formatKiB(FONT_TRANSFER_LIMIT)})`);
}

const largestChunks = [...jsSizeByFile]
  .sort((left, right) => right[1] - left[1])
  .slice(0, 8)
  .map(([file, bytes]) => `${file}=${formatKiB(bytes)}`)
  .join(", ");
const asyncSummary = asyncGraphs
  .map((graph) => `${graph.key}=${formatKiB(graph.gzipBytes)}`)
  .join(", ");
console.log(
  `Bundle budget: initial=${formatKiB(initialBytes)} [${describeFiles(initialFiles)}], totalJs=${formatKiB(totalJsBytes)}, fonts=${formatKiB(fontBytes)}, async=[${asyncSummary}], largest=[${largestChunks}]`
);
if (failures.length) {
  throw new Error(`Bundle budget exceeded:\n- ${failures.join("\n- ")}`);
}

function staticClosure(rootKey) {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const record = manifest[key];
    if (!record) throw new Error(`Bundle manifest is missing imported record ${key}.`);
    visited.add(key);
    for (const imported of record.imports ?? []) visit(imported);
  };
  visit(rootKey);
  return visited;
}

function filesForKeys(keys) {
  const result = new Set();
  for (const key of keys) {
    const file = manifest[key]?.file;
    if (typeof file === "string" && file.endsWith(".js")) result.add(file);
  }
  return result;
}

function sumFiles(selectedFiles) {
  let total = 0;
  for (const file of selectedFiles) {
    const bytes = jsSizeByFile.get(file);
    if (bytes === undefined) throw new Error(`Bundle budget could not read emitted JavaScript ${file}.`);
    total += bytes;
  }
  return total;
}

function describeFiles(selectedFiles) {
  return [...selectedFiles]
    .sort((left, right) => (jsSizeByFile.get(right) ?? 0) - (jsSizeByFile.get(left) ?? 0))
    .map((file) => `${file}:${formatKiB(jsSizeByFile.get(file) ?? 0)}`)
    .join(", ");
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relative = path.posix.join(prefix, entry.name);
      return entry.isDirectory() ? listFiles(path.join(directory, entry.name), relative) : [relative];
    })
  );
  return nested.flat();
}

function formatKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}
