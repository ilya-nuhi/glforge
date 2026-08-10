import { WebIO, type Document, type JSONDocument } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import './style.css';

/** Anything in a glTF document that carries a name. */
interface Nameable {
  getName(): string;
  setName(name: string): unknown;
}

interface Row {
  prop: Nameable;
  original: string;
  input: HTMLInputElement;
  el: HTMLLIElement;
  revertBtn: HTMLButtonElement;
}

const CATEGORIES: { label: string; list: (doc: Document) => Nameable[] }[] = [
  { label: 'Scenes', list: (d) => d.getRoot().listScenes() },
  { label: 'Nodes', list: (d) => d.getRoot().listNodes() },
  { label: 'Meshes', list: (d) => d.getRoot().listMeshes() },
  { label: 'Skins', list: (d) => d.getRoot().listSkins() },
  { label: 'Materials', list: (d) => d.getRoot().listMaterials() },
  { label: 'Textures', list: (d) => d.getRoot().listTextures() },
  { label: 'Animations', list: (d) => d.getRoot().listAnimations() },
  { label: 'Cameras', list: (d) => d.getRoot().listCameras() },
];

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const dropSection = $('#drop-section');
const dropzone = $('#dropzone');
const fileInput = $<HTMLInputElement>('#file-input');
const browseBtn = $('#browse-btn');
const errorBanner = $('#error-banner');
const editor = $('#editor');
const fileNameEl = $('#file-name');
const fileStatsEl = $('#file-stats');
const gltfNote = $('#gltf-note');
const searchInput = $<HTMLInputElement>('#search-input');
const findInput = $<HTMLInputElement>('#find-input');
const replaceInput = $<HTMLInputElement>('#replace-input');
const regexToggle = $<HTMLInputElement>('#regex-toggle');
const replaceBtn = $<HTMLButtonElement>('#replace-btn');
const resetBtn = $('#reset-btn');
const closeBtn = $('#close-btn');
const exportBtn = $<HTMLButtonElement>('#export-btn');
const statusLine = $('#status-line');
const flash = $('#flash');
const sectionsEl = $('#sections');

let doc: Document | null = null;
let rows: Row[] = [];
let exportBaseName = 'model';
let flashTimer: ReturnType<typeof setTimeout> | undefined;

let ioPromise: Promise<WebIO> | null = null;

function getIO(): Promise<WebIO> {
  ioPromise ??= (async () => {
    await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
    return new WebIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({
        'meshopt.decoder': MeshoptDecoder,
        'meshopt.encoder': MeshoptEncoder,
      });
  })();
  return ioPromise;
}

// ---------------------------------------------------------------------------
// Loading

