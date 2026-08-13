/* UI wiring: file input, drag and drop, geometry selection and viewport
 * controls.
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const dom = {
    drop: $('drop'),
    fileInput: $('file-input'),
    picker: $('picker'),
    panel: $('panel'),
    status: $('status'),
    canvas: $('viewport'),
    meshInfo: $('mesh-info'),
    geometrySelect: $('geometry-select'),
    modeSelect: $('mode-select'),
    upSelect: $('up-select'),
    spinToggle: $('spin-toggle'),
    resetView: $('reset-view'),
    tabs: document.querySelectorAll('.tab'),
    tree: $('tree'),
    stage: $('stage'),
  };

  let viewer = null;
  let currentDoc = null;
  let currentAnalysis = null;

  function setStatus(text, kind = '') {
    dom.status.textContent = text || '';
    dom.status.className = `status ${kind}`;
  }

  /* --------------------------------------------------------------- loading */

  async function loadFile(file) {
    setStatus(`Reading ${file.name}…`);
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const started = performance.now();

      let doc = FbxWasm.parseBinary(buffer);
      if (!doc) {
        // Not binary — try ASCII.
        const text = new TextDecoder('utf-8').decode(buffer);
        if (!FbxAscii.looksLikeAscii(text)) {
          setStatus(`${file.name} is not an FBX file — no binary magic and no `
            + 'recognisable ASCII records.', 'error');
          return;
        }
        doc = FbxAscii.parse(text);
      } else {
        doc.versionSource = 'header';
      }
      doc.fileName = file.name;
      doc.fileSize = file.size;
      doc.parseMilliseconds = performance.now() - started;

      currentDoc = doc;
      currentAnalysis = FbxAnalyze.analyze(doc);

      dom.panel.innerHTML = FbxReport.render(currentAnalysis);
      dom.tree.innerHTML = FbxReport.recordTree(doc.root);
      document.body.classList.add('loaded');

      populateGeometry(doc);
      const label = `${doc.encoding} · FBX ${doc.version || '?'} · `
        + `${currentAnalysis.totalRecords.toLocaleString()} records · `
        + `${doc.parseMilliseconds.toFixed(0)} ms`;
      setStatus(label, doc.warnings.length ? 'warn' : 'ok');
    } catch (error) {
      console.error(error);
      setStatus(`Could not read ${file.name}: ${error.message}`, 'error');
    }
  }

  /* -------------------------------------------------------------- geometry */

  /**
   * Decide which axis points up, preferring the file's declaration but
   * overriding it when the vertex data clearly disagrees: a model resting on a
   * ground plane has its minimum at zero along the up axis.
   */
  function guessUpAxis(min, max, declared) {
    const score = (i) => {
      const extent = max[i] - min[i];
      return extent > 0 ? Math.abs(min[i]) / extent : Infinity;
    };
    const scores = [0, 1, 2].map(score);
    const best = scores.indexOf(Math.min(...scores));
    const declaredIndex = declared === 'z' ? 2 : 1;
    if ((best === 1 || best === 2) && scores[best] < 0.05 && scores[declaredIndex] > 0.2) {
      return { axis: best === 2 ? 'z' : 'y', fromGeometry: true };
    }
    return { axis: declared, fromGeometry: false };
  }


  function populateGeometry(doc) {
    const candidates = FbxAnalyze.findAllGeometry(doc);
    dom.geometrySelect.innerHTML = '';
    if (!candidates.length) {
      dom.geometrySelect.disabled = true;
      dom.meshInfo.textContent = 'no renderable geometry in this file';
      viewer.clear();
      return;
    }
    dom.geometrySelect.disabled = candidates.length === 1;
    candidates.forEach((entry, index) => {
      const [name] = FbxAnalyze.splitObjectName(
        entry.props.map((p) => p.value).find((v) => typeof v === 'string') || '',
      );
      const vertices = Math.floor(
        (FbxAnalyze.arrayLength(entry.children.find((c) => c.name === 'Vertices')) || 0) / 3,
      );
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `${name || entry.name} — ${vertices.toLocaleString()} vertices`;
      dom.geometrySelect.appendChild(option);
    });
    dom.geometrySelect.dataset.count = String(candidates.length);
    showGeometry(candidates[0]);
  }

  /** Pull the arrays a geometry record needs and hand them to the WASM core. */
  function buildMesh(entry) {
    const child = (name) => entry.children.find((c) => c.name === name);
    const nestedArray = (node) => {
      if (!node) return null;
      const direct = node.props.find((p) => p.array);
      if (direct) return direct;
      const inner = node.children.find((c) => c.name === 'a');
      return inner ? inner.props.find((p) => p.array) : null;
    };

    const vertices = nestedArray(child('Vertices'));
    const indices = nestedArray(child('PolygonVertexIndex'));
    if (!vertices || !indices) return null;

    // ASCII arrays arrive already decoded, so they are copied in; binary ones
    // are inflated in place inside WebAssembly memory.
    const toF64 = (prop) => (prop.values ? FbxWasm.uploadFloat64(prop.values) : FbxWasm.asFloat64(prop));
    const toI32 = (prop) => (prop.values ? FbxWasm.uploadInt32(prop.values) : FbxWasm.asInt32(prop));

    const positions = toF64(vertices);
    const polygons = toI32(indices);

    let normals = null;
    let mapping = 'none';
    const normalLayer = entry.children.find((c) => c.name === 'LayerElementNormal');
    if (normalLayer) {
      const prop = nestedArray(normalLayer.children.find((c) => c.name === 'Normals'));
      const mapType = FbxAnalyze.pathValue(normalLayer, ['MappingInformationType']);
      const refType = FbxAnalyze.pathValue(normalLayer, ['ReferenceInformationType']);
      // Only Direct reference is honoured; IndexToDirect falls back to face normals.
      if (prop && (!refType || String(refType).startsWith('Direct'))) {
        if (mapType === 'ByPolygonVertex') mapping = 'byPolygonVertex';
        else if (mapType === 'ByVertice' || mapType === 'ByVertex') mapping = 'byVertex';
        if (mapping !== 'none') normals = toF64(prop);
      }
    }

    let materials = null;
    const materialLayer = entry.children.find((c) => c.name === 'LayerElementMaterial');
    if (materialLayer) {
      const prop = nestedArray(materialLayer.children.find((c) => c.name === 'Materials'));
      if (prop) materials = toI32(prop);
    }

    return FbxWasm.buildMesh(positions, polygons, normals, mapping, materials);
  }

  function showGeometry(entry) {
    try {
      const started = performance.now();
      const mesh = buildMesh(entry);
      if (!mesh || !mesh.triangleCount) {
        dom.meshInfo.textContent = 'this record has no triangles';
        viewer.clear();
        return;
      }
      const elapsed = performance.now() - started;
      viewer.setMesh(mesh);

      const declaredAxis = (currentAnalysis.globalSettings.upAxis || '+Y').includes('Z')
        ? 'z' : 'y';
      const chosen = guessUpAxis(mesh.min, mesh.max, declaredAxis);
      dom.upSelect.value = chosen.axis;
      viewer.setUpAxis(chosen.axis);

      const size = [0, 1, 2].map((i) => (mesh.max[i] - mesh.min[i]));
      let text = `${mesh.triangleCount.toLocaleString()} triangles from `
        + `${mesh.polygonCount.toLocaleString()} polygons · `
        + `${size.map((v) => v.toFixed(1)).join(' × ')} units · ${elapsed.toFixed(0)} ms`;
      if (chosen.fromGeometry) {
        text += ` · ${chosen.axis.toUpperCase()} up from the geometry, though the `
          + `file declares ${currentAnalysis.globalSettings.upAxis}`;
      }
      dom.meshInfo.textContent = text;
    } catch (error) {
      console.error(error);
      dom.meshInfo.textContent = `could not build the mesh: ${error.message}`;
      viewer.clear();
    }
  }

  /* ------------------------------------------------------------------ init */

  function bindUi() {
    dom.picker.addEventListener('click', () => dom.fileInput.click());
    dom.fileInput.addEventListener('change', () => {
      if (dom.fileInput.files.length) loadFile(dom.fileInput.files[0]);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      document.addEventListener(type, (event) => {
        event.preventDefault();
        dom.drop.classList.add('active');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      document.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === 'drop' || event.relatedTarget === null) dom.drop.classList.remove('active');
      });
    });
    document.addEventListener('drop', (event) => {
      const file = event.dataTransfer && event.dataTransfer.files[0];
      if (file) loadFile(file);
    });

    dom.geometrySelect.addEventListener('change', () => {
      const candidates = FbxAnalyze.findAllGeometry(currentDoc);
      const entry = candidates[Number(dom.geometrySelect.value)];
      if (entry) showGeometry(entry);
    });
    dom.modeSelect.addEventListener('change', () => viewer.setMode(Number(dom.modeSelect.value)));
    dom.upSelect.addEventListener('change', () => viewer.setUpAxis(dom.upSelect.value));
    dom.spinToggle.addEventListener('change', () => viewer.setAutoRotate(dom.spinToggle.checked));
    dom.resetView.addEventListener('click', () => viewer.resetView());

    dom.tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        dom.tabs.forEach((t) => t.classList.toggle('active', t === tab));
        document.querySelectorAll('.tab-panel').forEach((p) => {
          p.classList.toggle('active', p.id === tab.dataset.target);
        });
      });
    });
  }

  async function start() {
    try {
      await FbxWasm.init(WASM_BASE64);
    } catch (error) {
      setStatus(`WebAssembly failed to load: ${error.message}`, 'error');
      return;
    }
    try {
      viewer = new FbxViewer.Viewer(dom.canvas);
    } catch (error) {
      dom.stage.classList.add('no-webgl');
      dom.meshInfo.textContent = error.message;
    }
    bindUi();
    setStatus('Ready — drop an .fbx file, ASCII or binary.');
    window.fbxtool = {
      get doc() { return currentDoc; },
      get analysis() { return currentAnalysis; },
      get viewer() { return viewer; },
      loadFile,
    };
    document.body.dataset.ready = 'true';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
