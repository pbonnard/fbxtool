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
    explodeSlider: $('explode-slider'),
    partInfo: $('part-info'),
    partName: $('part-name'),
    partMaterial: $('part-material'),
    partSplit: $('part-split'),
    partSplitMaterial: $('part-split-material'),
    partDelete: $('part-delete'),
    restoreAll: $('restore-all'),
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
  /** An assignment dropped before there was a model to put it on, or with the
   *  model it belongs to: either way it is applied once the model is loaded. */
  let pendingAssignment = null;
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
  /** Triangles per palette slot, counted once per mesh: grouping the list
   *  again after a rename must not walk half a million triangles to do it. */
  let slotTriangles = [];
  let materialOverrides = {};
  /** The mesh on screen, kept for the glTF export. */
  let currentMesh = null;
  /** The parts of what is on screen, and which one the mouse picked. */
  let partTable = [];
  let selectedPart = -1;
  /** The pieces the last build produced, one per part, holes and all: an edit
   *  regroups what is already built rather than building it again. */
  let builtPieces = null;
  /** What the scene is made of after the edits, or null for the file as read,
   *  and the way back — every edit pushes what it replaced. */
  let segments = null;
  let baseSegments = null;
  const history = { past: [], future: [] };
  /** Materials added to the file's own, and how many of them the scene is
   *  currently using: undo hides the last one rather than renumbering the
   *  palette underneath the parts that were assigned earlier slots. */
  let extraMaterials = [];
  let extraCount = 0;
  /** How many of them the file arrived with, so that a material restored from
   *  a saved assignment reads as part of the scene and not as an edit to it. */
  let baseExtras = 0;
  /** Which part wears which material, as a saved assignment records it:
   *  the model's key against the name the material is filed under. */
  let partAssignments = {};
  /** Segments are told apart by identity, which the glTF export needs to keep
   *  instancing: two parts cut from one geometry share a mesh only while
   *  neither has been edited. */
  let segmentSerial = 0;
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
    // A saved material assignment is read now and put on once there is a model
    // to put it on, which may be the one arriving in this same drop.
    const dropped = [];
    for (const file of assignments) {
      try {
        dropped.push({ name: file.name, saved: FbxPalette.parse(await file.text()) });
      } catch (error) {
        setStatus(`${file.name}: ${error.message}`, 'error');
      }
    }
    if (dropped.length) {
      pendingAssignment = {
        names: dropped.map((entry) => entry.name),
        // Several at once fold together, the last word winning; what they say
        // stands on its own rather than on top of what was remembered.
        saved: {
          materials: Object.assign({}, ...dropped.map((entry) => entry.saved.materials)),
          parts: Object.assign({}, ...dropped.map((entry) => entry.saved.parts)),
        },
      };
    }

    const companions = new Set([...images, ...libraries, ...payloads, ...assignments]);
    const scene = list.find((f) => !companions.has(f));
    if (scene) {
      await loadFile(scene);
      // Opening a model starts from whatever was remembered for it, so an
      // assignment dropped alongside goes on after that and not before: it is
      // the one thing loading the file would otherwise throw away.
      applyPending();
      return;
    }

    const added = companions.size;
    if (!currentDoc) {
      setStatus(added === assignments.length
        ? `Read ${added} assignment(s) — now open a model.`
        : `Added ${added} companion file(s) — now open a model.`);
      return;
    }
    // Companions arriving after the scene: reload so they take effect. An .mtl
    // or a .bin changes what the file itself reads as, so re-read it.
    if (images.length || libraries.length || payloads.length) {
      setStatus(`Added ${added} companion file(s), applying…`);
      if (lastSceneFile && (libraries.length || payloads.length)) await loadFile(lastSceneFile);
      else if (currentGeometry) await showGeometry(currentGeometry);
      else if (sceneParts.length) await showScene();
    }
    applyPending();
  }

  /** Put a dropped assignment on the model, once there is one to put it on. */
  function applyPending() {
    if (!pendingAssignment || !currentDoc) return false;
    const { names, saved } = pendingAssignment;
    pendingAssignment = null;
    useAssignment(saved);
    setStatus(`Applied ${names.join(', ')}.`, 'ok');
    return true;
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
    builtPieces = null;
    resetEdits();
    setSelectedPart(-1);
    partTable = [];
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
    dom.explodeSlider.value = '0';
    dom.explodeSlider.disabled = true;
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
      if (FbxMax.looksLikeMax(buffer)) {
        // A .max is a compound file, which nothing else here reads, so the
        // eight bytes of its container are enough to know it.
        doc = FbxMax.parse(buffer);
      } else if (FbxBlend.looksLikeBlend(buffer)) {
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
      const remembered = FbxPalette.load(doc.fileName);
      materialOverrides = remembered.materials;
      partAssignments = remembered.parts;
      const savedAxis = recallUpAxis(doc.fileName);
      if (savedAxis) {
        dom.upSelect.value = savedAxis;
        upAxisChosen = true;
      }
      objectIndex = buildObjectIndex(currentAnalysis.objects);
      applySceneSmoothing(doc);

      renderReport();
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
        : doc.format === 'max' ? `3ds Max ${doc.extra.buildText || ''}`
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

  /**
   * Build every part, placed in world space, one piece each.
   *
   * The palette is filled for every part whether or not that part draws, so a
   * material slot means the same thing before and after an edit: the textures
   * resolved for it stay resolved, and the Materials tab stays where it is.
   * Parts that build nothing keep their place in the list as a hole, so a
   * piece can always be found by the part it came from.
   */
  function buildPieces(parts) {
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
      }
      if (!mesh || !mesh.triangleCount) { pieces.push(null); continue; }
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
        name: part.model.displayName || part.geometry.displayName || 'part',
        materialNames: part.materials.map((material) => material.displayName),
      });
      FbxWasm.release(heapMark);
    }
    return { pieces, palette };
  }

  /**
   * One mesh out of the parts the scene still holds.
   *
   * What it holds is a list of segments rather than the parts themselves: a
   * segment names a part and, when it has been split, which of that part's
   * triangles it kept. A part deleted is a segment gone from the list.
   */
  function assemble(built, segments) {
    // Materials added by hand sit after the file's own, so a slot means the
    // same thing however many are added.
    const palette = built.palette.concat(extraMaterials.slice(0, extraCount));
    const pieces = [];
    const kept = [];
    for (const segment of segments) {
      const source = built.pieces[segment.source];
      if (!source) continue;
      let piece = FbxEdits.slice(source, segment.faces);
      if (!piece.triangleCount) continue;
      if (segment.material != null && palette[segment.material]) {
        const material = palette[segment.material];
        piece = FbxEdits.paint(piece, segment.material);
        // Under the name it was read by, like every other part: what it is
        // called now is looked up when it is shown.
        piece.materialNames = [material.fromFile.name || material.name];
      }
      pieces.push(segment.name ? { ...piece, name: segment.name } : piece);
      kept.push(segment);
    }
    if (!pieces.length) return null;

    const triangleCount = pieces.reduce((sum, p) => sum + p.triangleCount, 0);
    const polygonCount = pieces.reduce((sum, p) => sum + p.polygonCount, 0);
    const positions = new Float32Array(triangleCount * 9);
    const normals = new Float32Array(triangleCount * 9);
    const uvs = new Float32Array(triangleCount * 6);
    const materials = new Float32Array(triangleCount * 3);
    // Which part each corner belongs to: what the explode moves and what a
    // click reports.
    const partOf = new Float32Array(triangleCount * 3);
    const table = [];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    let vertexAt = 0;
    let cornerAt = 0;
    pieces.forEach((piece, index) => {
      positions.set(piece.positions, vertexAt);
      normals.set(piece.normals, vertexAt);
      uvs.set(piece.uvs, cornerAt * 2);
      materials.set(piece.materials, cornerAt);
      partOf.fill(index, cornerAt, cornerAt + piece.materials.length);
      vertexAt += piece.positions.length;
      cornerAt += piece.materials.length;
      for (let k = 0; k < 3; k++) {
        if (piece.min[k] < min[k]) min[k] = piece.min[k];
        if (piece.max[k] > max[k]) max[k] = piece.max[k];
      }
      table.push({
        name: piece.name,
        centre: [0, 1, 2].map((k) => (piece.min[k] + piece.max[k]) / 2),
        min: piece.min.slice(),
        max: piece.max.slice(),
        triangles: piece.triangleCount,
        materials: piece.materialNames,
        // What to edit when this is the part under the mouse.
        segment: kept[index],
      });
    });

    return {
      mesh: {
        triangleCount, polygonCount, min, max,
        hasUv: pieces.some((p) => p.hasUv),
        positions, normals, uvs, materials,
        parts: partOf,
        degenerate: 0,
      },
      palette,
      parts: pieces.length,
      table,
    };
  }

  /* ----------------------------------------------------------------- edits */

  /**
   * A part removed, or cut into the pieces it is really made of.
   *
   * Nothing here touches the file, and nothing rebuilds geometry: the scene is
   * described as a list of segments over the pieces already built, so an edit
   * is a new list and undo is the list it replaced. What is on screen, what an
   * export writes and what the report counts all read the same list.
   */

  const newSegment = (source, name, faces, material = null) => (
    { id: ++segmentSerial, source, name, faces, material });

  /** Everything an edit can change, and everything undo has to put back. */
  const snapshot = () => ({ segments, extras: extraCount });

  function restore(state) {
    segments = state.segments;
    extraCount = state.extras;
  }

  /**
   * Number the parts afresh: the scene exactly as the file holds it.
   *
   * The list is kept, not rebuilt on demand, because a segment is known by its
   * identity — the part under the mouse is a segment in this list, and an edit
   * is this list with one entry gone or several in its place.
   */
  function resetSegments() {
    baseSegments = builtPieces
      ? builtPieces.pieces
        .map((piece, source) => (piece
          ? newSegment(source, null, null, restoredSlot(source)) : null))
        .filter(Boolean)
      : [];
    segments = baseSegments;
    baseExtras = extraCount;
    history.past.length = 0;
    history.future.length = 0;
  }

  const currentSegments = () => segments || [];

  /**
   * Whether what is on screen still is what the file — and the assignment
   * saved for it — says it should be.
   */
  const edited = () => (segments !== null && segments !== baseSegments)
    || extraCount !== baseExtras;

  function resetEdits() {
    segments = null;
    baseSegments = null;
    extraMaterials = [];
    extraCount = 0;
    baseExtras = 0;
    history.past.length = 0;
    history.future.length = 0;
  }

  /** Every material the file itself holds, whatever part of it is on screen. */
  function fileMaterialNames() {
    const names = new Set();
    for (const object of (currentAnalysis && currentAnalysis.objects) || []) {
      if (object.nodeType === 'Material') names.add(object.displayName);
    }
    return names;
  }

  /**
   * Build the materials an assignment names that the file does not hold.
   *
   * Nothing else would ever make them, so without this the assignment keeps a
   * colour for a material that is not there — and a part wearing it comes back
   * undressed. Whether anything wears it does not come into it: a material
   * that was added is part of the palette in its own right, and a list of
   * materials is what an assignment is. The `added` flag records where one
   * came from; it is not what makes it real, so an assignment written by hand,
   * or by a version that did not write the flag, is honoured just the same.
   */
  function restoreAddedMaterials() {
    const inFile = fileMaterialNames();
    const made = new Set();
    extraMaterials = [];
    for (const [name, set] of Object.entries(materialOverrides)) {
      if (!set || inFile.has(name)) continue;
      // A material added here and then exported comes back inside the file
      // under the name it goes by rather than the one it is filed under, so
      // building it again from the assignment would make two of it.
      const goesBy = set && typeof set.name === 'string' && set.name ? set.name : name;
      if (inFile.has(goesBy) || made.has(goesBy)) continue;
      made.add(goesBy);
      extraMaterials.push(newMaterial(name));
    }
    extraCount = extraMaterials.length;
  }

  /** The slot a saved assignment puts on a part, or null. */
  function restoredSlot(source) {
    // Only a whole scene has parts a saved assignment can name.
    if (currentGeometry || !builtPieces) return null;
    const part = sceneParts[source];
    const wanted = part ? partAssignments[String(part.key)] : null;
    if (!wanted) return null;
    const palette = builtPieces.palette.concat(extraMaterials.slice(0, extraCount));
    const at = palette.findIndex((material) => originOf(material) === wanted);
    return at >= 0 ? at : null;
  }

  /** The name a material is filed under: what the file called it. */
  const originOf = (material) => (material.fromFile && material.fromFile.name) || material.name;

  /**
   * Which part wears what, for the assignment file.
   *
   * Only whole parts: a piece of a split has no name to file it under, and the
   * split itself does not outlive the session. Parts that are not in the scene
   * as it stands — deleted, or split — keep whatever was saved for them, so
   * taking a part out for a moment does not forget how it was dressed.
   */
  function partMap() {
    if (currentGeometry || !builtPieces) return partAssignments;
    const palette = builtPieces.palette.concat(extraMaterials.slice(0, extraCount));
    const out = Object.assign({}, partAssignments);
    for (const segment of currentSegments()) {
      const part = sceneParts[segment.source];
      if (!part || segment.faces) continue;
      const material = segment.material != null ? palette[segment.material] : null;
      if (material) out[String(part.key)] = originOf(material);
      else delete out[String(part.key)];
    }
    return out;
  }

  /** Remember the materials, and who is wearing them, against this file. */
  function persist() {
    if (!currentDoc) return;
    if (builtPieces) reconcileAddedMaterials();
    partAssignments = partMap();
    FbxPalette.save(currentDoc.fileName, materialOverrides, partAssignments);
  }

  /**
   * Keep the record of what was added in step with what is actually built.
   *
   * A material undone is no longer part of the scene, so its settings should
   * not outlive it and come back on the next opening; one that a redo brought
   * back needs its record again. The file's own materials are never in
   * question here — they exist whether anything is set on them or not.
   */
  function reconcileAddedMaterials() {
    const inFile = fileMaterialNames();
    const live = new Set(extraMaterials.slice(0, extraCount).map(originOf));
    for (const key of Object.keys(materialOverrides)) {
      if (!inFile.has(key) && !live.has(key)) delete materialOverrides[key];
    }
    for (const key of live) {
      if (!materialOverrides[key]) materialOverrides[key] = { added: true };
    }
  }

  /** What has been done to the scene, for the readout and for the report. */
  function editSummary() {
    if (!edited() || !builtPieces) return null;
    const perSource = new Map();
    for (const segment of segments) {
      if (!perSource.has(segment.source)) perSource.set(segment.source, []);
      perSource.get(segment.source).push(segment);
    }
    const removed = [];
    const split = [];
    const assigned = segments.filter((segment) => segment.material != null).length;
    // The models themselves, not their names or their keys: the report holds
    // the same objects, so identity is the one test that cannot drift.
    const removedModels = new Set();
    const editedModels = new Set();
    builtPieces.pieces.forEach((piece, source) => {
      if (!piece) return;
      const here = perSource.get(source) || [];
      const model = sceneParts[source] ? sceneParts[source].model : null;
      const held = here.reduce(
        (sum, segment) => sum + (segment.faces ? segment.faces.length : piece.triangleCount), 0);
      if (!here.length) {
        removed.push({ name: piece.name, triangles: piece.triangleCount });
        if (model) removedModels.add(model);
        return;
      }
      if (here.length > 1) split.push({ name: piece.name, into: here.length });
      if (model && (here.length > 1 || held < piece.triangleCount
        || here.some((segment) => segment.material != null))) editedModels.add(model);
    });
    if (!removed.length && !split.length && !assigned && !extraCount) return null;
    return {
      removed,
      split,
      assigned,
      added: extraMaterials.slice(baseExtras, extraCount).map((material) => material.name),
      removedModels,
      editedModels,
      parts: partTable.length,
      triangles: partTable.reduce((sum, part) => sum + part.triangles, 0),
    };
  }

  /**
   * Draw the scene the segments now describe.
   *
   * The palette is not rebuilt and the textures are not decoded again — an
   * edit moves triangles about, it does not change what a material is — and
   * the camera and the up axis are left where they are, so a deleted part does
   * not send the model spinning off to a new frame.
   */
  function refreshEdited(note) {
    if (!builtPieces) return;
    const built = assemble(builtPieces, currentSegments());
    if (!built) {
      partTable = [];
      setSelectedPart(-1);
      viewer.clear();
      viewer.setParts([]);
      dom.meshInfo.textContent = 'every part has been deleted — undo with Ctrl+Z';
      currentMesh = null;
      dom.exportGltf.disabled = true;
      updateEditControls();
      renderReport();
      if (note) setStatus(note, 'ok');
      return;
    }
    viewer.setMesh(built.mesh, { keepCamera: true });
    partTable = built.table || [];
    viewer.setParts(partTable);
    // The parts are numbered afresh, so a selection that has fallen off the
    // end of the list is no selection at all.
    setSelectedPart(selectedPart < partTable.length ? selectedPart : -1);
    installPalette(built.palette, built.mesh);
    viewer.setExplode(Number(dom.explodeSlider.value) / 100);
    dom.explodeSlider.disabled = partTable.length < 2;
    dom.exportGltf.disabled = false;

    const size = [0, 1, 2].map((i) => (built.mesh.max[i] - built.mesh.min[i]));
    dom.meshInfo.textContent = `${built.parts} part${built.parts === 1 ? '' : 's'} · `
      + `${built.mesh.triangleCount.toLocaleString()} triangles · ${measure(size)} units`
      + editNote();
    updateEditControls();
    renderReport();
    // How a part is dressed belongs to the file, the way its colours do.
    persist();
    if (note) setStatus(note, 'ok');
  }

  /** What the mesh line says about the state of the edits. */
  function editNote() {
    const summary = editSummary();
    if (!summary) return '';
    const bits = [];
    if (summary.removed.length) bits.push(`${summary.removed.length} removed`);
    if (summary.split.length) bits.push(`${summary.split.length} split`);
    if (summary.assigned) bits.push(`${summary.assigned} reassigned`);
    if (summary.added.length) bits.push(`${summary.added.length} new material`
      + (summary.added.length === 1 ? '' : 's'));
    return ` · ${bits.join(', ')} — Ctrl+Z to undo`;
  }

  /**
   * Put a new scene in place, keeping the way back to the old one. A plain
   * list of segments leaves the palette alone; an edit that adds a material
   * passes both halves of the state.
   */
  function applyEdit(next, note) {
    history.past.push(snapshot());
    history.future.length = 0;
    restore(Array.isArray(next) ? { segments: next, extras: extraCount } : next);
    refreshEdited(note);
  }

  function deletePart(index) {
    const part = partTable[index];
    if (!part || !part.segment) return;
    const name = part.name;
    const triangles = part.triangles;
    const gone = part.segment;
    setSelectedPart(-1);
    applyEdit(currentSegments().filter((segment) => segment !== gone),
      `Removed ${name} — ${triangles.toLocaleString()} triangles.`);
  }

  /**
   * Cut one part into several.
   *
   * `shells` follows the geometry — triangles that share a vertex stay
   * together, which is how a wheel saved as one mesh comes apart into rim,
   * tyre and hub — and `material` follows the file's own grouping.
   */
  function splitPart(index, by = 'shells') {
    const part = partTable[index];
    if (!part || !part.segment || !builtPieces) return;
    const source = builtPieces.pieces[part.segment.source];
    if (!source) return;
    const piece = FbxEdits.slice(source, part.segment.faces);

    let groups = [];
    if (by === 'material') {
      groups = FbxEdits.byMaterial(piece).map(({ slot, faces }) => ({
        name: `${part.name} · ${nameOfSlot(slot)}`,
        faces,
      }));
    } else {
      groups = FbxEdits.shells(piece).map((faces, at) => ({
        name: `${part.name} #${at + 1}`,
        faces,
      }));
    }
    if (groups.length < 2) {
      setStatus(by === 'material'
        ? `${part.name} wears one material — nothing to split by.`
        : `${part.name} is one connected piece — nothing to split.`, 'warn');
      return;
    }

    // The lists come back as triangles of the piece on screen; the segment
    // keeps them as triangles of the part it was cut from, so a split of a
    // split still points at the one mesh underneath.
    const made = groups.map((group) => newSegment(
      part.segment.source, group.name, FbxEdits.through(part.segment.faces, group.faces)));
    const next = [];
    for (const segment of currentSegments()) {
      if (segment === part.segment) next.push(...made);
      else next.push(segment);
    }
    applyEdit(next, `Split ${part.name} into ${made.length} `
      + `${by === 'material' ? 'materials' : 'pieces'}.`);
    // Leave the largest of them picked, so it is clear where the part went.
    setSelectedPart(partTable.findIndex((entry) => entry.segment === made[0]));
  }

  /**
   * Give a part a different material.
   *
   * The whole part takes it — a part wearing several materials is one part,
   * and this is what it wears now. To repaint only some of it, split it by
   * material first and assign to the piece.
   */
  function assignMaterial(index, slot) {
    const part = partTable[index];
    if (!part || !part.segment) return;
    const name = nameOfSlot(slot);
    const next = currentSegments().map((segment) => (segment === part.segment
      ? { ...segment, material: slot } : segment));
    applyEdit(next, `${part.name} wears ${name}.`);
    setSelectedPart(index);
  }

  /** Put the part back in whatever the file dressed it in. */
  function unassignMaterial(index) {
    const part = partTable[index];
    if (!part || !part.segment || part.segment.material == null) return;
    const next = currentSegments().map((segment) => (segment === part.segment
      ? { ...segment, material: null } : segment));
    applyEdit(next, `${part.name} is back in the file's own materials.`);
    setSelectedPart(index);
  }

  /**
   * A material that is not in the file, added to the palette and put on the
   * part that asked for it.
   *
   * It starts as a plain mid-grey rather than a copy of what the part wore, so
   * that adding one shows: the Materials tab is where it becomes what it needs
   * to be, and it is edited there like any other.
   */
  /** A plain material of our own, under a name the file has not used. */
  function newMaterial(name) {
    const colour = [0.55, 0.55, 0.55];
    return {
      name,
      uid: null,
      colour: colour.slice(),
      specular: [0.04, 0.04, 0.04],
      roughness: 0.4,
      opacity: 1,
      metallic: 0,
      // Nothing in the file to go back to, so its own values stand as that.
      fromFile: {
        name,
        colour: colour.slice(),
        specular: [0.04, 0.04, 0.04],
        roughness: 0.4,
        opacity: 1,
        metallic: 0,
      },
      texture: null,
      layer: -1,
    };
  }

  function addMaterial(index) {
    if (!builtPieces) return;
    /* Both names of everything already here, and every name the assignment has
     * settings under. A material restored from an assignment goes by one name
     * and is filed under another, and taking the one it is filed under would
     * make the two of them one material: same origin, same settings, merged
     * into a single row, and nothing to show for the click. */
    const taken = new Set(Object.keys(materialOverrides));
    for (const material of [...builtPieces.palette, ...extraMaterials]) {
      taken.add(material.name);
      taken.add(originOf(material));
    }
    let name = 'New material';
    for (let n = 2; taken.has(name); n++) name = `New material ${n}`;
    // Kept beyond an undo so that the slots handed out earlier keep pointing
    // at the same material; how many count is what undo puts back.
    extraMaterials = extraMaterials.slice(0, extraCount);
    // That it was made here is written down when the edit is remembered,
    // along with everything else the scene now holds.
    extraMaterials.push(newMaterial(name));
    const slot = builtPieces.palette.length + extraMaterials.length - 1;

    const part = partTable[index];
    const next = part && part.segment
      ? currentSegments().map((segment) => (segment === part.segment
        ? { ...segment, material: slot } : segment))
      : currentSegments();
    applyEdit({ segments: next, extras: extraMaterials.length },
      `Added ${name}${part ? ` and put it on ${part.name}` : ''} `
      + '— the Materials tab is where to colour it.');
    if (index >= 0) setSelectedPart(index);
  }

  /**
   * What a material read out of the file is called now. A part carries the
   * names it was built with, and a rename must not make it look like the part
   * wears something that is no longer there.
   */
  function shownMaterial(name) {
    const set = materialOverrides[name];
    return set && typeof set.name === 'string' && set.name ? set.name : name;
  }

  /** What the material in a slot is called, for naming a split. */
  function nameOfSlot(slot) {
    const entry = currentPalette[slot]
      || (builtPieces && builtPieces.palette.concat(extraMaterials)[slot]);
    return (entry && entry.name) || `material ${slot}`;
  }

  function undoEdit() {
    if (!history.past.length) return;
    history.future.push(snapshot());
    restore(history.past.pop());
    setSelectedPart(-1);
    refreshEdited(edited() ? 'Undone.' : 'Back to the scene as the file holds it.');
  }

  function redoEdit() {
    if (!history.future.length) return;
    history.past.push(snapshot());
    restore(history.future.pop());
    setSelectedPart(-1);
    refreshEdited('Redone.');
  }

  function restoreAll() {
    if (!edited()) return;
    setSelectedPart(-1);
    applyEdit({ segments: baseSegments, extras: baseExtras },
      'Every part put back, as the file and its assignment have it.');
  }

  /** Offer the edit controls only where they mean something. */
  function updateEditControls() {
    const part = selectedPart >= 0 ? partTable[selectedPart] : null;
    const splittable = !!(part && part.segment && builtPieces);
    dom.partSplit.disabled = !splittable;
    dom.partSplitMaterial.disabled = !splittable
      || (part.materials || []).length < 2;
    dom.partDelete.disabled = !part;
    dom.partMaterial.disabled = !splittable;
    fillMaterialChoices(part);
    dom.restoreAll.hidden = !edited() && !history.past.length;
    dom.restoreAll.disabled = !edited();
  }

  /**
   * The materials a part could wear: one entry per material rather than one
   * per slot, since a file gives every part its own copy of the same few.
   */
  function fillMaterialChoices(part) {
    const worn = part && part.segment ? part.segment.material : null;
    const own = ((part && part.materials) || []).map(shownMaterial);
    // What the list should be sitting on: the material given by hand, or the
    // one the file gave it where there is only one to name.
    let chosen = -1;
    if (worn != null && currentPalette[worn]) chosen = currentPalette[worn].group;
    else if (own.length === 1) {
      const group = materialGroups.find((entry) => entry.name === own[0]);
      chosen = group ? group.index : -1;
    }
    const first = worn != null ? 'as the file has it'
      : (own.length > 1 ? `${own.length} materials` : '—');
    const options = [{ value: '', label: first }];
    for (const group of materialGroups) {
      options.push({ value: String(group.slots[0]), label: group.name, group: group.index });
    }
    options.push({ value: 'new', label: '+ new material' });

    const shape = options.map((o) => `${o.value}:${o.label}`).join('|');
    if (dom.partMaterial.dataset.shape !== shape) {
      dom.partMaterial.innerHTML = '';
      for (const option of options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        dom.partMaterial.appendChild(element);
      }
      dom.partMaterial.dataset.shape = shape;
    }
    const wearing = chosen >= 0
      ? options.find((option) => option.group === chosen) : null;
    dom.partMaterial.value = wearing ? wearing.value : '';
    dom.partMaterial.title = part && worn != null
      ? `Wearing ${nameOfSlot(worn)} — assigned here, not in the file`
      : 'The material this part wears';
  }

  /** The report, with whatever has been done to the scene since it was read. */
  function renderReport() {
    if (!currentAnalysis) return;
    currentAnalysis.edits = editSummary();
    dom.panel.innerHTML = FbxReport.render(currentAnalysis);
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
    // Settings first, grouping second: a renamed material has to be grouped
    // and sorted under the name it now goes by.
    FbxPalette.apply(palette, materialOverrides);
    slotTriangles = trianglesPerSlot(mesh, palette.length);
    materialGroups = FbxPalette.groups(palette, slotTriangles);
    viewer.setPalette(palette);
    renderMaterials();
  }

  /** Group the palette again, without counting the triangles again. */
  function regroup() {
    materialGroups = FbxPalette.groups(currentPalette, slotTriangles);
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
      const group = materialGroups.find((g) => g.origin === name);
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
    persist();
    dom.materialsSave.disabled = false;
    dom.materialsClear.disabled = false;
  }

  /**
   * Call a material something else.
   *
   * The name is what the export writes and what the model is read by, but it
   * is not what the material is filed under: settings stay under the name the
   * file gave it, so renaming loses nothing and *From file* undoes it with
   * everything else. An empty name means the file's own.
   *
   * Two materials of the same name are one material to a glTF, so a rename
   * onto a name already in use is refused rather than quietly merging them.
   */
  function renameMaterial(key, value) {
    const group = materialGroups.find((entry) => entry.origin === key);
    if (!group) return;
    const wanted = String(value || '').trim().slice(0, 120);
    if (wanted === group.name) return;
    const clash = materialGroups.find((entry) => entry !== group && entry.name === wanted);
    if (clash) {
      setStatus(`Another material is already called ${wanted}.`, 'warn');
      renderMaterials();
      return;
    }
    // Renaming to what the file called it is the same as not renaming it.
    const set = Object.assign({}, materialOverrides[key]);
    if (!wanted || wanted === key) delete set.name;
    else set.name = wanted;
    if (Object.keys(set).length) materialOverrides[key] = set;
    else delete materialOverrides[key];

    FbxPalette.apply(currentPalette, materialOverrides);
    viewer.setPalette(currentPalette);
    regroup();
    renderMaterials();
    // The readout names the part's materials, so it has to hear about it.
    if (selectedPart >= 0) setSelectedPart(selectedPart);
    persist();
    setStatus(wanted && wanted !== key
      ? `${key} is now called ${wanted}.`
      : `${group.name} goes back to ${key}.`, 'ok');
  }

  /** Put every material back to what the file said. */
  function clearMaterials() {
    materialOverrides = {};
    partAssignments = {};
    // Everything the file did not say goes: the settings, the names, the
    // materials added here and the parts wearing them.
    if (builtPieces && currentSegments().some((segment) => segment.material != null)) {
      setSelectedPart(-1);
      applyEdit({
        segments: currentSegments().map((segment) => (segment.material == null
          ? segment : Object.assign({}, segment, { material: null }))),
        extras: 0,
      });
    }
    persist();
    refreshPalette();
    // Names go back to the file's along with everything else.
    regroup();
    renderMaterials();
    if (selectedPart >= 0) setSelectedPart(selectedPart);
  }

  /** Apply a saved assignment, from storage or a dropped file. */
  function useAssignment(saved) {
    // A saved assignment used to be nothing but material settings, so one that
    // still is — an older file, or a caller passing the map on its own — is
    // read as having nobody wearing anything.
    const incoming = saved && saved.materials
      ? saved : { materials: saved || {}, parts: {} };
    materialOverrides = incoming.materials;
    partAssignments = incoming.parts || {};

    // Materials it names that the file has not got have to be built, and the
    // parts dressed in them again: both are read while the scene is put
    // together. One geometry on its own has no parts to dress, but it has the
    // same palette, so it goes the same way.
    if (builtPieces) {
      restoreAddedMaterials();
      resetSegments();
      setSelectedPart(-1);
      refreshEdited();
      return;
    }
    persist();
    if (currentPalette.length) refreshPalette();
    regroup();
    renderMaterials();
    if (selectedPart >= 0) setSelectedPart(selectedPart);
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
    download(new Blob([FbxPalette.serialise(materialOverrides, partMap())],
      { type: 'application/json' }),
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

    // What each part still holds after the edits: no entry at all means the
    // part was deleted, and a list of triangles means it was split and only
    // some of it is left. A part nobody touched keeps `null` — all of it — so
    // untouched instances of one geometry go on sharing a mesh.
    const kept = new Map();
    for (const segment of currentSegments()) {
      const here = kept.get(segment.source) || [];
      here.push(segment);
      kept.set(segment.source, here);
    }
    const facesOf = (index) => {
      const here = kept.get(index);
      if (!here) return undefined;
      if (here.some((segment) => !segment.faces)) return null;
      const all = [];
      for (const segment of here) all.push(...segment.faces);
      return Int32Array.from(all.sort((a, b) => a - b));
    };

    /**
     * Which material each of a part's triangles was given by hand, in the
     * part's own numbering. -1 where the file's own material still stands.
     */
    const assignedOf = (index, count) => {
      const here = kept.get(index) || [];
      if (!count || !here.some((segment) => segment.material != null)) return null;
      const slots = new Int32Array(count).fill(-1);
      for (const segment of here) {
        if (segment.material == null) continue;
        const faces = segment.faces || FbxEdits.every(count);
        for (const face of faces) slots[face] = segment.material;
      }
      return slots;
    };

    const meshFor = (part, index) => {
      const faces = facesOf(index);
      if (faces === undefined) return -1;         // deleted
      const here = kept.get(index) || [];
      const geometric = FbxTransform.geometricMatrix(part.properties);
      // Keyed by what would actually be written: the geometry, the materials
      // by name — the exporter folds same-named materials into one anyway —
      // the geometric offset that gets baked in, and what any edit left of the
      // part. Four wheels cut from one mesh share all of that, so they share a
      // mesh; a wheel cut down, or repainted, no longer does.
      const touched = here.some((segment) => segment.faces || segment.material != null);
      const key = [
        objectIndex.keyOf(part.geometry),
        part.materials.map((material) => material.displayName).join(','),
        geometric ? geometric.join(',') : '',
        subdivisionLevel,
        touched ? here.map((segment) => segment.id).join('+') : 'all',
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
      let at = -1;
      if (mesh && mesh.triangleCount) {
        // Copied out: the next build may grow memory and detach these views.
        let written = {
          triangleCount: mesh.triangleCount,
          hasUv: mesh.hasUv,
          positions: mesh.positions.slice(),
          normals: mesh.normals.slice(),
          uvs: mesh.uvs.slice(),
          materials: mesh.materials.slice(),
        };
        // The triangles an edit named are the triangles of this same mesh:
        // both builds triangulate the same record the same way, and only the
        // transform differs. If the two ever disagreed on how many there are,
        // the numbering would mean nothing, so the whole part is written.
        const source = builtPieces && builtPieces.pieces[index];
        const matched = source && source.triangleCount === written.triangleCount;
        let palette = FbxPalette.apply(part.materials.map(materialEntry), materialOverrides);

        // A material given to a part by hand is not one of that part's own, so
        // it goes on the end of its palette and the triangles are pointed at
        // it. This happens before the slice, while the numbering is still the
        // part's own.
        const assigned = matched ? assignedOf(index, written.triangleCount) : null;
        if (assigned) {
          const local = new Map();
          for (let face = 0; face < written.triangleCount; face++) {
            const slot = assigned[face];
            if (slot < 0 || !currentPalette[slot]) continue;
            if (!local.has(slot)) {
              local.set(slot, palette.length);
              palette = palette.concat([currentPalette[slot]]);
            }
            const at3 = face * 3;
            written.materials[at3] = local.get(slot);
            written.materials[at3 + 1] = local.get(slot);
            written.materials[at3 + 2] = local.get(slot);
          }
        }
        if (faces && matched) {
          written = FbxEdits.slice(written, faces);
        } else if (faces || (touched && !matched)) {
          console.warn(`${part.model.displayName}: exported whole — `
            + 'the edited mesh and the one being written do not match');
        }
        if (written.triangleCount) {
          at = meshes.length;
          meshes.push({
            name: part.geometry.displayName || part.model.displayName,
            mesh: written,
            palette,
          });
        }
      }
      FbxWasm.release(heapMark);
      meshOf.set(key, at);
      return at;
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
    sceneParts.forEach((part, index) => {
      const node = nodes.get(part.key);
      if (!node) return;
      const at = meshFor(part, index);
      if (at >= 0) node.mesh = at;
    });

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

  /**
   * Say which part the mouse picked, and pick it out on the model.
   *
   * A part is one model's mesh: what the file calls a part, not a material and
   * not a triangle. -1 is nothing selected.
   */
  function setSelectedPart(index) {
    const part = index >= 0 ? partTable[index] : null;
    selectedPart = part ? index : -1;
    if (viewer) viewer.setSelectedPart(selectedPart);
    if (!part) {
      dom.partInfo.hidden = true;
      dom.partName.textContent = '';
      updateEditControls();
      return;
    }
    const size = [0, 1, 2].map((k) => part.max[k] - part.min[k]);
    const materials = (part.materials || []).filter(Boolean).map(shownMaterial);
    // Exporters write names like a filing system; show enough to recognise the
    // part and keep the whole of it for the tooltip.
    const shorten = (text) => (text.length > 44 ? `${text.slice(0, 43)}…` : text);
    dom.partName.textContent = `${shorten(part.name)} · `
      + `${part.triangles.toLocaleString()} triangles · `
      + `${size.map((v) => (Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(3))).join(' × ')} units`
      + (materials.length ? ` · ${shorten(materials.slice(0, 2).join(', '))}` : '');
    dom.partName.title = part.name
      + (materials.length ? `\n${materials.join(', ')}` : '');
    dom.partInfo.hidden = false;
    updateEditControls();
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
      if (!name || !field || field === 'name') return;
      if (field === 'colour') editMaterial(name, { colour: FbxPalette.fromHex(event.target.value) });
      else editMaterial(name, { [field]: Number(event.target.value) });
    });

    // A name is committed when it is finished with, not letter by letter: the
    // list is rebuilt around it, and rebuilding it under a half-typed name
    // would take the field away mid-word.
    dom.materials.addEventListener('change', (event) => {
      if (event.target.dataset.field !== 'name') return;
      const key = keyOf(event);
      if (key) renameMaterial(key, event.target.value);
    });
    dom.materials.addEventListener('keydown', (event) => {
      if (event.target.dataset.field !== 'name') return;
      if (event.key === 'Enter') event.target.blur();
      else if (event.key === 'Escape') {
        event.target.value = event.target.defaultValue;
        event.target.blur();
      }
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
      persist();
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
      // Whatever the file says it is: a .blend and a glTF state a metalness
      // outright, and so does an FBX written from a Physical Material or a
      // standardSurface. A plain Phong material states none, and is a
      // dielectric.
      metallic: look.metallic,
      // Kept so an assignment can always be undone back to the file itself —
      // the name included, since a material can be renamed and its settings
      // still have to be found under what the file called it.
      fromFile: {
        name: material.displayName,
        colour: look.colour.slice(),
        specular: look.specular.slice(),
        roughness: look.roughness,
        opacity: look.opacity,
        metallic: look.metallic,
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

  /**
   * Start where the file says it was modelled.
   *
   * A 3ds Max scene built with TurboSmooth stores the cage, and drawing the
   * cage is drawing something nobody modelled — so the smoothing control opens
   * on the rounds the modifier asks for. It is a control like any other and
   * can be turned down; what it must not do is override a choice already made.
   */
  function applySceneSmoothing(doc) {
    if (modeChosen || subdivisionLevel) return;
    const rounds = (doc.extra && doc.extra.smoothing) || 0;
    const parts = (doc.extra && doc.extra.smoothed) || 0;
    if (!rounds || !parts) return;
    const wanted = Math.min(rounds, 2);
    dom.subdivSelect.value = String(wanted);
    subdivisionLevel = wanted;
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
      // Building the geometry again renumbers its triangles, so the edits made
      // to the last build no longer describe anything: the scene comes back
      // whole, which is said out loud rather than left to be noticed.
      const hadEdits = edited();
      builtPieces = buildPieces(sceneParts);
      // The materials a saved assignment added come back before the scene is
      // put together, since the parts are dressed out of the same palette.
      restoreAddedMaterials();
      resetSegments();
      const built = assemble(builtPieces, currentSegments());
      if (!built) {
        dom.meshInfo.textContent = 'no triangles in this scene';
        viewer.clear();
        return;
      }
      if (hadEdits) setStatus('The scene was rebuilt, so every part is back.', 'warn');
      const elapsed = performance.now() - started;
      viewer.setMesh(built.mesh, { keepCamera });
      partTable = built.table || [];
      viewer.setParts(partTable);
      setSelectedPart(-1);
      // Only a scene of several parts has anything to pull apart.
      dom.explodeSlider.disabled = partTable.length < 2;
      if (dom.explodeSlider.disabled) dom.explodeSlider.value = '0';
      viewer.setExplode(Number(dom.explodeSlider.value) / 100);
      updateEditControls();

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
      if (currentDoc.format === 'max' && currentDoc.extra.smoothed && subdivisionLevel) {
        text += ` — ${currentDoc.extra.smoothed} part(s) were modelled with it`;
      }
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
      // Building the geometry again renumbers its triangles, so the edits made
      // to the last build no longer describe anything.
      const hadEdits = edited();
      const palette = materialPalette(entry);
      const raw = buildMesh(entry);
      if (!raw || !raw.triangleCount) {
        dom.meshInfo.textContent = 'this record has no triangles';
        viewer.clear();
        return;
      }
      // One geometry on its own is still one part — clicking it should say
      // what it is, and splitting it should give the pieces it is made of —
      // but there is nothing to pull it apart from until it is split.
      const [name] = FbxAnalyze.splitObjectName(
        entry.props.map((prop) => prop.value).find((v) => typeof v === 'string') || '');
      builtPieces = {
        palette,
        // Copied out of WebAssembly memory, which the next build may move.
        pieces: [{
          positions: raw.positions.slice(),
          normals: raw.normals.slice(),
          materials: raw.materials.slice(),
          uvs: raw.uvs.slice(),
          hasUv: raw.hasUv,
          triangleCount: raw.triangleCount,
          polygonCount: raw.polygonCount,
          min: raw.min.slice(),
          max: raw.max.slice(),
          name: name || entry.name,
          materialNames: palette.map((material) => material.name),
        }],
      };
      // One geometry has no parts for an assignment to dress, but the
      // materials it names are the same materials, so they are built here too.
      restoreAddedMaterials();
      resetSegments();
      const built = assemble(builtPieces, currentSegments());
      const mesh = built.mesh;
      const elapsed = performance.now() - started;
      viewer.setMesh(mesh, { keepCamera });
      partTable = built.table;
      viewer.setParts(partTable);
      setSelectedPart(-1);
      dom.explodeSlider.disabled = true;
      dom.explodeSlider.value = '0';
      viewer.setExplode(0);
      updateEditControls();
      if (hadEdits) setStatus('The mesh was rebuilt, so every part is back.', 'warn');

      const textures = await resolveTextures(palette);
      missingTextures = textures.missing;
      // The assembled palette, not the geometry's own: an assignment can add
      // materials to it, and the mesh was put together against that one.
      installPalette(built.palette, mesh);
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
    dom.explodeSlider.addEventListener('input',
      () => viewer.setExplode(Number(dom.explodeSlider.value) / 100));

    // A click picks a part; a drag is the camera, so the two are told apart by
    // how far the pointer travelled between going down and coming up.
    let pressedAt = null;
    dom.canvas.addEventListener('pointerdown', (event) => {
      pressedAt = { x: event.clientX, y: event.clientY };
    });
    dom.canvas.addEventListener('pointerup', (event) => {
      const from = pressedAt;
      pressedAt = null;
      if (!from || event.button !== 0) return;
      if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > 4) return;
      const box = dom.canvas.getBoundingClientRect();
      setSelectedPart(viewer.pickPart(event.clientX - box.left, event.clientY - box.top));
    });
    dom.partMaterial.addEventListener('change', () => {
      const chosen = dom.partMaterial.value;
      if (selectedPart < 0) return;
      if (chosen === 'new') addMaterial(selectedPart);
      else if (chosen === '') unassignMaterial(selectedPart);
      else assignMaterial(selectedPart, Number(chosen));
    });
    dom.partSplit.addEventListener('click', () => splitPart(selectedPart, 'shells'));
    dom.partSplitMaterial.addEventListener('click', () => splitPart(selectedPart, 'material'));
    dom.partDelete.addEventListener('click', () => deletePart(selectedPart));
    dom.restoreAll.addEventListener('click', restoreAll);

    document.addEventListener('keydown', (event) => {
      // Typing into the panel is not a shortcut: a colour field or a select
      // has first claim on every key that reaches it.
      const target = event.target;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        if (key === 'z' && !event.shiftKey) { event.preventDefault(); undoEdit(); }
        else if (key === 'y' || (key === 'z' && event.shiftKey)) {
          event.preventDefault();
          redoEdit();
        }
        return;
      }
      if (event.key === 'Escape' && selectedPart >= 0) { setSelectedPart(-1); return; }
      if (selectedPart < 0) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deletePart(selectedPart);
      } else if (key === 's') splitPart(selectedPart, 'shells');
      else if (key === 'm') splitPart(selectedPart, 'material');
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
      get partTable() { return partTable; },
      get selectedPart() { return selectedPart; },
      selectPart: setSelectedPart,
      get edits() { return editSummary(); },
      get segments() { return currentSegments(); },
      deletePart,
      splitPart,
      assignMaterial,
      unassignMaterial,
      addMaterial,
      undo: undoEdit,
      redo: redoEdit,
      restoreAll,
      get lastExport() { return lastExport; },
      exportMesh: () => currentMesh,
      exportGltf,
      get materials() { return materialGroups; },
      get overrides() { return materialOverrides; },
      loadFile,
      loadFiles,
      editMaterial,
      renameMaterial,
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