async function openFiles(files: File[]): Promise<void> {
  hideError();
  const modelFiles = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
  if (modelFiles.length === 0) {
    showError('Please drop a .glb or .gltf file.');
    return;
  }
  if (modelFiles.length > 1) {
    showError('Please drop one model at a time.');
    return;
  }

  const modelFile = modelFiles[0];
  const isGlb = /\.glb$/i.test(modelFile.name);

  try {
    const io = await getIO();
    let loaded: Document;

    if (isGlb) {
      loaded = await io.readBinary(new Uint8Array(await modelFile.arrayBuffer()));
    } else {
      const json = JSON.parse(await modelFile.text());
      const sidecars = new Map(files.filter((f) => f !== modelFile).map((f) => [f.name, f]));
      const resources: Record<string, Uint8Array> = {};
      const uris: string[] = [...(json.buffers ?? []), ...(json.images ?? [])]
        .map((entry: { uri?: string }) => entry.uri)
        .filter((uri): uri is string => !!uri && !uri.startsWith('data:'));

      const missing: string[] = [];
      for (const uri of new Set(uris)) {
        const baseName = decodeURIComponent(uri.split('/').pop() ?? uri);
        const file = sidecars.get(baseName) ?? sidecars.get(uri);
        if (!file) {
          missing.push(uri);
          continue;
        }
        resources[uri] = new Uint8Array(await file.arrayBuffer());
      }
      if (missing.length > 0) {
        showError(
          `This .gltf references external files that weren't provided: ${missing.join(', ')}. ` +
            'Drop or select the .gltf together with its .bin / texture files.',
        );
        return;
      }
      loaded = await io.readJSON({ json, resources } as unknown as JSONDocument);
    }

    doc = loaded;
    exportBaseName = modelFile.name.replace(/\.(glb|gltf)$/i, '');
    gltfNote.hidden = isGlb;
    fileNameEl.textContent = modelFile.name;
    buildEditor();
    dropSection.hidden = true;
    editor.hidden = false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/draco3d/i.test(message)) {
      showError('This file uses Draco mesh compression, which is not supported yet.');
    } else {
      showError(`Could not read the file: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Editor UI

function buildEditor(): void {
  sectionsEl.innerHTML = '';
  rows = [];
  searchInput.value = '';
  findInput.value = '';
  replaceInput.value = '';

  const stats: string[] = [];

  for (const category of CATEGORIES) {
    const props = category.list(doc!);
    if (props.length === 0) continue;
    stats.push(`${props.length} ${category.label}`);

    const section = document.createElement('section');
    section.className = 'category';

    const heading = document.createElement('h2');
    heading.textContent = category.label;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(props.length);
    heading.append(count);
    section.append(heading);

    const list = document.createElement('ul');
    props.forEach((prop, index) => {
      const item = document.createElement('li');
      item.className = 'row';

      const indexEl = document.createElement('span');
      indexEl.className = 'row-index';
      indexEl.textContent = String(index);

      const input = document.createElement('input');
      input.type = 'text';
      input.value = prop.getName();
      input.placeholder = '(unnamed)';
      input.spellcheck = false;
      input.setAttribute('aria-label', `${category.label} ${index} name`);

      const revertBtn = document.createElement('button');
      revertBtn.type = 'button';
      revertBtn.className = 'revert-btn';
      revertBtn.textContent = '↩';
      revertBtn.hidden = true;

      const row: Row = { prop, original: prop.getName(), input, el: item, revertBtn };

      input.addEventListener('input', () => {
        prop.setName(input.value);
        updateRowState(row);
        updateStatus();
      });
      revertBtn.addEventListener('click', () => {
        input.value = row.original;
        prop.setName(row.original);
        updateRowState(row);
        updateStatus();
      });

      item.append(indexEl, input, revertBtn);
      list.append(item);
      rows.push(row);
    });

    section.append(list);
    sectionsEl.append(section);
  }

  fileStatsEl.textContent = stats.join(' · ');
  updateStatus();
}

function updateRowState(row: Row): void {
  const modified = row.input.value !== row.original;
  row.el.classList.toggle('modified', modified);
  row.revertBtn.hidden = !modified;
  row.revertBtn.title = `Revert to “${row.original || '(unnamed)'}”`;
  row.input.title = modified ? `Original: ${row.original || '(unnamed)'}` : '';
}

function updateStatus(): void {
  const modified = rows.filter((row) => row.input.value !== row.original).length;
  statusLine.textContent = `${rows.length} names · ${modified} modified`;
}

function showFlash(message: string): void {
  flash.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (flash.textContent = ''), 3000);
}

// ---------------------------------------------------------------------------
// Filtering & find/replace

function applyFilter(): void {
  const query = searchInput.value.trim().toLowerCase();
  for (const row of rows) {
    const matches =
      query === '' ||
      row.input.value.toLowerCase().includes(query) ||
      row.original.toLowerCase().includes(query);
    row.el.hidden = !matches;
  }
  for (const section of sectionsEl.querySelectorAll<HTMLElement>('.category')) {
    const anyVisible = [...section.querySelectorAll<HTMLElement>('.row')].some((el) => !el.hidden);
    section.hidden = !anyVisible;
  }
}

function replaceAll(): void {
  const find = findInput.value;
  if (find === '') return;
  const replacement = replaceInput.value;

  let replacer: (value: string) => string;
  if (regexToggle.checked) {
    try {
      const re = new RegExp(find, 'g');
      replacer = (value) => value.replace(re, replacement);
    } catch {
      findInput.classList.add('invalid');
      showFlash('Invalid regular expression');
      return;
    }
  } else {
    replacer = (value) => value.split(find).join(replacement);
  }
  findInput.classList.remove('invalid');

  let changed = 0;
  for (const row of rows) {
    if (row.el.hidden) continue; // respect the active filter
    const next = replacer(row.input.value);
    if (next !== row.input.value) {
      row.input.value = next;
      row.prop.setName(next);
      updateRowState(row);
      changed++;
    }
  }
  updateStatus();
  showFlash(changed > 0 ? `Replaced in ${changed} name${changed === 1 ? '' : 's'}` : 'No matches');
}

// ---------------------------------------------------------------------------
// Export / reset / close

async function exportGlb(): Promise<void> {
  if (!doc) return;
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  try {
    const io = await getIO();
    const bytes = await io.writeBinary(doc);
    const blob = new Blob([bytes as BlobPart], { type: 'model/gltf-binary' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${exportBaseName}.glb`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    showFlash(`Export failed: ${message}`);
  } finally {
    exportBtn.disabled = false;
    exportBtn.textContent = 'Download .glb';
  }
}

function resetAll(): void {
  for (const row of rows) {
    row.input.value = row.original;
    row.prop.setName(row.original);
    updateRowState(row);
  }
  updateStatus();
  showFlash('All names reset');
}

function closeFile(): void {
  doc = null;
  rows = [];
  sectionsEl.innerHTML = '';
  editor.hidden = true;
  dropSection.hidden = false;
  fileInput.value = '';
}

// ---------------------------------------------------------------------------
// Errors

function showError(message: string): void {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function hideError(): void {
  errorBanner.hidden = true;
}

// ---------------------------------------------------------------------------
// Wiring

browseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) void openFiles([...fileInput.files]);
});

window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!dropSection.hidden) dropzone.classList.add('dragover');
});
window.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) dropzone.classList.remove('dragover');
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length > 0) void openFiles(files);
});

searchInput.addEventListener('input', applyFilter);
replaceBtn.addEventListener('click', replaceAll);
for (const input of [findInput, replaceInput]) {
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') replaceAll();
  });
}
findInput.addEventListener('input', () => findInput.classList.remove('invalid'));

exportBtn.addEventListener('click', () => void exportGlb());
resetBtn.addEventListener('click', resetAll);
closeBtn.addEventListener('click', closeFile);
