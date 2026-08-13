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
  /** Image files the user supplied, keyed by lowercased basename. */
  const suppliedImages = new Map();
  /** Material libraries the user supplied, keyed by lowercased basename. */
  const suppliedMaterials = new Map();
  let missingTextures = [];
  /** The palette on screen, its materials grouped, and the user's edits. */
  let currentPalette = [];
  let materialGroups = [];
  let materialOverrides = {};
  /** The mesh on screen, kept for the glTF export. */
  let currentMesh = null;
  let lastExport = null;

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
    const assignments = list.filter((f) => /\.json$/i.test(f.name));
    for (const image of images) suppliedImages.set(image.name.toLowerCase(), image);
    for (const library of libraries) {
      suppliedMaterials.set(library.name.toLowerCase(), await library.text());
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

    const companions = new Set([...images, ...libraries, ...assignments]);
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
      if (lastSceneFile && libraries.length) await loadFile(lastSceneFile);
      else if (currentGeometry) await showGeometry(currentGeometry);
      else if (sceneParts.length) await showScene();
      return;
    }
    await loadFile(scene);
  }

  async function loadFile(file) {
    setStatus(`Reading ${file.name}…`);
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const started = performance.now();

      let doc = null;
      if (FbxBlend.looksLikeBlend(buffer)) {
        doc = FbxBlend.parse(buffer);
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
            + '(binary or ASCII), OBJ or .blend.', 'error');
          return;
        }
      } else if (doc.format !== 'blend') {
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
      uidIndex = new Map(currentAnalysis.objects
        .filter((o) => o.uid !== null).map((o) => [o.uid, o]));

      dom.panel.innerHTML = FbxReport.render(currentAnalysis);
      dom.tree.innerHTML = FbxReport.recordTree(doc.root);
      document.body.classList.add('loaded');
      // Taken out of the layout rather than faded: assembling a large scene
      // blocks the main thread for long enough that a CSS transition can sit
      // at full opacity over the model for seconds.
      dom.drop.hidden = true;

      const what = doc.format === 'obj' ? 'Wavefront OBJ'
        : doc.format === 'blend' ? `Blender ${doc.extra.blenderVersionText || '?'}`
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
   * its transform, its parent, and its materials in slot order.
   *
   * A mesh is stored in its model's local space, so a scene only assembles
   * correctly once each part is placed by its model's world matrix.
   */
  function collectParts() {
    const info = currentAnalysis;
    if (!info) return [];
    const byUid = new Map(info.objects.filter((o) => o.uid !== null).map((o) => [o.uid, o]));

    // Keyed by model, not by geometry: one mesh is often shared by several
    // models — four wheels from one wheel — and each of those is its own part.
    const parts = new Map();          // model uid -> part
    for (const conn of info.connections) {
      if (conn.kind !== 'OO') continue;
      const geometry = byUid.get(conn.src);
      const model = byUid.get(conn.dst);
      if (!geometry || geometry.nodeType !== 'Geometry') continue;
      if (!model || model.nodeType !== 'Model' || parts.has(model.uid)) continue;
      parts.set(model.uid, {
        model,
        geometry,
        materials: [],
        parent: null,
        properties: FbxAnalyze.resolvedProperties(model, info.templates),
      });
    }

    for (const conn of info.connections) {
      if (conn.kind !== 'OO') continue;
      const part = parts.get(conn.dst);
      const source = byUid.get(conn.src);
      if (part && source && source.nodeType === 'Material') part.materials.push(source);
      // Model-to-model parenting, for the transform chain.
      const child = parts.get(conn.src);
      if (child && byUid.get(conn.dst) && byUid.get(conn.dst).nodeType === 'Model') {
        child.parent = conn.dst;
      }
    }
    return [...parts.entries()].map(([uid, part]) => ({ uid, ...part }));
  }

  /** A part's world matrix, composed up the parent chain. */
  function worldMatrix(part, byUid, cache) {
    if (cache.has(part.uid)) return cache.get(part.uid);
    let matrix = FbxTransform.localMatrix(part.properties);
    if (part.parent !== null && byUid.has(part.parent)) {
      const parent = byUid.get(part.parent);
      matrix = FbxTransform.multiply(worldMatrix(parent, byUid, cache), matrix);
    }
    cache.set(part.uid, matrix);
    return matrix;
  }

  /** Build every part, placed in world space, as one combined mesh. */
  function buildScene(parts) {
    const byUid = new Map(parts.map((p) => [p.uid, p]));
    const cache = new Map();
    const pieces = [];
    const palette = [];

    // Everything a part allocates is scratch once its result is copied out.
    const heapMark = FbxWasm.mark();
    for (const part of parts) {
      const world = worldMatrix(part, byUid, cache);
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

  /** Choose the up axis for a freshly built mesh and put the viewer on it. */
  function applyUpAxis(mesh) {
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

  /** Objects by UID, rebuilt only when a new file is analysed. */
  let uidIndex = new Map();

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

  /** Each material's base colour image, as the bytes the file carried. */
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
      if (mimeType) out.set(entry.name, { bytes, mimeType });
    }
    return out;
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
      const { glb, stats } = FbxGltf.build({
        name: stem,
        mesh: currentMesh,
        palette: currentPalette,
        images,
        upAxis: dom.upSelect.value,
        unitScale: centimetres / 100,
      });
      download(new Blob([glb], { type: 'model/gltf-binary' }), `${stem}.glb`);
      lastExport = stats;
      setStatus(`Exported ${stats.triangles.toLocaleString()} triangles as `
        + `${stats.primitives} primitive(s), ${stats.vertices.toLocaleString()} vertices, `
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
      texture: diffuseTexture(material, uidIndex, currentAnalysis.connections),
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
    const byUid = new Map(info.objects.filter((o) => o.uid !== null).map((o) => [o.uid, o]));
    const uid = entry.props.map((p) => p.value).find((v) => typeof v === 'number');
    if (uid === undefined) return [];               // legacy 6.x files have no UIDs

    // A Model may hold its own geometry; otherwise walk Geometry -> Model.
    let modelUid = uid;
    if (entry.name !== 'Model') {
      const link = info.connections.find((c) => c.kind === 'OO' && c.src === uid);
      if (!link) return [];
      modelUid = link.dst;
    }

    return info.connections
      .filter((c) => c.kind === 'OO' && c.dst === modelUid)
      .map((c) => byUid.get(c.src))
      .filter((o) => o && o.nodeType === 'Material')
      .map(materialEntry);
  }

  /* --------------------------------------------------------------- textures */

  /** Basename of a path written with either separator, lowercased. */
  function baseName(path) {
    return String(path).split(/[\\/]/).pop().toLowerCase();
  }

  /**
   * The diffuse texture bound to a material, if any.
   *
   * A Texture attaches to a Material through an object-to-property connection
   * naming the property it drives, so only DiffuseColor is followed here. The
   * image itself may be embedded in the Texture or in the Video it references.
   */
  function diffuseTexture(material, byUid, connections) {
    const link = connections.find((c) => c.kind === 'OP' && c.dst === material.uid
      && (c.prop === 'DiffuseColor' || c.prop === 'Diffuse'));
    if (!link) return null;
    const texture = byUid.get(link.src);
    if (!texture || texture.nodeType !== 'Texture') return null;

    const media = connections
      .filter((c) => c.kind === 'OO' && c.dst === texture.uid)
      .map((c) => byUid.get(c.src))
      .find((o) => o && o.nodeType === 'Video');

    // Embedded media rides along in a Content property as raw bytes.
    const embedded = [texture.node, media && media.node]
      .filter(Boolean)
      .map((node) => {
        const content = node.children.find((c) => c.name === 'Content');
        const prop = content && content.props.find((p) => p.value instanceof Uint8Array);
        return prop && prop.value.length ? prop.value : null;
      })
      .find(Boolean) || null;

    const path = FbxAnalyze.pathValue(texture.node, ['RelativeFilename'])
      || FbxAnalyze.pathValue(texture.node, ['FileName'])
      || (media && FbxAnalyze.pathValue(media.node, ['RelativeFilename']))
      || '';
    return { name: texture.displayName, path, embedded };
  }

  /** Decode one image, from embedded bytes or a file the user supplied. */
  async function decodeTexture(request, supplied) {
    if (request.embedded) {
      const blob = new Blob([request.embedded]);
      try {
        return await createImageBitmap(blob);
      } catch (error) {
        return null;                       // an image format the browser refuses
      }
    }
    const file = supplied.get(baseName(request.path));
    if (!file) return null;
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
      dom.meshInfo.textContent = 'no renderable geometry in this file';
      viewer.clear();
      return;
    }

    // A scene is only itself once every part is placed, so that comes first.
    if (sceneParts.length > 1) {
      const whole = document.createElement('option');
      whole.value = 'scene';
      whole.textContent = `Whole scene — ${sceneParts.length} parts`;
      dom.geometrySelect.appendChild(whole);
    }
    dom.geometrySelect.disabled = candidates.length === 1 && sceneParts.length <= 1;
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
    return sceneParts.length > 1 ? showScene() : showGeometry(candidates[0]);
  }

  /** Yield long enough for the browser to paint pending UI changes. */
  const nextFrame = () => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });

  /** Render every part of the scene, each placed by its model's transform. */
  async function showScene() {
    currentGeometry = null;
    try {
      dom.meshInfo.textContent = `assembling ${sceneParts.length} parts…`;
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
      viewer.setMesh(built.mesh);

      const textures = await resolveTextures(built.palette);
      missingTextures = textures.missing;
      installPalette(built.palette, built.mesh);
      viewer.setTextures(textures.images);
      dom.modeSelect.value = built.palette.length ? '0' : '2';
      viewer.setMode(Number(dom.modeSelect.value));
      dom.textureToggle.disabled = textures.images.length === 0;
      applyUpAxis(built.mesh);

      const size = [0, 1, 2].map((i) => (built.mesh.max[i] - built.mesh.min[i]));
      let text = `${built.parts} parts · ${built.mesh.triangleCount.toLocaleString()} `
        + `triangles · ${size.map((v) => v.toFixed(1)).join(' × ')} units · `
        + `${elapsed.toFixed(0)} ms · ${built.palette.length} material colours`;
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


  /** Pull the arrays a geometry record needs and hand them to the WASM core. */
  function buildMesh(entry, placement = {}) {
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
    let normalIndex = null;
    let mapping = 'none';
    let normalReference = 'direct';
    const normalLayer = entry.children.find((c) => c.name === 'LayerElementNormal');
    if (normalLayer) {
      const prop = nestedArray(normalLayer.children.find((c) => c.name === 'Normals'));
      const mapType = FbxAnalyze.pathValue(normalLayer, ['MappingInformationType']);
      const refType = String(FbxAnalyze.pathValue(normalLayer, ['ReferenceInformationType']) || 'Direct');
      if (mapType === 'ByPolygonVertex') mapping = 'byPolygonVertex';
      else if (mapType === 'ByVertice' || mapType === 'ByVertex') mapping = 'byVertex';
      if (prop && mapping !== 'none') {
        normals = toF64(prop);
        if (refType.startsWith('IndexToDirect') || refType === 'Index') {
          const indexProp = nestedArray(
            normalLayer.children.find((c) => c.name === 'NormalsIndex'
              || c.name === 'NormalIndex'),
          );
          if (indexProp) {
            normalIndex = toI32(indexProp);
            normalReference = 'indexToDirect';
          } else {
            normals = null;                // indexed but no index array; use faces
          }
        }
      }
    }

    let materials = null;
    const materialLayer = entry.children.find((c) => c.name === 'LayerElementMaterial');
    if (materialLayer) {
      const prop = nestedArray(materialLayer.children.find((c) => c.name === 'Materials'));
      if (prop) materials = toI32(prop);
    }

    let uvs = null;
    let uvIndex = null;
    let uvMapping = 'none';
    let uvReference = 'direct';
    const uvLayer = entry.children.find((c) => c.name === 'LayerElementUV');
    if (uvLayer) {
      const prop = nestedArray(uvLayer.children.find((c) => c.name === 'UV'));
      const mapType = FbxAnalyze.pathValue(uvLayer, ['MappingInformationType']);
      const refType = String(FbxAnalyze.pathValue(uvLayer, ['ReferenceInformationType']) || 'Direct');
      if (mapType === 'ByPolygonVertex') uvMapping = 'byPolygonVertex';
      else if (mapType === 'ByVertice' || mapType === 'ByVertex') uvMapping = 'byVertex';
      if (prop && uvMapping !== 'none') {
        uvs = toF64(prop);
        if (refType.startsWith('IndexToDirect') || refType === 'Index') {
          const indexProp = nestedArray(uvLayer.children.find((c) => c.name === 'UVIndex'));
          if (indexProp) {
            uvIndex = toI32(indexProp);
            uvReference = 'indexToDirect';
          } else {
            uvs = null;                    // indexed but no index array to follow
          }
        }
      }
    }

    return FbxWasm.buildMesh({
      positions, indices: polygons,
      normals, normalMapping: mapping, normalReference: normalReference,
      normalIndex,
      uvs, uvIndex, uvMapping, uvReference,
      materials,
      ...placement,
    });
  }

  async function showGeometry(entry) {
    currentGeometry = entry;
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

      const palette = materialPalette(entry);
      const textures = await resolveTextures(palette);
      missingTextures = textures.missing;
      installPalette(palette, mesh);
      viewer.setTextures(textures.images);
      // Without usable colours the file-colour mode has nothing to show.
      dom.modeSelect.value = palette.length ? '0' : '2';
      viewer.setMode(Number(dom.modeSelect.value));
      dom.textureToggle.disabled = textures.images.length === 0;

      const chosen = applyUpAxis(mesh);

      const size = [0, 1, 2].map((i) => (mesh.max[i] - mesh.min[i]));
      let text = `${mesh.triangleCount.toLocaleString()} triangles from `
        + `${mesh.polygonCount.toLocaleString()} polygons · `
        + `${size.map((v) => v.toFixed(1)).join(' × ')} units · ${elapsed.toFixed(0)} ms`;
      text += palette.length
        ? ` · ${palette.length} material colours`
        : ' · no material colours in this file';
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
    dom.modeSelect.addEventListener('change', () => viewer.setMode(Number(dom.modeSelect.value)));
    dom.upSelect.addEventListener('change', () => viewer.setUpAxis(dom.upSelect.value));
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
