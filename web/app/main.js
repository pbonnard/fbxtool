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
    subdivSelect: $('subdiv-select'),
    upSelect: $('up-select'),
    spinToggle: $('spin-toggle'),
    groundToggle: $('ground-toggle'),
    textureToggle: $('texture-toggle'),
    resetView: $('reset-view'),
    exportGltf: $('export-gltf'),
    tabs: document.querySelectorAll('.tab'),
    tree: $('tree'),
    stage: $('stage'),
    materials: $('materials'),
    materialsStatus: $('materials-status'),
    materialsSave: $('materials-save'),
    materialsClear: $('materials-clear'),
  };

  let viewer = null;
  let currentDoc = null;
  let currentAnalysis = null;
  let currentGeometry = null;
  let lastSceneFile = null;
  let sceneParts = [];
  /** Bumped once a file is fully read, reported and drawn. */
  let loadCount = 0;
  /** How many rounds of Catmull-Clark to put the mesh through, 0 for none. */
  let subdivisionLevel = 0;
  /** Parts that would not fit through it, counted for the one build. */
  let unsmoothedParts = 0;
  /** Whether the shading mode on screen is the user's choice or ours. */
  let modeChosen = false;
  /** The same, for the up axis — remembered per file, so reopening a model
   *  that the viewer reads wrongly does not need correcting twice. */
  let upAxisChosen = false;
  /** Image files the user supplied, keyed by lowercased basename. */
  const suppliedImages = new Map();
  /** Material libraries the user supplied, keyed by lowercased basename. */
  const suppliedMaterials = new Map();
  /** Binary payloads a .gltf points at, keyed the same way. */
  const suppliedBuffers = new Map();
  let missingTextures = [];
  /** The palette on screen, its materials grouped, and the user's edits. */
  let currentPalette = [];
  let materialGroups = [];
  let materialOverrides = {};
  /** The mesh on screen, kept for the glTF export. */
  let currentMesh = null;
  let lastExport = null;
  /** The empty state of each panel, as the page was served. */
  const placeholders = {
    report: dom.panel.innerHTML,
    records: dom.tree.innerHTML,
    materials: dom.materials.innerHTML,
  };

  function setStatus(text, kind = '') {
    dom.status.textContent = text || '';
    dom.status.className = `status ${kind}`;
  }

  /* --------------------------------------------------------------- loading */

  /** Take a drop or a multi-select: one FBX plus any images it needs. */
  async function loadFiles(files) {
    const list = Array.from(files);
    const images = list.filter((f) => /\.(png|jpe?g|gif|bmp|webp|tga)$/i.test(f.name));
    const libraries = list.filter((f) => /\.mtl$/i.test(f.name));
    // A .gltf keeps its vertices in a .bin beside it, the way an .obj keeps its
    // colours in an .mtl.
    const payloads = list.filter((f) => /\.bin$/i.test(f.name));
    const assignments = list.filter((f) => /\.json$/i.test(f.name));
    for (const image of images) suppliedImages.set(image.name.toLowerCase(), image);
    for (const library of libraries) {
      suppliedMaterials.set(library.name.toLowerCase(), await library.text());
    }
    for (const payload of payloads) {
      suppliedBuffers.set(payload.name.toLowerCase(),
        new Uint8Array(await payload.arrayBuffer()));
    }
    // A saved material assignment applies to whatever is on screen.
    for (const file of assignments) {
      try {
        useAssignment(FbxPalette.parse(await file.text()));
        setStatus(`Applied ${file.name}.`, 'ok');
      } catch (error) {
        setStatus(`${file.name}: ${error.message}`, 'error');
      }
    }

    const companions = new Set([...images, ...libraries, ...payloads, ...assignments]);
    const scene = list.find((f) => !companions.has(f));
    if (!scene) {
      const added = companions.size;
      if (assignments.length && added === assignments.length) return;
      if (!currentDoc) {
        setStatus(`Added ${added} companion file(s) — now open a model.`);
        return;
      }
      // Companions arriving after the scene: reload so they take effect.
      setStatus(`Added ${added} companion file(s), applying…`);
      // An .mtl or a .bin changes what the file itself reads as, so re-read it.
      if (lastSceneFile && (libraries.length || payloads.length)) await loadFile(lastSceneFile);
      else if (currentGeometry) await showGeometry(currentGeometry);
      else if (sceneParts.length) await showScene();
      return;
    }
    await loadFile(scene);
  }

  /**
   * Everything on screen describes the file that was open. Put it all back to
   * empty before reading another one, so nothing that fails to load — or that
   * loads with nothing in it — leaves the last file's report, records,
   * materials or mesh sitting there as if they belonged to it.
   */
  function clearDocument() {
    currentDoc = null;
    currentAnalysis = null;
    currentGeometry = null;
    currentMesh = null;
    currentPalette = [];
    materialGroups = [];
    sceneParts = [];
    modeChosen = false;
    upAxisChosen = false;
    objectIndex = emptyIndex();
    missingTextures = [];

    dom.panel.innerHTML = placeholders.report;
    dom.tree.innerHTML = placeholders.records;
    dom.materials.innerHTML = placeholders.materials;
    dom.materialsStatus.textContent = 'Nothing loaded yet';
    dom.materialsSave.disabled = true;
    dom.materialsClear.disabled = true;
    dom.exportGltf.disabled = true;
    dom.geometrySelect.innerHTML = '';
    dom.geometrySelect.disabled = true;
    dom.meshInfo.textContent = 'no file loaded';
    if (viewer) {
      viewer.clear();
      viewer.setHighlight(-1);
    }
  }

  async function loadFile(file) {
    setStatus(`Reading ${file.name}…`);
    clearDocument();
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const started = performance.now();

      let doc = null;
      if (FbxBlend.looksLikeBlend(buffer)) {
        doc = FbxBlend.parse(buffer);
      } else if (FbxGltfIn.looksLikeGltf(buffer)) {
        // Both containers, .glb and .gltf, are recognised from the bytes.
        doc = FbxGltfIn.parse(buffer, { files: suppliedBuffers });
      } else {
        doc = FbxWasm.parseBinary(buffer);
      }
      if (!doc) {
        // Not binary — try the text formats.
        const text = new TextDecoder('utf-8').decode(buffer);
        if (FbxAscii.looksLikeAscii(text)) {
          doc = FbxAscii.parse(text);
        } else if (FbxObj.looksLikeObj(text)) {
          doc = FbxObj.parse(text, { materials: suppliedMaterials });
        } else {
          setStatus(`${file.name} is not a model we recognise — not FBX `
            + '(binary or ASCII), OBJ, glTF or .blend.', 'error');
          return;
        }
      } else if (doc.format !== 'blend' && doc.format !== 'gltf') {
        doc.versionSource = 'header';
      }
      lastSceneFile = file;
      doc.fileName = file.name;
      doc.fileSize = file.size;
      doc.parseMilliseconds = performance.now() - started;

      currentDoc = doc;
      currentAnalysis = FbxAnalyze.analyze(doc);
      // Whatever was assigned to this file last time it was open.
      materialOverrides = FbxPalette.load(doc.fileName);
      const savedAxis = recallUpAxis(doc.fileName);
      if (savedAxis) {
        dom.upSelect.value = savedAxis;
        upAxisChosen = true;
      }
      objectIndex = buildObjectIndex(currentAnalysis.objects);

      dom.panel.innerHTML = FbxReport.render(currentAnalysis);
      dom.tree.innerHTML = FbxReport.recordTree(doc.root);
      document.body.classList.add('loaded');
      // Taken out of the layout rather than faded: assembling a large scene
      // blocks the main thread for long enough that a CSS transition can sit
      // at full opacity over the model for seconds.
      dom.drop.hidden = true;

      const what = doc.format === 'obj' ? 'Wavefront OBJ'
        : doc.format === 'blend' ? `Blender ${doc.extra.blenderVersionText || '?'}`
        : doc.format === 'gltf'
          ? `glTF ${doc.extra.gltfVersion || '2.0'} ${doc.encoding === 'binary' ? '.glb' : '.gltf'}`
        : `FBX ${doc.version || '?'} ${doc.encoding}`;
      const label = `${what} · ${currentAnalysis.totalRecords.toLocaleString()} records · `
        + `${doc.parseMilliseconds.toFixed(0)} ms`;
      setStatus(label, doc.warnings.length ? 'warn' : 'ok');
      // Last, and awaited: building a scene is the slow half of a load.
      await populateGeometry(doc);
    } catch (error) {
      console.error(error);
      setStatus(`Could not read ${file.name}: ${error.message}`, 'error');
    } finally {
      loadCount += 1;
    }
  }

  /* ----------------------------------------------------------------- scene */

  /**
   * The renderable parts of a scene: every model that owns a geometry, with
   * its own properties and its materials in slot order. Where each one stands
   * is composed separately, up the chain of frames.
   *
   * A mesh is stored in its model's local space, so a scene only assembles
   * correctly once each part is placed by its model's world matrix.
   */
  function collectParts() {
    const info = currentAnalysis;
    if (!info) return [];
    const { keyOf, resolve } = objectIndex;

    // Keyed by model, not by geometry: one mesh is often shared by several
    // models — four wheels from one wheel — and each of those is its own part.
    const parts = new Map();          // model key -> part
    const add = (model, geometry) => {
      const key = keyOf(model);
      if (key === null || parts.has(key)) return;
      parts.set(key, {
        key,
        model,
        geometry,
        materials: [],
        properties: FbxAnalyze.resolvedProperties(model, info.templates),
      });
    };

    // 7.x keeps the mesh in a Geometry record connected to the Model.
    for (const conn of info.connections) {
      if (conn.kind !== 'OO') continue;
      const geometry = resolve(conn.src);
      const model = resolve(conn.dst);
      if (geometry && geometry.nodeType === 'Geometry'
        && model && model.nodeType === 'Model') add(model, geometry);
    }
    // 6.x puts it on the Model itself, so every mesh-bearing model is a part.
    for (const obj of info.objects) {
      if (obj.nodeType === 'Model' && FbxAnalyze.child(obj.node, 'Vertices')) add(obj, obj);
    }

    for (const conn of info.connections) {
      if (conn.kind !== 'OO') continue;
      const source = resolve(conn.src);
      const target = resolve(conn.dst);
      const part = target ? parts.get(keyOf(target)) : null;
      if (part && source && source.nodeType === 'Material') part.materials.push(source);
    }
    return [...parts.values()];
  }

  /**
   * Every model's local placement and its parent, whether or not it holds a
   * mesh of its own.
   *
   * A part's transform is composed up this chain rather than through the parts
   * alone: a model that carries nothing but a transform is a real link in it —
   * a rig, a pivot, or the root node a glTF hangs its axis and unit conversion
   * on — and skipping it leaves everything below in the wrong place.
   */
  function collectFrames() {
    const info = currentAnalysis;
    if (!info) return new Map();
    const { keyOf, resolve } = objectIndex;

    const frames = new Map();
    for (const obj of info.objects) {
      if (obj.nodeType !== 'Model') continue;
      const key = keyOf(obj);
      if (key === null || frames.has(key)) continue;
      frames.set(key, {
        key,
        model: obj,
        parent: null,
        properties: FbxAnalyze.resolvedProperties(obj, info.templates),
      });
    }
    for (const conn of info.connections) {
      if (conn.kind !== 'OO') continue;
      const source = resolve(conn.src);
      const target = resolve(conn.dst);
      if (!source || !target || source === target) continue;
      if (source.nodeType !== 'Model' || target.nodeType !== 'Model') continue;
      const frame = frames.get(keyOf(source));
      if (frame && frame.parent === null) frame.parent = keyOf(target);
    }
    return frames;
  }

  /** A frame's world matrix, composed up the parent chain. */
  function worldMatrix(frame, frames, cache) {
    if (cache.has(frame.key)) return cache.get(frame.key);
    // Guard against a cycle in a malformed file: claim the identity first.
    cache.set(frame.key, FbxTransform.identity());
    let matrix = FbxTransform.localMatrix(frame.properties);
    if (frame.parent !== null && frames.has(frame.parent)) {
      matrix = FbxTransform.multiply(
        worldMatrix(frames.get(frame.parent), frames, cache), matrix);
    }
    cache.set(frame.key, matrix);
    return matrix;
  }

  /** Whether a part's transform chain moves it at all. */
  function isPlaced(part) {
    const frames = collectFrames();
    const frame = frames.get(part.key);
    if (!frame) return false;
    const world = worldMatrix(frame, frames, new Map());
    const geometric = FbxTransform.geometricMatrix(part.properties);
    const matrix = geometric ? FbxTransform.multiply(world, geometric) : world;
    const identity = FbxTransform.identity();
    return matrix.some((value, index) => Math.abs(value - identity[index]) > 1e-9);
  }

  /** Build every part, placed in world space, as one combined mesh. */
  function buildScene(parts) {
    const frames = collectFrames();
    const cache = new Map();
    const pieces = [];
    const palette = [];
    unsmoothedParts = 0;

    // Everything a part allocates is scratch once its result is copied out.
    const heapMark = FbxWasm.mark();
    for (const part of parts) {
      const frame = frames.get(part.key);
      const world = frame ? worldMatrix(frame, frames, cache) : FbxTransform.identity();
      const geometric = FbxTransform.geometricMatrix(part.properties);
      const placement = geometric ? FbxTransform.multiply(world, geometric) : world;
      const materialBase = palette.length;
      palette.push(...part.materials.map(materialEntry));

      let mesh;
      try {
        mesh = buildMesh(part.geometry.node, {
          transform: placement,
          normalTransform: FbxTransform.normalMatrix(placement),
          // A mirroring transform reverses facing, so the winding follows.
          flipWinding: FbxTransform.determinant3(placement) < 0,
          materialBase,
        });
      } catch (error) {
        console.warn(`skipped ${part.model.displayName}: ${error.message}`);
        continue;
      }
      if (!mesh || !mesh.triangleCount) continue;
      // Copy out now: the next build may grow memory and detach these views.
      pieces.push({
        positions: mesh.positions.slice(),
        normals: mesh.normals.slice(),
        materials: mesh.materials.slice(),
        uvs: mesh.uvs.slice(),
        hasUv: mesh.hasUv,
        triangleCount: mesh.triangleCount,
        polygonCount: mesh.polygonCount,
        min: mesh.min,
        max: mesh.max,
      });
      FbxWasm.release(heapMark);
    }
    if (!pieces.length) return null;

    const triangleCount = pieces.reduce((sum, p) => sum + p.triangleCount, 0);
    const polygonCount = pieces.reduce((sum, p) => sum + p.polygonCount, 0);
    const positions = new Float32Array(triangleCount * 9);
    const normals = new Float32Array(triangleCount * 9);
    const uvs = new Float32Array(triangleCount * 6);
    const materials = new Float32Array(triangleCount * 3);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    let vertexAt = 0;
    let cornerAt = 0;
    for (const piece of pieces) {
      positions.set(piece.positions, vertexAt);
      normals.set(piece.normals, vertexAt);
      uvs.set(piece.uvs, cornerAt * 2);
      materials.set(piece.materials, cornerAt);
      vertexAt += piece.positions.length;
      cornerAt += piece.materials.length;
      for (let k = 0; k < 3; k++) {
        if (piece.min[k] < min[k]) min[k] = piece.min[k];
        if (piece.max[k] > max[k]) max[k] = piece.max[k];
      }
    }

    return {
      mesh: {
        triangleCount, polygonCount, min, max,
        hasUv: pieces.some((p) => p.hasUv),
        positions, normals, uvs, materials,
        degenerate: 0,
      },
      palette,
      parts: pieces.length,
    };
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

  /* Which way up a file is drawn is remembered per file: the declaration is
   * often wrong, the geometry is only a guess, and correcting the same model
   * on every open is worse than either. */
  const upAxisKey = (name) => `fbxtool:upaxis:${name || 'unnamed'}`;

  function rememberUpAxis(axis) {
    if (!currentDoc) return;
    try {
      window.localStorage.setItem(upAxisKey(currentDoc.fileName), axis);
    } catch (error) {
      /* Storage can be unavailable; the choice still holds for the session. */
    }
  }

  function recallUpAxis(fileName) {
    try {
      const saved = window.localStorage.getItem(upAxisKey(fileName));
      return saved === 'y' || saved === 'z' ? saved : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Choose the up axis for a freshly built mesh and put the viewer on it —
   * unless the axis on screen was picked by hand, which outranks both the
   * file's declaration and our reading of the geometry. Files get this wrong
   * often enough that having the answer undone by a rebuild is worse than
   * guessing again.
   */
  function applyUpAxis(mesh) {
    if (upAxisChosen) {
      viewer.setUpAxis(dom.upSelect.value);
      return { axis: dom.upSelect.value, fromGeometry: false, byHand: true };
    }
    // A .blend has no axis declaration — Blender is natively Z-up — so there
    // is nothing to disagree with there.
    const declared = currentAnalysis.globalSettings.upAxis
      || (currentDoc.format === 'blend' ? '+Z' : null);
    const declaredAxis = (declared || '+Y').includes('Z') ? 'z' : 'y';
    const chosen = guessUpAxis(mesh.min, mesh.max, declaredAxis);
    dom.upSelect.value = chosen.axis;
    viewer.setUpAxis(chosen.axis);
    return chosen;
  }

  /* ------------------------------------------------------------- materials */

  /**
   * How to find an object a connection names, rebuilt with each file.
   *
   * FBX 7.x addresses objects by UID and 6.x by name, with the class after a
   * separator, so connections carry numbers in one and strings in the other.
   */
  let objectIndex = emptyIndex();

  function emptyIndex() {
    return { keyOf: () => null, resolve: () => undefined };
  }

  function buildObjectIndex(objects) {
    const byKey = new Map();
    const keyOf = (obj) => (obj && obj.uid !== null && obj.uid !== undefined
      ? obj.uid : (obj ? obj.name : null));
    for (const obj of objects) {
      const key = keyOf(obj);
      if (key !== null && key !== '' && !byKey.has(key)) byKey.set(key, obj);
      // A 6.x name is only unique within its class — one Ferrari has a Video
      // and a Texture both called BM — so index the class-qualified name too.
      const qualified = `${obj.name}\u0000\u0001${obj.className || obj.nodeType}`;
      if (!byKey.has(qualified)) byKey.set(qualified, obj);
    }
    return {
      keyOf,
      resolve: (value) => {
        if (typeof value !== 'string') return byKey.get(value);
        return byKey.get(value) || byKey.get(FbxAnalyze.splitObjectName(value)[0]);
      },
    };
  }

  /**
   * Start a file in the mode that suits it — clay when it has no colours of
   * its own — but never take the choice back once it has been made, or
   * smoothing and dropped textures would keep resetting it.
   */
  function defaultShadingMode(hasColours) {
    if (modeChosen) return;
    dom.modeSelect.value = hasColours ? '0' : '2';
    viewer.setMode(Number(dom.modeSelect.value));
  }

  /** Build whatever is on screen again, after a setting that changes the mesh. */
  function redraw() {
    // Whatever is on screen is rebuilt where the camera already is. A scene is
    // what is showing whenever no single geometry was picked, however few
    // parts it has.
    if (currentGeometry) return showGeometry(currentGeometry, { keepCamera: true });
    if (sceneParts.length) return showScene({ keepCamera: true });
    return Promise.resolve();
  }

  /** A measurement with enough digits to be worth reading: a model a fifth of
   *  a unit across should not be reported as "0.0". */
  const measure = (size) => size
    .map((v) => v.toFixed(Math.abs(v) >= 1 ? 1 : 3))
    .join(' × ');

  /** What the viewport should say about smoothing, if anything. */
  function smoothingNote(mesh) {
    if (!(subdivisionLevel > 0 && mesh && mesh.triangleCount)) return '';
    return ` · smoothed ×${subdivisionLevel}`
      + (unsmoothedParts ? ` · ${unsmoothedParts} too large to smooth` : '');
  }

  /** How many of a palette's materials the file marks as see-through. */
  function seeThrough(palette) {
    const count = palette.filter((m) => m.opacity < 0.996).length;
    return count ? ` · ${count} see-through` : '';
  }

  /* --------------------------------------------------- material assignment */

  /** Triangles drawn with each palette slot, for sorting the material list. */
  function trianglesPerSlot(mesh, size) {
    const counts = new Array(size).fill(0);
    if (!mesh || !mesh.materials) return counts;
    // One value per vertex, three to a triangle.
    for (let i = 0; i < mesh.materials.length; i += 3) {
      const slot = Math.round(mesh.materials[i]);
      if (slot >= 0 && slot < size) counts[slot]++;
    }
    return counts;
  }

  /**
   * Group a freshly built palette by material, fold in the user's assignment,
   * upload it and list it in the sidebar.
   */
  function installPalette(palette, mesh) {
    currentPalette = palette;
    currentMesh = mesh;
    dom.exportGltf.disabled = !mesh || !mesh.triangleCount;
    materialGroups = FbxPalette.groups(palette, trianglesPerSlot(mesh, palette.length));
    FbxPalette.apply(palette, materialOverrides);
    viewer.setPalette(palette);
    renderMaterials();
  }

  /** Re-upload after an edit. The mesh is untouched: this is a few texels. */
  function refreshPalette() {
    FbxPalette.apply(currentPalette, materialOverrides);
    viewer.setPalette(currentPalette);
    dom.meshInfo.textContent = dom.meshInfo.textContent
      .replace(/ · \d+ see-through/, '') + seeThrough(currentPalette);
  }

  function renderMaterials() {
    dom.materials.innerHTML = FbxPalette.render(materialGroups, materialOverrides);
    const edited = Object.keys(materialOverrides).length;
    dom.materialsSave.disabled = !edited;
    dom.materialsClear.disabled = !edited;
    if (!materialGroups.length) {
      dom.materialsStatus.textContent = 'No materials in this file';
      return;
    }
    const slots = materialGroups.reduce((sum, g) => sum + g.slots.length, 0);
    const count = materialGroups.length;
    const parts = slots > count ? ` across ${slots} slots` : '';
    dom.materialsStatus.textContent = `${count} material${count === 1 ? '' : 's'}${parts}`
      + (edited ? ` · ${edited} assigned` : '');
  }

  /** Change one field of one material and show it straight away. */
  function editMaterial(name, changes) {
    const set = Object.assign({}, materialOverrides[name], changes);
    materialOverrides[name] = set;
    refreshPalette();

    const row = dom.materials.querySelector(`.material[data-key="${CSS.escape(name)}"]`);
    if (row) {
      const group = materialGroups.find((g) => g.name === name);
      const settings = FbxPalette.settingsFor(group, materialOverrides);
      row.classList.add('edited');
      const swatch = row.querySelector('.swatch');
      const colour = row.querySelector('input[type="color"]');
      const hex = FbxPalette.toHex(settings.colour);
      if (swatch) swatch.style.background = hex;
      if (colour && colour.value !== hex) colour.value = hex;
      row.querySelectorAll('input[type="range"]').forEach((input) => {
        const value = settings[input.dataset.field];
        if (typeof value !== 'number') return;
        input.value = value.toFixed(2);
        const output = input.parentElement.querySelector('output');
        if (output) output.textContent = value.toFixed(2);
      });
    }
    if (currentDoc) FbxPalette.save(currentDoc.fileName, materialOverrides);
    dom.materialsSave.disabled = false;
    dom.materialsClear.disabled = false;
  }

  /** Put every material back to what the file said. */
  function clearMaterials() {
    materialOverrides = {};
    if (currentDoc) FbxPalette.save(currentDoc.fileName, materialOverrides);
    refreshPalette();
    renderMaterials();
  }

  /** Apply a saved assignment, from storage or a dropped file. */
  function useAssignment(overrides) {
    materialOverrides = overrides;
    if (currentDoc) FbxPalette.save(currentDoc.fileName, materialOverrides);
    if (currentPalette.length) refreshPalette();
    renderMaterials();
  }

  /** Hand the browser a file to save. */
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function saveAssignment() {
    download(new Blob([FbxPalette.serialise(materialOverrides)], { type: 'application/json' }),
      `${(currentDoc && currentDoc.fileName) || 'model'}.materials.json`);
  }

  /* ------------------------------------------------------------- exporting */

  /** glTF embeds PNG and JPEG only, so the bytes have to say which they are. */
  function imageType(bytes) {
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50
      && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    return null;
  }

  /** An image as PNG bytes, through a canvas. */
  async function encodePng(image) {
    if (!image) return null;
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  }

  /**
   * Each material's base colour image, ready for a glTF.
   *
   * glTF takes PNG and JPEG and nothing else, so bytes already in one of those
   * are passed through untouched. Anything else — a KTX2 this tool decoded
   * itself, most often — is drawn once and encoded as a PNG, which is the
   * difference between exporting the model and exporting it with its
   * textures.
   */
  async function textureBytes(palette) {
    const out = new Map();
    for (const entry of palette) {
      if (!entry.texture || out.has(entry.name)) continue;
      let bytes = entry.texture.embedded;
      if (!bytes) {
        const file = suppliedImages.get(baseName(entry.texture.path));
        if (file) bytes = new Uint8Array(await file.arrayBuffer());
      }
      const mimeType = bytes && imageType(bytes);
      if (mimeType) {
        out.set(entry.name, { bytes, mimeType });
        continue;
      }
      const encoded = await encodePng(await decodeTexture(entry.texture, suppliedImages));
      if (encoded) out.set(entry.name, { bytes: encoded, mimeType: 'image/png' });
    }
    return out;
  }

  /**
   * The scene as glTF wants it: every mesh once, and a tree of nodes placing
   * them.
   *
   * A mesh is built in its own local space — only the geometric offset, which
   * a child does not inherit, is baked in — so a geometry used by several
   * models is written once and pointed at from each. What a node carries is
   * its own local transform, exactly as the file wrote it.
   */
  function exportScene() {
    const frames = collectFrames();
    const meshes = [];
    const meshOf = new Map();
    const heapMark = FbxWasm.mark();

    const meshFor = (part) => {
      const geometric = FbxTransform.geometricMatrix(part.properties);
      // Keyed by what would actually be written: the geometry, the materials
      // by name — the exporter folds same-named materials into one anyway —
      // and the geometric offset that gets baked in. Four wheels cut from one
      // mesh share all of that, so they share a mesh.
      const key = [
        objectIndex.keyOf(part.geometry),
        part.materials.map((material) => material.displayName).join(','),
        geometric ? geometric.join(',') : '',
        subdivisionLevel,
      ].join('|');
      if (meshOf.has(key)) return meshOf.get(key);

      let mesh = null;
      try {
        mesh = buildMesh(part.geometry.node, geometric ? {
          transform: geometric,
          normalTransform: FbxTransform.normalMatrix(geometric),
          flipWinding: FbxTransform.determinant3(geometric) < 0,
        } : {});
      } catch (error) {
        console.warn(`skipped ${part.model.displayName}: ${error.message}`);
      }
      let index = -1;
      if (mesh && mesh.triangleCount) {
        index = meshes.length;
        meshes.push({
          name: part.geometry.displayName || part.model.displayName,
          // Copied out: the next build may grow memory and detach these views.
          mesh: {
            triangleCount: mesh.triangleCount,
            hasUv: mesh.hasUv,
            positions: mesh.positions.slice(),
            normals: mesh.normals.slice(),
            uvs: mesh.uvs.slice(),
            materials: mesh.materials.slice(),
          },
          palette: FbxPalette.apply(part.materials.map(materialEntry), materialOverrides),
        });
      }
      FbxWasm.release(heapMark);
      meshOf.set(key, index);
      return index;
    };

    // A node for every model, whether or not it holds a mesh: a rig or a pivot
    // is where its children hang from.
    const nodes = new Map();
    for (const [key, frame] of frames) {
      nodes.set(key, {
        name: frame.model ? frame.model.displayName : '',
        matrix: FbxTransform.localMatrix(frame.properties),
        mesh: null,
        children: [],
      });
    }
    for (const part of sceneParts) {
      const node = nodes.get(part.key);
      if (!node) continue;
      const index = meshFor(part);
      if (index >= 0) node.mesh = index;
    }

    const roots = [];
    for (const [key, frame] of frames) {
      const node = nodes.get(key);
      const parent = frame.parent !== null ? nodes.get(frame.parent) : null;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }

    // Drop the branches that hold nothing: an empty node is only worth keeping
    // for what hangs off it.
    const keep = (node) => {
      node.children = node.children.filter(keep);
      return node.mesh !== null || node.children.length > 0;
    };
    return { meshes, nodes: roots.filter(keep) };
  }

  async function exportGltf() {
    if (!currentMesh) return;
    try {
      dom.exportGltf.disabled = true;
      setStatus('Writing glTF…');
      await nextFrame();
      const images = await textureBytes(currentPalette);
      const settings = (currentAnalysis && currentAnalysis.globalSettings) || {};
      // FBX counts centimetres per unit; glTF counts metres.
      const centimetres = typeof settings.unitScale === 'number' ? settings.unitScale : 1;
      const stem = ((currentDoc && currentDoc.fileName) || 'scene').replace(/\.[^.]+$/, '');
      const started = performance.now();
      // Whatever is on screen: the whole scene as a tree, or the one geometry
      // picked from the list, which has no tree to keep.
      const scene = currentGeometry
        ? {
          meshes: [{ name: stem, mesh: currentMesh, palette: currentPalette }],
          nodes: [{ name: stem, matrix: FbxTransform.identity(), mesh: 0, children: [] }],
        }
        : exportScene();
      const { glb, stats } = FbxGltf.build({
        name: stem,
        meshes: scene.meshes,
        nodes: scene.nodes,
        images,
        upAxis: dom.upSelect.value,
        unitScale: centimetres / 100,
      });
      download(new Blob([glb], { type: 'model/gltf-binary' }), `${stem}.glb`);
      lastExport = stats;
      const instanced = stats.triangles > stats.stored
        ? `, ${stats.stored.toLocaleString()} stored` : '';
      setStatus(`Exported ${stats.triangles.toLocaleString()} triangles${instanced} as `
        + `${stats.meshes} mesh(es) in ${stats.nodes} node(s), `
        + `${stats.vertices.toLocaleString()} vertices, `
        + `${(stats.bytes / 1048576).toFixed(1)} MiB`
        + `${stats.images ? ` with ${stats.images} image(s)` : ''} · `
        + `${(performance.now() - started).toFixed(0)} ms`, 'ok');
    } catch (error) {
      console.error(error);
      setStatus(`Could not write the glTF: ${error.message}`, 'error');
    } finally {
      dom.exportGltf.disabled = !currentMesh;
    }
  }

  /** Mark on the model whichever material the pointer or the open row names. */
  function updateHighlight() {
    if (!viewer) return;
    const open = dom.materials.querySelector('.material[open]');
    const hovered = dom.materials.querySelector('.material:hover');
    const row = hovered || open;
    viewer.setHighlight(row ? Number(row.dataset.index) : -1);
  }

  function bindMaterials() {
    const keyOf = (event) => {
      const row = event.target.closest('.material');
      return row ? row.dataset.key : null;
    };

    dom.materials.addEventListener('input', (event) => {
      const field = event.target.dataset.field;
      const name = keyOf(event);
      if (!name || !field) return;
      if (field === 'colour') editMaterial(name, { colour: FbxPalette.fromHex(event.target.value) });
      else editMaterial(name, { [field]: Number(event.target.value) });
    });

    dom.materials.addEventListener('change', (event) => {
      if (event.target.dataset.field !== 'preset') return;
      const name = keyOf(event);
      const chosen = FbxPalette.preset(event.target.value);
      if (!name || !chosen) return;
      const { id, label, ...values } = chosen;
      editMaterial(name, values);
      event.target.value = '';
    });

    dom.materials.addEventListener('click', (event) => {
      if (event.target.dataset.action !== 'reset') return;
      const name = keyOf(event);
      if (!name) return;
      delete materialOverrides[name];
      if (currentDoc) FbxPalette.save(currentDoc.fileName, materialOverrides);
      refreshPalette();
      renderMaterials();
    });

    ['pointerover', 'pointerout', 'toggle'].forEach((type) => {
      dom.materials.addEventListener(type, updateHighlight, true);
    });
    dom.materials.addEventListener('pointerleave', () => {
      if (viewer) viewer.setHighlight(-1);
    });

    dom.materialsSave.addEventListener('click', saveAssignment);
    dom.materialsClear.addEventListener('click', clearMaterials);
  }

  /** One palette entry: how a material shades, and the image it wears. */
  function materialEntry(material) {
    // Template defaults sit underneath, so a material with no Properties70
    // still gets the colour and finish its type declares.
    const props = FbxAnalyze.resolvedProperties(material, currentAnalysis.templates);
    const look = FbxAnalyze.materialAppearance(props);
    return {
      name: material.displayName,
      uid: material.uid,
      // Values are linear, which is what the shader works in.
      colour: look.colour,
      specular: look.specular,
      roughness: look.roughness,
      opacity: look.opacity,
      // A .blend states metalness; FBX and OBJ leave it to be inferred, and
      // nothing infers it, so those export as dielectrics.
      metallic: typeof props.Metallic === 'number' ? props.Metallic : 0,
      // Kept so an assignment can always be undone back to the file itself.
      fromFile: {
        colour: look.colour.slice(),
        specular: look.specular.slice(),
        roughness: look.roughness,
        opacity: look.opacity,
        metallic: typeof props.Metallic === 'number' ? props.Metallic : 0,
      },
      texture: diffuseTexture(material, objectIndex.resolve, currentAnalysis.connections),
      layer: -1,
    };
  }

  /**
   * The real colours of the materials this geometry uses.
   *
   * A per-polygon material index does not name a material directly: it indexes
   * the materials connected to the *model* that owns the geometry, in the
   * order those connections appear. So the palette has to be resolved through
   * the connection graph rather than read off the geometry record.
   */
  function materialPalette(entry) {
    const info = currentAnalysis;
    if (!info || !info.connections.length) return [];
    const { resolve } = objectIndex;
    let model = info.objects.find((o) => o.node === entry);
    if (!model) return [];

    // A Model may hold its own geometry; otherwise walk Geometry -> Model.
    if (model.nodeType !== 'Model') {
      const geometry = model;
      const link = info.connections.find((c) => c.kind === 'OO' && resolve(c.src) === geometry);
      model = link ? resolve(link.dst) : null;
      if (!model) return [];
    }

    return info.connections
      .filter((c) => c.kind === 'OO' && resolve(c.dst) === model)
      .map((c) => resolve(c.src))
      .filter((o) => o && o.nodeType === 'Material')
      .map(materialEntry);
  }

  /* --------------------------------------------------------------- textures */

  /** Basename of a path written with either separator, lowercased. */
  function baseName(path) {
    return String(path).split(/[\\/]/).pop().toLowerCase();
  }

  /** A record's own image: embedded bytes, or the file it names. */
  function imageOf(object) {
    const node = object.node;
    const content = node.children.find((c) => c.name === 'Content');
    const bytes = content && content.props.find((p) => p.value instanceof Uint8Array);
    if (bytes && bytes.value.length) {
      return { name: object.displayName, path: '', embedded: bytes.value };
    }
    const path = FbxAnalyze.pathValue(node, ['RelativeFilename'])
      || FbxAnalyze.pathValue(node, ['FileName'])
      || FbxAnalyze.pathValue(node, ['Filename']);
    if (typeof path === 'string' && path) {
      return { name: object.displayName, path, embedded: null };
    }
    return null;
  }

  /**
   * Follow a texture down to the image it ends at.
   *
   * A Texture may hold the image itself, or name a Video clip that does — and
   * a 3ds Max export can put several nodes in between, colour-correcting or
   * mixing one texture into another, with the bitmap several links down.
   * Anything that ends at no image at all is a procedural map we cannot draw.
   */
  function imageBehind(object, resolve, connections, seen) {
    const found = [];
    (function walk(node) {
      if (!node || seen.has(node) || seen.size > 64) return;
      seen.add(node);
      const own = imageOf(node);
      if (own) found.push(own);
      for (const conn of connections) {
        if (resolve(conn.dst) === node) walk(resolve(conn.src));
      }
    })(object);
    // A Texture that names a file may still have the bytes on the Video clip
    // below it, so what is embedded anywhere in the chain wins.
    return found.find((image) => image.embedded) || found[0] || null;
  }

  /**
   * The base colour texture bound to a material, if any.
   *
   * A Texture attaches to a Material through an object-to-property connection
   * naming the property it drives; only the base colour is drawn, so the rest
   * — bump, normal, glossiness — are left alone.
   */
  function diffuseTexture(material, resolve, connections) {
    const link = connections.find((c) => c.kind === 'OP' && resolve(c.dst) === material
      && FbxAnalyze.drivesBaseColour(c.prop));
    if (!link) return null;
    const bound = resolve(link.src);
    if (!bound) return null;
    const image = imageBehind(bound, resolve, connections, new Set());
    return image ? { ...image, name: bound.displayName } : null;
  }

  /** Decode one image, from embedded bytes or a file the user supplied. */
  const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

  const looksLikeKtx2 = (bytes) => bytes && bytes.length > 12
    && KTX2_MAGIC.every((byte, i) => bytes[i] === byte);

  /**
   * A KTX2 texture, decoded here rather than by the browser.
   *
   * KTX2 is not an image format: it holds blocks meant for a GPU, and no
   * browser will make a picture of it. Ours comes back as pixels, which are
   * handed on as an ImageBitmap like any other texture.
   */
  async function decodeKtx2(bytes) {
    const mark = FbxWasm.mark();
    try {
      const image = FbxWasm.decodeKtx2(bytes);
      return await createImageBitmap(new ImageData(image.rgba, image.width, image.height));
    } catch (error) {
      console.warn('KTX2:', error.message);
      return null;
    } finally {
      FbxWasm.release(mark);
    }
  }

  async function decodeTexture(request, supplied) {
    if (request.embedded) {
      if (looksLikeKtx2(request.embedded)) return decodeKtx2(request.embedded);
      const blob = new Blob([request.embedded]);
      try {
        return await createImageBitmap(blob);
      } catch (error) {
        return null;                       // an image format the browser refuses
      }
    }
    const file = supplied.get(baseName(request.path));
    if (!file) return null;
    if (/\.ktx2$/i.test(file.name)) {
      return decodeKtx2(new Uint8Array(await file.arrayBuffer()));
    }
    try {
      return await createImageBitmap(file);
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode each distinct texture once and assign it an array layer, dropping
   * any that could not be loaded so the shader falls back to flat colour.
   */
  async function resolveTextures(palette) {
    const requests = [];
    const layerOf = new Map();
    for (const material of palette) {
      if (!material.texture) continue;
      const key = material.texture.embedded
        ? `embedded:${material.texture.name}`
        : `file:${baseName(material.texture.path)}`;
      if (!layerOf.has(key)) {
        layerOf.set(key, requests.length);
        requests.push(material.texture);
      }
      material.layer = layerOf.get(key);
    }
    if (!requests.length) return { images: [], missing: [], requested: 0 };

    const decoded = await Promise.all(requests.map((r) => decodeTexture(r, suppliedImages)));

    // Compact the layers so only successfully decoded images take a slot.
    const remap = new Map();
    const images = [];
    decoded.forEach((image, index) => {
      if (image) { remap.set(index, images.length); images.push(image); }
    });
    for (const material of palette) {
      material.layer = remap.has(material.layer) ? remap.get(material.layer) : -1;
    }
    const missing = requests
      .filter((_, index) => !decoded[index])
      .map((request) => baseName(request.path) || request.name);
    return { images, missing, requested: requests.length };
  }

  function populateGeometry(doc) {
    const candidates = FbxAnalyze.findAllGeometry(doc);
    sceneParts = collectParts();
    dom.geometrySelect.innerHTML = '';
    if (!candidates.length) {
      dom.geometrySelect.disabled = true;
      // A file can hold no mesh for a reason worth reading — compressed with
      // something we cannot undo, most often — so say which rather than
      // leaving an empty stage and a report to go looking through.
      const reason = (doc.warnings || []).find((w) => /compress|decode|no data/i.test(w));
      dom.meshInfo.textContent = reason
        ? `nothing to draw — ${reason}` : 'no renderable geometry in this file';
      // Say so in the materials list too, rather than leaving it looking
      // like nothing has been opened at all.
      renderMaterials();
      viewer.clear();
      return;
    }

    // One part is normally shown as the mesh it is, which is cheaper and reads
    // better — but not when its placement is doing real work. A glTF hangs its
    // axis and unit conversion on the node above the mesh, and a file with a
    // single part would otherwise come out lying on its side.
    const placed = sceneParts.length === 1 && isPlaced(sceneParts[0]);

    // A scene is only itself once every part is placed, so that comes first.
    if (sceneParts.length > 1 || placed) {
      const whole = document.createElement('option');
      whole.value = 'scene';
      whole.textContent = sceneParts.length > 1
        ? `Whole scene — ${sceneParts.length} parts` : 'Whole scene — as placed';
      dom.geometrySelect.appendChild(whole);
    }
    dom.geometrySelect.disabled = candidates.length === 1 && !placed
      && sceneParts.length <= 1;
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
    return sceneParts.length > 1 || placed ? showScene() : showGeometry(candidates[0]);
  }

  /** Yield long enough for the browser to paint pending UI changes. */
  const nextFrame = () => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  /** Render every part of the scene, each placed by its model's transform. */
  async function showScene({ keepCamera = false } = {}) {
    currentGeometry = null;
    try {
      dom.meshInfo.textContent = `assembling ${sceneParts.length} `
        + `part${sceneParts.length === 1 ? '' : 's'}…`;
      // Assembling a large scene blocks the main thread, so let the overlay
      // fade and the status update land first.
      await nextFrame();
      const started = performance.now();
      const built = buildScene(sceneParts);
      if (!built) {
        dom.meshInfo.textContent = 'no triangles in this scene';
        viewer.clear();
        return;
      }
      const elapsed = performance.now() - started;
      viewer.setMesh(built.mesh, { keepCamera });

      const textures = await resolveTextures(built.palette);
      missingTextures = textures.missing;
      installPalette(built.palette, built.mesh);
      viewer.setTextures(textures.images);
      defaultShadingMode(built.palette.length > 0);
      dom.textureToggle.disabled = textures.images.length === 0;
      applyUpAxis(built.mesh);

      const size = [0, 1, 2].map((i) => (built.mesh.max[i] - built.mesh.min[i]));
      let text = `${built.parts} part${built.parts === 1 ? '' : 's'} · `
        + `${built.mesh.triangleCount.toLocaleString()} `
        + `triangles · ${measure(size)} units · `
        + `${elapsed.toFixed(0)} ms · ${built.palette.length} material colours`;
      text += smoothingNote(built.mesh);
      text += seeThrough(built.palette);
      if (textures.requested) {
        text += ` · ${textures.images.length}/${textures.requested} textures`;
      }
      if (textures.missing.length) {
        text += ` · missing: ${textures.missing.join(', ')} — drop the image in`;
      }
      dom.meshInfo.textContent = text;
    } catch (error) {
      console.error(error);
      dom.meshInfo.textContent = `could not assemble the scene: ${error.message}`;
      viewer.clear();
    }
  }


  /**
   * A record's numbers, in WebAssembly memory, however the file stored them.
   *
   * Binary 7.x holds one array property, which is inflated in place; ASCII
   * decodes its array while parsing, so it is copied in; and 6.x writes one
   * property per number, which is gathered and copied in as well.
   */
  function upload(node, asFloat) {
    if (!node) return null;
    const direct = node.props.find((p) => p.array);
    const inner = direct || (node.children.find((c) => c.name === 'a') || { props: [] })
      .props.find((p) => p.array);
    if (inner) {
      if (inner.values) {
        return asFloat ? FbxWasm.uploadFloat64(inner.values) : FbxWasm.uploadInt32(inner.values);
      }
      return asFloat ? FbxWasm.asFloat64(inner) : FbxWasm.asInt32(inner);
    }
    const scalars = FbxAnalyze.scalarValues(node);
    if (!scalars) return null;
    return asFloat ? FbxWasm.uploadFloat64(scalars) : FbxWasm.uploadInt32(scalars);
  }

  const floatsOf = (node) => upload(node, true);
  const intsOf = (node) => upload(node, false);

  /** Pull the arrays a geometry record needs and hand them to the WASM core. */
  function buildMesh(entry, placement = {}) {
    const child = (name) => entry.children.find((c) => c.name === name);

    const positions = floatsOf(child('Vertices'));
    const polygons = intsOf(child('PolygonVertexIndex'));
    if (!positions || !polygons) return null;

    let normals = null;
    let normalIndex = null;
    let mapping = 'none';
    let normalReference = 'direct';
    const normalLayer = entry.children.find((c) => c.name === 'LayerElementNormal');
    if (normalLayer) {
      const mapType = FbxAnalyze.pathValue(normalLayer, ['MappingInformationType']);
      const refType = String(FbxAnalyze.pathValue(normalLayer, ['ReferenceInformationType']) || 'Direct');
      if (mapType === 'ByPolygonVertex') mapping = 'byPolygonVertex';
      else if (mapType === 'ByVertice' || mapType === 'ByVertex') mapping = 'byVertex';
      if (mapping !== 'none') {
        normals = floatsOf(normalLayer.children.find((c) => c.name === 'Normals'));
        if (normals && (refType.startsWith('IndexToDirect') || refType === 'Index')) {
          normalIndex = intsOf(normalLayer.children.find((c) => c.name === 'NormalsIndex'
            || c.name === 'NormalIndex'));
          if (normalIndex) normalReference = 'indexToDirect';
          else normals = null;             // indexed but no index array; use faces
        }
      }
    }

    let materials = null;
    const materialLayer = entry.children.find((c) => c.name === 'LayerElementMaterial');
    if (materialLayer) {
      materials = intsOf(materialLayer.children.find((c) => c.name === 'Materials'));
    }

    let uvs = null;
    let uvIndex = null;
    let uvMapping = 'none';
    let uvReference = 'direct';
    const uvLayer = entry.children.find((c) => c.name === 'LayerElementUV');
    if (uvLayer) {
      const mapType = FbxAnalyze.pathValue(uvLayer, ['MappingInformationType']);
      const refType = String(FbxAnalyze.pathValue(uvLayer, ['ReferenceInformationType']) || 'Direct');
      if (mapType === 'ByPolygonVertex') uvMapping = 'byPolygonVertex';
      else if (mapType === 'ByVertice' || mapType === 'ByVertex') uvMapping = 'byVertex';
      if (uvMapping !== 'none') {
        uvs = floatsOf(uvLayer.children.find((c) => c.name === 'UV'));
        if (uvs && (refType.startsWith('IndexToDirect') || refType === 'Index')) {
          uvIndex = intsOf(uvLayer.children.find((c) => c.name === 'UVIndex'));
          if (uvIndex) uvReference = 'indexToDirect';
          else uvs = null;                 // indexed but no index array to follow
        }
      }
    }

    let spec = {
      positions, indices: polygons,
      normals, normalMapping: mapping, normalReference: normalReference,
      normalIndex,
      uvs, uvIndex, uvMapping, uvReference,
      materials,
    };
    // Smoothing happens on the polygons, before anything is triangulated. A
    // mesh too big to smooth is drawn as it came rather than dropped: one
    // part of a car at its cage density is better than a hole where it was.
    if (subdivisionLevel > 0) {
      try {
        const smoothed = FbxWasm.subdivide(spec, subdivisionLevel);
        if (smoothed) spec = smoothed;
      } catch (error) {
        unsmoothedParts++;
      }
    }
    return FbxWasm.buildMesh({ ...spec, ...placement });
  }

  async function showGeometry(entry, { keepCamera = false } = {}) {
    currentGeometry = entry;
    try {
      const started = performance.now();
      unsmoothedParts = 0;
      const mesh = buildMesh(entry);
      if (!mesh || !mesh.triangleCount) {
        dom.meshInfo.textContent = 'this record has no triangles';
        viewer.clear();
        return;
      }
      const elapsed = performance.now() - started;
      viewer.setMesh(mesh, { keepCamera });

      const palette = materialPalette(entry);
      const textures = await resolveTextures(palette);
      missingTextures = textures.missing;
      installPalette(palette, mesh);
      viewer.setTextures(textures.images);
      defaultShadingMode(palette.length > 0);
      dom.textureToggle.disabled = textures.images.length === 0;

      const chosen = applyUpAxis(mesh);

      const size = [0, 1, 2].map((i) => (mesh.max[i] - mesh.min[i]));
      let text = `${mesh.triangleCount.toLocaleString()} triangles from `
        + `${mesh.polygonCount.toLocaleString()} polygons · `
        + `${measure(size)} units · ${elapsed.toFixed(0)} ms`;
      text += palette.length
        ? ` · ${palette.length} material colours`
        : ' · no material colours in this file';
      text += smoothingNote(mesh);
      text += seeThrough(palette);
      if (textures.requested) {
        text += ` · ${textures.images.length}/${textures.requested} textures`;
        if (!mesh.hasUv) text += ' (no UVs in this mesh)';
      }
      if (textures.missing.length) {
        text += ` · missing: ${textures.missing.join(', ')} — drop the image in`;
      }
      if (chosen.fromGeometry) {
        text += ` · ${chosen.axis.toUpperCase()} up from the geometry`;
        if (currentAnalysis.globalSettings.upAxis) {
          text += `, though the file declares ${currentAnalysis.globalSettings.upAxis}`;
        }
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
      if (dom.fileInput.files.length) loadFiles(dom.fileInput.files);
    });

    ['dragenter', 'dragover'].forEach((type) => {
      document.addEventListener(type, (event) => {
        event.preventDefault();
        // Back into the layout, so there is something to drop onto.
        dom.drop.hidden = false;
        dom.drop.classList.add('active');
      });
    });
    ['dragleave', 'drop'].forEach((type) => {
      document.addEventListener(type, (event) => {
        event.preventDefault();
        if (type === 'drop' || event.relatedTarget === null) {
          dom.drop.classList.remove('active');
          if (currentDoc) dom.drop.hidden = true;
        }
      });
    });
    document.addEventListener('drop', (event) => {
      const files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) loadFiles(files);
    });

    dom.geometrySelect.addEventListener('change', () => {
      if (dom.geometrySelect.value === 'scene') { showScene(); return; }
      const candidates = FbxAnalyze.findAllGeometry(currentDoc);
      const entry = candidates[Number(dom.geometrySelect.value)];
      if (entry) showGeometry(entry);
    });
    dom.modeSelect.addEventListener('change', () => {
      modeChosen = true;
      viewer.setMode(Number(dom.modeSelect.value));
    });
    dom.subdivSelect.addEventListener('change', () => {
      subdivisionLevel = Number(dom.subdivSelect.value) || 0;
      redraw();
    });
    dom.upSelect.addEventListener('change', () => {
      upAxisChosen = true;
      viewer.setUpAxis(dom.upSelect.value);
      rememberUpAxis(dom.upSelect.value);
    });
    dom.spinToggle.addEventListener('change', () => viewer.setAutoRotate(dom.spinToggle.checked));
    dom.groundToggle.addEventListener('change',
      () => viewer.setShowGround(dom.groundToggle.checked));
    dom.textureToggle.addEventListener('change',
      () => viewer.setShowTextures(dom.textureToggle.checked));
    dom.resetView.addEventListener('click', () => viewer.resetView());
    dom.exportGltf.addEventListener('click', exportGltf);

    bindMaterials();

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
    setStatus('Ready — drop an .fbx file, ASCII or binary. '
      + 'Drop image files alongside it for textures it references.');
    window.fbxtool = {
      get doc() { return currentDoc; },
      get analysis() { return currentAnalysis; },
      get viewer() { return viewer; },
      get missingTextures() { return missingTextures; },
      get loadCount() { return loadCount; },
      get palette() { return currentPalette; },
      get parts() { return sceneParts.length; },
      get lastExport() { return lastExport; },
      exportMesh: () => currentMesh,
      exportGltf,
      get materials() { return materialGroups; },
      get overrides() { return materialOverrides; },
      loadFile,
      loadFiles,
      editMaterial,
      useAssignment,
      clearMaterials,
    };
    document.body.dataset.ready = 'true';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
