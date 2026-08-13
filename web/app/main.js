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
    textureToggle: $('texture-toggle'),
    resetView: $('reset-view'),
    tabs: document.querySelectorAll('.tab'),
    tree: $('tree'),
    stage: $('stage'),
  };

  let viewer = null;
  let currentDoc = null;
  let currentAnalysis = null;
  let currentGeometry = null;
  /** Image files the user supplied, keyed by lowercased basename. */
  const suppliedImages = new Map();
  let missingTextures = [];

  function setStatus(text, kind = '') {
    dom.status.textContent = text || '';
    dom.status.className = `status ${kind}`;
  }

  /* --------------------------------------------------------------- loading */

  /** Take a drop or a multi-select: one FBX plus any images it needs. */
  async function loadFiles(files) {
    const list = Array.from(files);
    const images = list.filter((f) => /\.(png|jpe?g|gif|bmp|webp|tga)$/i.test(f.name));
    for (const image of images) suppliedImages.set(image.name.toLowerCase(), image);

    const scene = list.find((f) => !images.includes(f));
    if (!scene) {
      if (!currentGeometry) {
        setStatus(`Added ${images.length} image(s) — now open an .fbx file.`);
        return;
      }
      // Images arriving after the scene: re-resolve so they appear.
      setStatus(`Added ${images.length} image(s), applying…`);
      await showGeometry(currentGeometry);
      return;
    }
    await loadFile(scene);
  }

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
      .map((material) => {
        const props = FbxAnalyze.properties(material.node);
        let colour = props.DiffuseColor !== undefined ? props.DiffuseColor : props.Diffuse;
        if (typeof colour === 'number') colour = [colour, colour, colour];
        if (!Array.isArray(colour)) colour = [0.72, 0.73, 0.76];
        const factor = typeof props.DiffuseFactor === 'number' ? props.DiffuseFactor : 1;
        return {
          name: material.displayName,
          // Values are linear, which is what the shader's output curve expects.
          colour: [0, 1, 2].map((i) => (Number(colour[i]) || 0) * factor),
          texture: diffuseTexture(material, byUid, info.connections),
          layer: -1,
        };
      });
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
      viewer.setPalette(palette);
      viewer.setTextures(textures.images);
      // Without usable colours the file-colour mode has nothing to show.
      dom.modeSelect.value = palette.length ? '0' : '2';
      viewer.setMode(Number(dom.modeSelect.value));
      dom.textureToggle.disabled = textures.images.length === 0;

      const declaredAxis = (currentAnalysis.globalSettings.upAxis || '+Y').includes('Z')
        ? 'z' : 'y';
      const chosen = guessUpAxis(mesh.min, mesh.max, declaredAxis);
      dom.upSelect.value = chosen.axis;
      viewer.setUpAxis(chosen.axis);

      const size = [0, 1, 2].map((i) => (mesh.max[i] - mesh.min[i]));
      let text = `${mesh.triangleCount.toLocaleString()} triangles from `
        + `${mesh.polygonCount.toLocaleString()} polygons · `
        + `${size.map((v) => v.toFixed(1)).join(' × ')} units · ${elapsed.toFixed(0)} ms`;
      text += palette.length
        ? ` · ${palette.length} material colours`
        : ' · no material colours in this file';
      if (textures.requested) {
        text += ` · ${textures.images.length}/${textures.requested} textures`;
        if (!mesh.hasUv) text += ' (no UVs in this mesh)';
      }
      if (textures.missing.length) {
        text += ` · missing: ${textures.missing.join(', ')} — drop the image in`;
      }
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
      if (dom.fileInput.files.length) loadFiles(dom.fileInput.files);
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
      const files = event.dataTransfer && event.dataTransfer.files;
      if (files && files.length) loadFiles(files);
    });

    dom.geometrySelect.addEventListener('change', () => {
      const candidates = FbxAnalyze.findAllGeometry(currentDoc);
      const entry = candidates[Number(dom.geometrySelect.value)];
      if (entry) showGeometry(entry);
    });
    dom.modeSelect.addEventListener('change', () => viewer.setMode(Number(dom.modeSelect.value)));
    dom.upSelect.addEventListener('change', () => viewer.setUpAxis(dom.upSelect.value));
    dom.spinToggle.addEventListener('change', () => viewer.setAutoRotate(dom.spinToggle.checked));
    dom.textureToggle.addEventListener('change',
      () => viewer.setShowTextures(dom.textureToggle.checked));
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
    setStatus('Ready — drop an .fbx file, ASCII or binary. '
      + 'Drop image files alongside it for textures it references.');
    window.fbxtool = {
      get doc() { return currentDoc; },
      get analysis() { return currentAnalysis; },
      get viewer() { return viewer; },
      get missingTextures() { return missingTextures; },
      loadFile,
      loadFiles,
    };
    document.body.dataset.ready = 'true';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
