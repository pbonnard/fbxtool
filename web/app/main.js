/* UI wiring: file input, drag and drop, geometry selection and viewport
 * controls.
 */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const dom = {
    drop: $('drop'),
    fileInput: $('file-input'),
    folderInput: $('folder-input'),
    picker: $('picker'),
    pickerFolder: $('picker-folder'),
    panel: $('panel'),
    status: $('status'),
    canvas: $('viewport'),
    meshInfo: $('mesh-info'),
    geometrySelect: $('geometry-select'),
    skinSelect: $('skin-select'),
    modeSelect: $('mode-select'),
    subdivSelect: $('subdiv-select'),
    upSelect: $('up-select'),
    flipButtons: [$('flip-x'), $('flip-y'), $('flip-z')],
    turnButton: $('turn-button'),
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
    lightsToggle: $('lights-toggle'),
    lightsLabel: $('lights-label'),
    textureToggle: $('texture-toggle'),
    resetView: $('reset-view'),
    exportGltf: $('export-gltf'),
    exportFormat: $('export-format'),
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
  /** What the file asked for, where that was more than was drawn unasked. */
  let heldBackSmoothing = 0;
  /** Whether the shading mode on screen is the user's choice or ours. */
  let modeChosen = false;
  /** The same, for the up axis — remembered per file, so reopening a model
   *  that the viewer reads wrongly does not need correcting twice. */
  let upAxisChosen = false;
  /** An assignment dropped before there was a model to put it on, or with the
   *  model it belongs to: either way it is applied once the model is loaded. */
  let pendingAssignment = null;
  /* A second file, read for its materials, waiting for the scene it dresses. */
  let pendingDonor = null;
  /* What a drop of several formats was found to hold, for the record. */
  let lastSurvey = null;
  /** Image files the user supplied, keyed by lowercased basename. */
  const suppliedImages = new Map();
  /** Skin folders the user supplied, keyed by the folder's own name. */
  const suppliedSkins = new Map();
  /** The one that is on, read and held against the car it is for. */
  let wearing = null;
  /** Every skin worth offering for the car that is open. */
  let skinsOffered = [];
  /** What the car's own extension config calls its paint, for skins that
   *  do not say — read from beside the car rather than from inside the game. */
  let carPaintNames = [];
  /** And how bright it says each of them is drawn, under whatever the skin
   *  that is on says about the same material. */
  let carPaintBrightness = new Map();
  /** And what its `[Material_*]` blocks say each surface is made of, which on
   *  a Custom Shaders Patch car is where the material actually lives. */
  let carMaterialFinish = new Map();
  //: Mesh name -> the colour of the lens it is, out of the car's lighting
  //: config. `SURFACE` there names a mesh and not a material, and on a
  //: Renault 5 the two do not line up.
  let lensColours = new Map();
  /** What the same config says lights up when the car's lights are on, and
   *  the lamps it carries as lights rather than as surfaces. */
  let carLamps = new Map();
  let carLightSources = [];
  /** Material libraries the user supplied, keyed by lowercased basename. */
  const suppliedMaterials = new Map();
  /* What a BeamNG car keeps beside its model: `main.materials.json` and the
   * `skin.materials.json` for its liveries, which is where a `.dae` puts what
   * its surfaces actually are. Kept like a `.mtl`, and read the same way —
   * with the model, before it, or dropped in afterwards. */
  const suppliedDressing = new Map();
  /** Binary payloads a .gltf points at, keyed the same way. */
  const suppliedBuffers = new Map();
  let missingTextures = [];
  /** Named, supplied, and still not an image this can draw. */
  let unreadableTextures = [];
  /** The palette on screen, its materials grouped, and the user's edits. */
  let currentPalette = [];
  let materialGroups = [];
  /** The list the material rows on screen were drawn from. */
  let renderedGroups = null;
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

  /* -------------------------------------------------------- dropped folders
   *
   * A model downloaded as a folder keeps its images in a subfolder beside it —
   * a Sketchfab glTF has `textures/`, and the document names them by relative
   * path. `dataTransfer.files` does not go into a folder, so dropping the
   * folder used to hand over the document and nothing else: the model arrived
   * with none of its images, and every material fell back to whatever it
   * states on its own. On a car that is a set of white chrome tyres, because
   * glTF's default for a metalness a file leaves out is 1 and the map that
   * qualifies it was in the folder that did not come.
   */

  //: Enough for any model's texture folder, and a stop on a whole disk.
  const DROP_LIMIT = 512;
  const DROP_DEPTH = 8;

  //: What this reads, for telling the model in a folder from what is beside it.
  const MODEL_NAMES = /\.(fbx|obj|dae|gltf|glb|blend|max|kn5)$/i;

  /** The filesystem entries of a drop, taken before the transfer empties. */
  function droppedEntries(transfer) {
    if (!transfer.items) return [];
    return Array.from(transfer.items)
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
  }

  /* Where a dropped file was, which a `File` on its own does not know.
   *
   * A directory picker fills in `webkitRelativePath`; a folder drop hands over
   * entries and the path has to be kept as they are walked. It matters because
   * a car's skins are told apart by the folder they are in and by nothing
   * else: every one of them holds a `leather_1.dds`. */
  const droppedPaths = new WeakMap();

  const pathOf = (file) => file.webkitRelativePath || droppedPaths.get(file) || file.name;

  /** Every file under what was dropped, folders walked through. */
  async function collectDropped(entries, plain) {
    if (!entries.length) return plain;
    const out = [];
    const fileOf = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));

    const walk = async (entry, depth, under) => {
      if (out.length >= DROP_LIMIT || depth > DROP_DEPTH) return;
      if (entry.isFile) {
        const file = await fileOf(entry);
        if (file) {
          droppedPaths.set(file, under ? `${under}/${file.name}` : file.name);
          out.push(file);
        }
        return;
      }
      if (!entry.isDirectory) return;
      const reader = entry.createReader();
      const inside = under ? `${under}/${entry.name}` : entry.name;
      // readEntries hands back a batch at a time and an empty one at the end,
      // so it has to be asked until it says there is no more.
      for (;;) {
        const batch = await new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
        if (!batch.length) break;
        for (const child of batch) await walk(child, depth + 1, inside);
        if (out.length >= DROP_LIMIT) break;
      }
    };

    for (const entry of entries) await walk(entry, 0, '');
    return out.length ? out : plain;
  }

  //: What counts as something a model needs rather than something beside it.
  const COMPANION_NAMES = /\.(png|jpe?g|gif|bmp|webp|tga|ktx2|psd|dds|mtl|bin|json|ini)$/i;

  /**
   * As much of a folder as is worth reading, models and their companions first.
   *
   * A folder picked by hand can be a whole library rather than one car, and
   * every `.mtl` is read as text and every `.bin` into memory on the way in.
   * What is left out is said out loud: a truncated set that loads quietly is
   * indistinguishable from a complete one that is missing something.
   */
  function withinLimit(list) {
    if (list.length <= DROP_LIMIT) return { list, left: 0 };
    const wanted = (f) => MODEL_NAMES.test(f.name) || COMPANION_NAMES.test(f.name);
    const kept = [...list.filter(wanted), ...list.filter((f) => !wanted(f))]
      .slice(0, DROP_LIMIT);
    return { list: kept, left: list.length - kept.length };
  }

  /* ------------------------------------------------- several formats at once
   *
   * A model is often downloaded as the same scene saved several ways, and the
   * ways disagree about what survived. Across eleven cars saved as `.max`,
   * `.fbx` and `.obj` together: the `.obj` never carried a usable material —
   * 3ds Max's exporter writes `wire_204204204` placeholders and no maps — one
   * `.max` had 215,558 vertices beside an `.fbx` with none but 162 textures,
   * and another had a subdividing modifier on 121 parts beside an `.fbx` that
   * held the only textures. Neither format wins; each file is asked what it
   * has.
   */

  /** What a parsed document holds, for choosing between files. */
  function holdingsOf(doc, info) {
    let vertices = 0;
    const objects = FbxAnalyze.child(doc.root, 'Objects');
    for (const entry of (objects ? objects.children : [])) {
      if (entry.name !== 'Geometry' && entry.name !== 'Model') continue;
      const held = FbxAnalyze.arrayLength(FbxAnalyze.child(entry, 'Vertices'));
      if (held) vertices += Math.floor(held / 3);
    }
    const count = (type) => info.objects.filter((o) => o.nodeType === type).length;
    return {
      vertices,
      materials: count('Material'),
      textures: count('Texture') + count('Video'),
      // A cage with a subdividing modifier on it is worth what it becomes, not
      // what it stores: each level roughly quadruples the faces, which is how
      // a 217,930-vertex `.max` outruns the 1,912,893-vertex `.obj` baked from
      // it — the tool subdivides further than the export did.
      smoothing: (doc.extra && doc.extra.smoothing) || 0,
    };
  }

  const richness = (m) => m.vertices * (4 ** Math.min(m.smoothing || 0, 3));

  /** Read every model in a drop, so the best of them can be picked. */
  async function surveyModels(candidates) {
    const out = [];
    for (const file of candidates) {
      setStatus(`Reading ${file.name}…`);
      await nextFrame();
      let doc = null;
      try {
        doc = await parseModel(file);
      } catch (error) {
        console.warn(`${file.name}: ${error.message}`);
      }
      if (!doc) continue;
      const info = FbxAnalyze.analyze(doc);
      out.push({ file, doc, info, ...holdingsOf(doc, info) });
    }
    return out;
  }

  /**
   * Which file to open, and which — if any — to take materials from.
   *
   * Geometry decides the first, and decides it well: there is no repairing a
   * mesh that is not there, and a vertex count is a fact rather than a
   * judgement.
   *
   * Which file has the *better* materials is not a fact, and counting does not
   * find it. A Ferrari saved both ways has 47 materials in the `.max` under
   * names of the reader's own making, and 58 in the `.fbx` under real ones —
   * `Carpaint Blue`, `Chrome Satin Clean`, `Aluminium Brushed` — with more
   * texture records besides. Taking the `.fbx`'s on the strength of any of
   * that turns a white car grey: they are V-Ray materials, and the Phong
   * approximation left in the FBX beside them is empty. `Carpaint Blue` reads
   * as 0.16 grey and `Aluminium Clean` as black.
   *
   * So a donor is used only where the base has no maps at all — an `.obj`
   * whose exporter wrote `wire_204204204` and nothing else, or a `.max` that
   * kept none. Then anything the other file has is more than nothing, and the
   * question of which is better does not arise.
   */
  function chooseSources(survey) {
    const usable = survey.filter((m) => m.vertices > 0);
    if (!usable.length) return { base: survey[0] || null, donor: null };
    const most = usable.reduce((best, m) => (richness(m) > richness(best) ? m : best));
    /* Geometry decides, but not by a hair. Two savings of the same scene
     * differ by a rounding when they differ at all — one Smart's `.obj` has
     * 497,850 vertices against its `.max`'s 486,057, two per cent — and a
     * mesh chosen on that margin can arrive with nothing on it: that `.obj`
     * carries two `wire_` placeholders where the `.max` has 25 materials and
     * two textures. Anything within a tenth is the same mesh, and then what
     * each file carries besides is what separates them. */
    const close = usable.filter((m) => richness(m) * 1.1 >= richness(most));
    const base = close.reduce((best, m) => {
      if (m.textures !== best.textures) return m.textures > best.textures ? m : best;
      if (m.materials !== best.materials) return m.materials > best.materials ? m : best;
      return richness(m) > richness(best) ? m : best;
    });
    /* Images are the only thing counted for. Having more materials is not
     * having better ones, which this cost a car to learn twice: a Smart's
     * `.obj` carries three `wire_` greys against eighteen in the `.fbx` beside
     * it, and every one of those eighteen reads as pure black — a V-Ray
     * export whose Phong block was left empty. Merging on the strength of
     * eighteen against three turns a white car black. An image is a fact; a
     * count is not. */
    const donor = base.textures > 0 ? null : survey
      .filter((m) => m !== base && m.textures > 0)
      .reduce((best, m) => (!best || m.textures > best.textures ? m : best), null);
    return { base, donor };
  }

  /** Take a drop or a multi-select: one FBX plus any images it needs. */
  async function loadFiles(files) {
    const { list, left } = withinLimit(Array.from(files));
    if (left) {
      setStatus(`That is ${(list.length + left).toLocaleString()} files — reading the `
        + `first ${DROP_LIMIT.toLocaleString()}, models and their images first.`, 'warn');
    }
    // KTX2 is a texture rather than a picture, and a .psd is a document rather
    // than either; no browser makes an image of one — but both are images this
    // tool decodes, so they arrive the same way as the rest rather than being
    // taken for the model.
    const images = list.filter(
      (f) => /\.(png|jpe?g|gif|bmp|webp|tga|ktx2|psd|dds)$/i.test(f.name));
    const libraries = list.filter((f) => /\.mtl$/i.test(f.name));
    // A .gltf keeps its vertices in a .bin beside it, the way an .obj keeps its
    // colours in an .mtl.
    const payloads = list.filter((f) => /\.bin$/i.test(f.name));
    const assignments = list.filter((f) => /\.json$/i.test(f.name));
    for (const image of images) suppliedImages.set(image.name.toLowerCase(), image);

    /* A new model is a new car, and what stood beside the last one does not
     * stand beside this one: skins left in the picker would offer another
     * car's paint, and its `extension/ext_config.ini` would name another car's
     * materials. What arrives *without* a model is an addition to whatever is
     * open — a texture that was missing, a skin folder dropped afterwards — so
     * only something that could be a model clears them.
     */
    if (list.some((file) => !COMPANION_NAMES.test(file.name))) {
      suppliedSkins.clear();
      suppliedDressing.clear();
      carPaintNames = [];
      carPaintBrightness = new Map();
      carMaterialFinish = new Map();
    }
    // The paint jobs beside the car, kept apart by the folder each was in.
    for (const [name, skin] of FbxSkins.group(list, pathOf)) suppliedSkins.set(name, skin);
    /* And the car's own `extension/ext_config.ini`, since half of them declare
     * which material is the paint once for the whole car rather than once per
     * skin — a Renault 5 names `body`, `body2` and `rim_colored` there and its
     * skins name none. */
    lensColours = new Map();
      carLamps = new Map();
      carLightSources = [];
    for (const file of list) {
      const where = pathOf(file).replace(/\\/g, '/');
      if (!/(^|\/)extension\/[^/]+\.ini$/i.test(where)) {
        continue;
      }
      const text = await file.text();
      /* Every ini beside the car, not only `ext_config.ini`: an author splits
       * the description across as many files as suits them and includes them
       * from the one, so the folder is read rather than the includes
       * followed. A later file's word on a material stands over an earlier
       * one's, which is the order they would have been included in. */
      for (const [material, said] of FbxSkins.materialFinish(text, '')) {
        carMaterialFinish.set(material, { ...(carMaterialFinish.get(material) || {}), ...said });
      }
      if (/(^|\/)extension\/ext_config\.ini$/i.test(where)) {
        carPaintNames = FbxSkins.paintMaterials(text);
        carPaintBrightness = FbxSkins.paintBrightness(text, '');
      }
      /* And what colour each lamp lens is. A car's lighting lives in
       * whichever files its author split it across — this one pulls in a
       * `lights.ini` beside its `ext_config.ini` — so the whole of the
       * folder is read rather than the includes followed. */
      for (const [mesh, colour] of FbxKn5.lensColours(text)) {
        if (!lensColours.has(mesh)) lensColours.set(mesh, colour);
      }
      const lighting = FbxKn5.carLighting(text);
      for (const [mesh, lamp] of lighting.lamps) {
        if (!carLamps.has(mesh)) carLamps.set(mesh, lamp);
      }
      carLightSources = carLightSources.concat(lighting.lights);
    }
    for (const library of libraries) {
      suppliedMaterials.set(library.name.toLowerCase(), await library.text());
    }
    for (const file of list) {
      if (!/\.materials\.json$/i.test(file.name)) continue;
      suppliedDressing.set(file.name.toLowerCase(), await file.text());
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
    // A folder brings whatever else is in it — a licence, a readme — and any
    // of those would otherwise be taken for the model on the strength of being
    // first. Something that names itself a model is preferred; a file with no
    // extension worth the name still gets its turn, since that is how a model
    // saved under an odd name has always been opened.
    const candidates = list.filter((f) => !companions.has(f));
    const models = candidates.filter((f) => MODEL_NAMES.test(f.name));
    // Several savings of the same scene: read them all and open the one with
    // the most to draw, taking materials from whichever has the most maps.
    if (models.length > 1) {
      const survey = await surveyModels(models);
      const { base, donor } = chooseSources(survey);
      // What each file was found to hold, and which was picked for what.
      lastSurvey = {
        files: survey.map((m) => ({
          name: m.file.name, vertices: m.vertices, materials: m.materials,
          textures: m.textures, smoothing: m.smoothing,
        })),
        base: base && base.file.name,
        donor: donor && donor.file.name,
      };
      if (base) {
        await loadFile(base.file, { donor });
        applyPending();
        return;
      }
    }
    const scene = models[0] || candidates[0];
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

  /* ------------------------------------------------- materials from a donor
   *
   * The two files hold the same scene, so their parts answer to the same
   * names — `desirefx.me_002` in the `.max` is `desirefx_me_002` in the `.obj`,
   * the exporter having replaced what a name cannot hold. Matched with the
   * punctuation taken out, 164 of 164 parts line up; on the other cars 93 of
   * 94, 118 of 125, 220 of 220.
   *
   * Materials are matched through the parts rather than by their own names,
   * which do not survive: a `.max` gives them names of its own making —
   * `material1001` — where the `.fbx` beside it has `Aluminium Brushed`.
   */

  const plainPart = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');

  /** What each of a donor's parts wears, by the name the part goes by. */
  function donorMaterials(donor) {
    const index = buildObjectIndex(donor.info.objects);
    const out = new Map();
    for (const part of collectParts(donor.info, index)) {
      const name = plainPart(part.model.displayName);
      const material = part.materials[0];
      if (!name || !material || out.has(name)) continue;
      out.set(name, materialEntry(material, donor.info, index));
    }
    return out;
  }

  /**
   * Dress the scene on screen in the donor's materials.
   *
   * Each donor material becomes one palette entry however many parts wear it,
   * and every part that answers to a matching name is put in it — through the
   * same assignment a part given a material by hand uses, so it undoes, saves
   * into an assignment and exports like anything else.
   */
  function applyDonor(donor) {
    if (!donor || !builtPieces) return null;
    const wanted = donorMaterials(donor);
    if (!wanted.size) return null;
    /* A scene of one part matched against a donor of many is not a merge: the
     * whole model comes out in whatever that one name happens to wear. A
     * Wavefront `.obj` reads as one part however many groups it was written
     * with, so this is what it hits — and one material over a whole car is
     * worse than the placeholders it replaced. */
    if (partTable.length === 1 && wanted.size > 1) {
      console.info(`${donor.file.name}: ${wanted.size} parts to match against one, `
        + 'so its materials were left where they were');
      return null;
    }

    const slotOf = new Map();
    extraMaterials = extraMaterials.slice(0, extraCount);
    const base = builtPieces.palette.length;
    const next = [];
    let dressed = 0;
    for (const segment of currentSegments()) {
      const part = partTable.find((entry) => entry.segment === segment);
      const found = part ? wanted.get(plainPart(part.name)) : null;
      if (!found) { next.push(segment); continue; }
      if (!slotOf.has(found.name)) {
        slotOf.set(found.name, base + extraMaterials.length);
        extraMaterials.push(found);
      }
      next.push({ ...segment, material: slotOf.get(found.name) });
      dressed++;
    }
    if (!dressed) return null;
    applyEdit({ segments: next, extras: extraMaterials.length }, null);
    return { dressed, materials: slotOf.size, of: currentSegments().length };
  }

  /**
   * Decode whatever the palette on screen wears, and hand it to the viewer.
   *
   * The layer each material samples is part of the palette, so that goes up
   * again after the images are in: the entries were uploaded before there was
   * anything for them to point at.
   */
  async function refreshTextures() {
    const textures = await resolveTextures(currentPalette);
    missingTextures = textures.missing;
    unreadableTextures = textures.unreadable;
    await viewer.setTextures(textures.images);
    await viewer.setFinishTextures(textures.finish);
    await viewer.setBumpTextures(textures.bump);
    await viewer.setDetailTextures(textures.detail);
    await viewer.setGlowTextures(textures.glow);
    viewer.setPalette(currentPalette);
    dom.textureToggle.disabled = textures.images.length === 0
      && textures.finish.length === 0 && textures.bump.length === 0
      && textures.detail.length === 0 && textures.glow.length === 0;
    return textures;
  }

  /**
   * Put the donor's materials on, once there is a scene to put them on, and
   * say what came from where.
   *
   * Which file was opened and which was read for its materials is not a
   * detail: the scene on screen is two files, and an export of it is neither
   * of them. Saying so is the difference between a merge and a mystery.
   */
  async function dressFromDonor() {
    const donor = pendingDonor;
    pendingDonor = null;
    if (!donor || !currentDoc) return;
    setStatus(`Reading materials from ${donor.file.name}…`);
    await nextFrame();
    let put = null;
    try {
      put = applyDonor(donor);
      // An edit normally introduces no image — a material added by hand is a
      // plain colour — so rebuilding the scene does not go looking for one.
      // These arrive wearing the donor's, which have never been decoded.
      if (put) await refreshTextures();
    } catch (error) {
      console.error(error);
    }
    const opened = `${currentDoc.fileName} for its geometry`;
    if (!put) {
      setStatus(`Opened ${opened}. Nothing in ${donor.file.name} answered to the `
        + 'same part names, so its materials were left where they were.', 'warn');
      return;
    }
    // The textures the donor names are files like any other, and are looked
    // for the same way, so a folder that holds them has already supplied them.
    setStatus(`Opened ${opened}, wearing ${put.materials} material(s) from `
      + `${donor.file.name} on ${put.dressed} of ${put.of} parts — `
      + 'Ctrl+Z puts the file\'s own back.', 'ok');
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
    // What the last file asked for is nothing to do with the next one, and
    // neither is how far it was smoothed: leaving the level set meant the next
    // file never chose its own, since choosing one is skipped when there is
    // already a level to keep.
    heldBackSmoothing = 0;
    if (!modeChosen) {
      subdivisionLevel = 0;
      if (dom.subdivSelect) dom.subdivSelect.value = '0';
    }
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
    flips = [false, false, false];
    objectIndex = emptyIndex();
    missingTextures = [];
    unreadableTextures = [];

    dom.panel.innerHTML = placeholders.report;
    dom.tree.innerHTML = placeholders.records;
    dom.materials.innerHTML = placeholders.materials;
    dom.materialsStatus.textContent = 'Nothing loaded yet';
    dom.materialsSave.disabled = true;
    dom.materialsClear.disabled = true;
    dom.exportGltf.disabled = true;
    dom.geometrySelect.innerHTML = '';
    dom.geometrySelect.disabled = true;
    dom.skinSelect.innerHTML = '';
    dom.skinSelect.hidden = true;
    skinsOffered = [];
    wearing = null;
    dom.explodeSlider.value = '0';
    dom.explodeSlider.disabled = true;
    dom.meshInfo.textContent = 'no file loaded';
    if (viewer) {
      viewer.clear();
      viewer.setHighlight(-1);
      applyFlips();
      heading = 0;
      applyHeading();
    }
  }

  /**
   * One file as a document, whichever format it turns out to be.
   *
   * Nothing here touches what is on screen, so a second file can be read to
   * see what it holds without disturbing the one that is open.
   */
  async function parseModel(file) {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const started = performance.now();

    let doc = null;
    if (FbxKn5.looksLikeKn5(buffer)) {
      // Six bytes at the head say so, and nothing else here begins "sc6969".
      doc = FbxKn5.parse(buffer);
    } else if (FbxMax.looksLikeMax(buffer)) {
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
      if (FbxAscii.looksLikeAscii(text)) doc = FbxAscii.parse(text);
      // Asked before OBJ, which is the looser test of the two: a COLLADA
      // document is XML and says so in its root element, while an OBJ is
      // recognised by the statements it happens to open with.
      else if (FbxDae.looksLikeDae(text)) doc = FbxDae.parse(text, { materials: suppliedDressing });
      else if (FbxObj.looksLikeObj(text)) {
        doc = FbxObj.parse(text, { materials: suppliedMaterials });
      } else return null;
    } else if (doc.format !== 'blend' && doc.format !== 'gltf' && doc.format !== 'kn5'
        && doc.format !== 'dae') {
      doc.versionSource = 'header';
    }
    doc.fileName = file.name;
    doc.fileSize = file.size;
    doc.parseMilliseconds = performance.now() - started;
    return doc;
  }

  async function loadFile(file, { donor = null } = {}) {
    setStatus(`Reading ${file.name}…`);
    clearDocument();
    try {
      const doc = await parseModel(file);
      if (!doc) {
        setStatus(`${file.name} is not a model we recognise — not FBX `
          + '(binary or ASCII), OBJ, glTF, .blend, .max or .kn5.', 'error');
        return;
      }
      pendingDonor = donor;
      lastSceneFile = file;
      currentDoc = doc;
      /* How many of the car's lamps its own lighting gives a colour to, which
       * the report says and the model itself does not hold. */
      const lit = countLenses(doc);
      if (lit) doc.extra = Object.assign({}, doc.extra, { lenses: lit });
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
      flips = recallFlips(doc.fileName);
      applyFlips();
      // Before the mesh is framed, so the first view is the remembered one.
      heading = recallHeading(doc.fileName);
      applyHeading();
      objectIndex = buildObjectIndex(currentAnalysis.objects);

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
      await populateSkins(doc);
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
  /**
   * How many of a car's lamps the lighting beside it gives a colour to.
   *
   * The count the Python reader states, which counts by lens name rather than
   * by record — a lamp is often a mesh inside a node of the same name, and it
   * is one lens either way.
   */
  function countLenses(doc) {
    if (!doc || doc.format !== 'kn5' || !lensColours.size) return 0;
    const objects = FbxAnalyze.child(doc.root, 'Objects');
    const named = new Set((objects ? objects.children : [])
      .filter((entry) => entry.name === 'Model')
      .map((entry) => String(entry.props[1].value).split('\u0000')[0].toLowerCase()));
    let found = 0;
    for (const mesh of lensColours.keys()) if (named.has(mesh)) found += 1;
    return found;
  }

  function collectParts(analysis, index) {
    const info = analysis || currentAnalysis;
    if (!info) return [];
    const { keyOf, resolve } = index || objectIndex;

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
    const hidden = hiddenModels(info, { keyOf, resolve });
    return [...parts.values()].filter((part) => !hidden.has(part.key));
  }

  /**
   * The models a file says are not to be drawn, and everything under them.
   *
   * A scene is not only the geometry it holds: it is the geometry it holds
   * *switched on*. An Assetto Corsa car ships with its own spares — a shattered
   * windscreen behind the clear one, a blurred disc inside each wheel, a
   * low-detail cockpit inside the real one — all of them switched off until the
   * game wants them. Drawn anyway, the Mercedes comes out with cracked glass in
   * every window and two cockpits.
   *
   * Visibility descends: a node the file switched off takes what hangs below it
   * with it, which is how the four blurred wheels are turned off by four nodes
   * rather than by the twelve meshes under them.
   */
  function hiddenModels(info, { keyOf, resolve }) {
    const own = new Map();
    for (const obj of info.objects) {
      if (obj.nodeType !== 'Model') continue;
      const key = keyOf(obj);
      if (key === null || own.has(key)) continue;
      const visibility = FbxAnalyze.resolvedProperties(obj, info.templates).Visibility;
      own.set(key, visibility === 0 || visibility === false);
    }
    const parent = new Map();
    for (const conn of info.connections) {
      if (conn.kind !== 'OO') continue;
      const source = resolve(conn.src);
      const target = resolve(conn.dst);
      if (!source || !target || source === target) continue;
      if (source.nodeType !== 'Model' || target.nodeType !== 'Model') continue;
      const key = keyOf(source);
      if (key !== null && !parent.has(key)) parent.set(key, keyOf(target));
    }
    const answered = new Map();
    const walk = (key, depth) => {
      if (key === null || key === undefined || depth > 128) return false;
      if (answered.has(key)) return answered.get(key);
      answered.set(key, false);          // a cycle in a malformed file
      const result = own.get(key) === true
        || walk(parent.has(key) ? parent.get(key) : null, depth + 1);
      answered.set(key, result);
      return result;
    };
    const out = new Set();
    for (const key of own.keys()) if (walk(key, 0)) out.add(key);
    return out;
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
      palette.push(...part.materials.map((m) => materialEntry(m)));

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
      const named = String(part.model.displayName
        || part.geometry.displayName || '');
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
        name: named || 'part',
        materialNames: part.materials.map((material) => material.displayName),
        /* And the colour of the lens this part is, where the car's lighting
         * config says it is one. It belongs to the part and not to the
         * material: a Renault 5's `glass_fog` mesh wears the material its
         * `glass_platelight` mesh wears, and the two are given different
         * colours.
         *
         * Looked up under the name the part is shown under, which is the
         * model's where there is one and the geometry's where there is not.
         * Under the model's alone, a mesh whose name is on its geometry is a
         * mesh the config can never name. */
        lens: lensColours.get(named.toLowerCase()) || null,

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
        // The colour of the lens it is, where the car's lighting says it is one.
        lens: piece.lens || null,
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
   * Offer the car's own lights, where it brought a config that says what they
   * are.
   *
   * The switch is hidden for everything that did not, which is every format
   * but a `.kn5` with an `extension` folder beside it and most of those. It
   * starts off: a car photographed in a showroom has its lamps dark, and
   * turning them on is a thing to ask for rather than to be given.
   *
   * One switch rather than a dashboard. A file says whether each lamp follows
   * the headlights, the brakes, the indicators or a door, and what this
   * offers is the car with its lights on — all of them at once.
   */
  function offerLights() {
    /* Put each lamp on the part that wears it here rather than where the
     * geometry is built: a scene assembled part by part and a single geometry
     * opened on its own arrive at the part table by different roads, and this
     * is where the two meet. The lens is filled in the same pass for the same
     * reason — down the second road it was never being looked up at all. */
    let found = 0;
    for (const part of partTable || []) {
      const named = String(part.name || '').toLowerCase();
      part.lamp = carLamps.get(named) || null;
      if (part.lamp) found += 1;
      if (!part.lens) part.lens = lensColours.get(named) || null;
    }
    const has = found > 0 || carLightSources.length > 0;
    viewer.setParts(partTable);
    dom.lightsLabel.hidden = !has;
    if (!has) dom.lightsToggle.checked = false;
    viewer.setLightSources(carLightSources);
    viewer.setLightsOn(has && dom.lightsToggle.checked);
    return found;
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
    offerLights();
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
      + editNote() + drawNote();
    updateEditControls();
    renderReport();
    // How a part is dressed belongs to the file, the way its colours do.
    persist();
    if (note) setStatus(note, 'ok');
  }

  /**
   * What the viewer could not draw, where it could not.
   *
   * A scene of several million triangles is hundreds of megabytes of vertex
   * buffers — this one is 558 MB, against 106 MB for its largest single part,
   * which is why a card can hold one and not the other. That failure has no
   * other symptom: the model reads, the parts are counted, the status says how
   * many triangles are in it, and the viewport stays empty.
   */
  function drawNote() {
    if (!viewer || !viewer.uploadError) return '';
    const mb = (viewer.uploadBytes / 1048576).toFixed(0);
    return ` · nothing is drawn — ${viewer.uploadError} (${mb} MiB of vertex buffers).`
      + ' Pick one part from the list, or turn the smoothing down.';
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
      emissive: [0, 0, 0],
      alphaMode: null,
      alphaCutoff: null,
      // Nothing in the file to go back to, so its own values stand as that.
      fromFile: {
        name,
        colour: colour.slice(),
        base: colour.slice(),
        specular: [0.04, 0.04, 0.04],
        emissive: [0, 0, 0],
        roughness: 0.4,
        opacity: 1,
        metallic: 0,
        alphaMode: null,
        alphaCutoff: null,
      },
      texture: null,
      textures: {},
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

  /* Which axes are mirrored, remembered the same way and for the same reason:
   * a model that arrives handed the wrong way round arrives that way every
   * time, and the fix should not have to be found again.
   *
   * A mirror is not a view setting. It is written into the export, on the root
   * node's matrix beside the up axis and the units � so what leaves is what is
   * on screen, and nothing downstream has to be told about it. */
  const AXES = ['x', 'y', 'z'];
  let flips = [false, false, false];

  const flipKey = (name) => `fbxtool:flip:${name || 'unnamed'}`;

  function rememberFlips() {
    if (!currentDoc) return;
    try {
      const on = AXES.filter((_, i) => flips[i]).join('');
      if (on) window.localStorage.setItem(flipKey(currentDoc.fileName), on);
      else window.localStorage.removeItem(flipKey(currentDoc.fileName));
    } catch (error) {
      /* Storage can be unavailable; the choice still holds for the session. */
    }
  }

  function recallFlips(fileName) {
    try {
      const saved = window.localStorage.getItem(flipKey(fileName)) || '';
      return AXES.map((axis) => saved.includes(axis));
    } catch (error) {
      return [false, false, false];
    }
  }

  /* Which way round a model is looked at, remembered per file for the third
   * time and the same reason: nothing in the file says which end is the front,
   * so a car laid out across the format's idea of forward opens showing its
   * back, and it will do so again tomorrow.
   *
   * Unlike a mirror this is not written into the export. Turning the camera
   * round leaves the model exactly where the file put it. */
  let heading = 0;

  const headingKey = (name) => `fbxtool:heading:${name || 'unnamed'}`;

  function rememberHeading() {
    if (!currentDoc) return;
    try {
      if (heading) window.localStorage.setItem(headingKey(currentDoc.fileName), String(heading));
      else window.localStorage.removeItem(headingKey(currentDoc.fileName));
    } catch (error) {
      /* Storage can be unavailable; the choice still holds for the session. */
    }
  }

  function recallHeading(fileName) {
    try {
      const saved = Number(window.localStorage.getItem(headingKey(fileName)));
      return Number.isInteger(saved) && saved > 0 && saved < 4 ? saved : 0;
    } catch (error) {
      return 0;
    }
  }

  /** Put the heading on the camera and on the button that says so. */
  function applyHeading() {
    viewer.setHeading(heading);
    if (dom.turnButton) dom.turnButton.setAttribute('aria-pressed', heading ? 'true' : 'false');
  }

  /** Put the mirrors on the model and on the buttons that say so. */
  function applyFlips() {
    viewer.setFlips(flips);
    dom.flipButtons.forEach((button, axis) => {
      if (button) button.setAttribute('aria-pressed', flips[axis] ? 'true' : 'false');
    });
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
    if (!(subdivisionLevel > 0 && mesh && mesh.triangleCount)) {
      return heldBackSmoothing
        ? ` · not smoothed — the file asks for ×${heldBackSmoothing}, which is more`
          + ' than is worth drawing unasked; turn it up if your card can take it' : '';
    }
    return ` · smoothed ×${subdivisionLevel}`
      + (heldBackSmoothing ? ` of the ×${heldBackSmoothing} the file asks —`
        + ' turn it up if your card can take it' : '')
      + (unsmoothedParts ? ` · ${unsmoothedParts} too large to smooth` : '');
  }

  /**
   * What became of the maps that did not arrive, in the words that fit.
   *
   * A file nobody supplied is answered by supplying it, and saying so is
   * useful.  A file that is sitting in the folder and will not decode is a
   * different thing, and telling someone to drop in what they have already
   * dropped in reads as the tool not knowing what it has been given.
   */
  function textureNote(textures) {
    let text = '';
    if (textures.missing.length) {
      text += ` · missing: ${textures.missing.join(', ')}`
        + ' — drop the folder in, or use Open folder';
    }
    if ((textures.unreadable || []).length) {
      text += ` · supplied but unreadable: ${textures.unreadable.join(', ')}`
        + ' — save as PNG or JPEG';
    }
    return text;
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
    // The skin's paint under the user's own edits and over the file's: a car
    // wears what it was given until somebody says otherwise.
    paintFromSkin(palette);
    finishFromConfig(palette);
    // Settings first, grouping second: a renamed material has to be grouped
    // and sorted under the name it now goes by.
    FbxPalette.apply(palette, materialOverrides);
    slotTriangles = trianglesPerSlot(mesh, palette.length);
    materialGroups = FbxPalette.groups(palette, slotTriangles);
    viewer.setPalette(palette);
    renderMaterials();
  }

  /**
   * Put the colour a skin states on the material it names.
   *
   * A skin's `cm_skin.json` gives the paint as `#AARRGGBB` and its
   * `ext_config.ini` says which of the car's materials that paint is —
   * `booody_aooo` on an Audi S8, which is the name somebody typed once and
   * the game has used ever since. Both are the skin's own, so a car and the
   * folder it came in are enough; nothing here needs the game installed.
   *
   * A skin that says its paint is off keeps the colour in its texture instead,
   * and one whose config was copied from another car names a material this one
   * has not got. Neither is painted over — they still bring their pictures.
   */
  function paintFromSkin(palette) {
    const paints = new Map(((wearing && wearing.paints) || [])
      .map((paint) => [paint.material, paint]));
    for (const entry of palette) {
      const file = entry.fromFile;
      if (!file) continue;
      // What the car was before any skin went on, so taking one off puts it
      // back rather than leaving the last one's colour behind.
      if (!entry.unpainted) {
        entry.unpainted = { colour: file.colour.slice(), base: file.base.slice(),
          tint: entry.tintTexture === true };
      }
      const paint = paints.get(file.name);
      if (paint) {
        /* The paint goes on over what the material already was, rather than
         * in place of it. A car's body states how much of the light it takes
         * the same as every other material does — an Audi's is 0.4 and 0.4,
         * three-quarters of a plainly lit surface — and a skin says what
         * colour it is, not how bright. Taken as a replacement, painting a
         * car white makes it brighter than the car it was painted on. */
        const weight = entry.unpainted.colour;
        /* And at the brightness the file states for it, which is part of the
         * colour rather than a finish on top of it. A Jaguar C-X75's Silver
         * states `#FFFFFF` and 0.66, and the two together are what silver is;
         * the white alone is a different car. */
        const scale = typeof paint.scale === 'number' ? paint.scale : 1;
        const colour = FbxPalette.fromHex(paint.hex)
          .map((c, at) => c * scale * (weight[at] === undefined ? 1 : weight[at]));
        file.colour = colour.slice();
        file.base = colour.slice();
        /* And it tints the texture rather than replacing it.
         *
         * The map under a car's paint is the panels in white on black — an
         * Audi's `Skin_00.dds` is exactly that — because the colour is what
         * the game multiplies through it. Replaced by the colour the shut
         * lines and the badge go with it; replaced by the map the car is
         * white whichever skin is on. */
        entry.tintTexture = true;
      } else {
        file.colour = entry.unpainted.colour.slice();
        file.base = entry.unpainted.base.slice();
        // Back to whichever way round the file itself said, which for a
        // game's material is through the picture either way.
        entry.tintTexture = entry.unpainted.tint;
      }
    }
  }

  /**
   * Put what the car's config says its surfaces are made of on them.
   *
   * `Reflectance`, `Smoothness` and `Metalness` are the three numbers this
   * viewer already has a slot for, and on a Custom Shaders Patch car they are
   * where the material lives. What the `.kn5` carries is the same surface as
   * it was before the author moved the description out to `[Material_Metal]`
   * and the rest — so read from the model alone a car is read as the car it
   * used to be, and the chrome it was given comes back as plastic.
   *
   * The skin's own config over the car's, the same way a paint is, and the
   * whole thing undone from `unfinished` each time so that taking a skin off
   * puts back what was underneath rather than leaving the last one's.
   *
   * A metalness has to be split into the two halves the shader shades with,
   * since a metal has no diffuse of its own and reflects its own colour. That
   * is the same arithmetic the Materials tab does when the metalness is set by
   * hand, and it runs after the paint so that a painted body is split on the
   * colour it was painted.
   */
  function finishFromConfig(palette) {
    const skin = (wearing && wearing.finish) || new Map();
    for (const entry of palette) {
      const file = entry.fromFile;
      if (!file) continue;
      if (!entry.unfinished) {
        entry.unfinished = { roughness: file.roughness, metallic: file.metallic || 0,
          specular: file.specular.slice() };
      }
      const named = String(file.name || '').toLowerCase();
      const said = { ...(carMaterialFinish.get(named) || {}), ...(skin.get(named) || {}) };
      file.roughness = typeof said.smoothness === 'number'
        ? Math.min(1, Math.max(0.05, 1 - said.smoothness)) : entry.unfinished.roughness;
      if (typeof said.reflectance !== 'number' && typeof said.metalness !== 'number') {
        file.specular = entry.unfinished.specular.slice();
        file.metallic = entry.unfinished.metallic;
        continue;
      }
      const metal = typeof said.metalness === 'number'
        ? said.metalness : entry.unfinished.metallic;
      // A dielectric reflects four per cent facing you unless the file says
      // otherwise, which is the same floor every other reader here works to.
      const facing = typeof said.reflectance === 'number' ? said.reflectance : 0.04;
      const base = (file.base || file.colour).slice();
      file.colour = base.map((c) => c * (1 - metal));
      file.specular = base.map((c) => facing * (1 - metal) + c * metal);
      file.metallic = metal;
    }
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
    // Whichever rows were open stay open, as long as this is the same list
    // being drawn again: the markup is rebuilt from scratch for anything a
    // patch in place cannot cover, and a row folding itself away under the
    // hand that was working in it is its own small betrayal. A new file gets a
    // new list of groups, and that one opens closed.
    const open = materialGroups === renderedGroups
      ? new Set([...dom.materials.querySelectorAll('.material[open]')]
        .map((row) => row.dataset.key))
      : new Set();
    renderedGroups = materialGroups;
    dom.materials.innerHTML = FbxPalette.render(materialGroups, materialOverrides,
      { supplied: new Set(suppliedImages.keys()) });
    if (open.size) {
      dom.materials.querySelectorAll('.material').forEach((row) => {
        if (open.has(row.dataset.key)) row.open = true;
      });
    }
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

  //: One context for reading pixels back, made when something first needs it.
  let readback = null;

  /**
   * The pixels of a decoded image, with the colour still on them.
   *
   * There is no way to ask a 2D canvas for these. It holds what it is given
   * premultiplied, so a texel at zero alpha comes back black however it was
   * put in — and a `.dds` out of Assetto Corsa routinely carries an alpha
   * channel of nothing beside a picture that matters. The upload path has
   * avoided the canvas for a while; the export was still going through one,
   * and a Renault 5's rubber, carpet, brass and interior panels came out of it
   * as squares of black.
   *
   * A GL texture keeps the two apart when it is told to, and reading it back
   * through a framebuffer gives the image as it was decoded. Row zero is the
   * top of the picture, which is the order a PNG is written in: the source is
   * not turned over on the way in, so it does not have to be turned back.
   */
  function pixelsOf(image) {
    const width = image && image.width;
    const height = image && image.height;
    if (!width || !height) return null;
    if (readback === null) {
      const canvas = document.createElement('canvas');
      readback = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: false })
        || false;
    }
    const gl = readback;
    if (!gl) return null;
    if (width > gl.getParameter(gl.MAX_TEXTURE_SIZE)
      || height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return null;
    const texture = gl.createTexture();
    const frame = gl.createFramebuffer();
    try {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null;
      const out = new Uint8ClampedArray(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return gl.getError() === gl.NO_ERROR ? out : null;
    } catch (error) {
      return null;
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(frame);
      gl.deleteTexture(texture);
    }
  }

  /** An image as PNG bytes, and whether any of it is see-through. */
  async function encodePng(image) {
    if (!image) return null;
    const pixels = pixelsOf(image);
    if (pixels) {
      const written = await FbxPng.encode(pixels, image.width, image.height);
      if (written) return { bytes: written, hasAlpha: anyAlpha(pixels) };
    }
    /* Failing that, the canvas after all.
     *
     * Somewhere with no WebGL2 and no `CompressionStream` is somewhere the
     * viewer barely runs, and a picture whose empty texels are black beats no
     * picture at all — but it is the second answer and not the first. */
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    // A canvas always encodes RGBA, so the header alone would call every one
    // of these transparent. The pixels themselves settle it.
    const drawn = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob
      ? { bytes: new Uint8Array(await blob.arrayBuffer()), hasAlpha: anyAlpha(drawn) } : null;
  }

  /** Whether any texel of an RGBA run is less than solid. */
  function anyAlpha(pixels) {
    for (let at = 3; at < pixels.length; at += 4) if (pixels[at] !== 255) return true;
    return false;
  }

  /**
   * A height map turned into the tangent-space normal map it stands for.
   *
   * A surface raised by a height `h` has the normal `(-dh/du, -dh/dv, 1)`
   * normalised, which is one central difference per axis and no more. Both are
   * "the texel before minus the texel after", `v` running down the image as
   * glTF has it — so a ramp getting brighter to the right leaves red below the
   * middle, and one getting brighter downwards leaves green below it.
   *
   * The differences and the strength are the viewer's own, so the file that
   * comes out is shaded the way the screen shaded it rather than merely
   * plausibly. The edges wrap, which is right for a tiling map and invisible
   * on one that does not tile.
   */
  async function encodeNormals(image, strength) {
    if (!image) return null;
    const width = image.width;
    const height = image.height;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    // Read the same way the colour is — a height map under an empty alpha is
    // flat black through a canvas, and a flat height map is no relief at all.
    let read = pixelsOf(image);
    if (!read) {
      context.drawImage(image, 0, 0);
      read = context.getImageData(0, 0, width, height).data;
    }
    const source = { data: read };
    const out = context.createImageData(width, height);
    // The red channel is the height: a bump map is grey, and where it is not,
    // red is the channel every convention agrees on.
    const heightAt = (x, y) => source.data[
      (((y + height) % height) * width + ((x + width) % width)) * 4] / 255;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const du = (heightAt(x - 1, y) - heightAt(x + 1, y)) * strength;
        const dv = (heightAt(x, y - 1) - heightAt(x, y + 1)) * strength;
        const length = Math.hypot(du, dv, 1);
        const at = (y * width + x) * 4;
        out.data[at] = Math.round(((du / length) * 0.5 + 0.5) * 255);
        out.data[at + 1] = Math.round(((dv / length) * 0.5 + 0.5) * 255);
        out.data[at + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
        out.data[at + 3] = 255;
      }
    }
    context.putImageData(out, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), hasAlpha: false } : null;
  }

  /**
   * Whether an image carries transparency of its own.
   *
   * A JPEG has no alpha channel at all. A PNG says so in its header — colour
   * types 4 and 6 carry one — or through a tRNS chunk, which is how a palette
   * or a greyscale image names the colour it leaves out.
   */
  function imageHasAlpha(bytes, mimeType) {
    if (mimeType !== 'image/png' || bytes.length < 26) return false;
    const colourType = bytes[25];
    if (colourType === 4 || colourType === 6) return true;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    while (at + 8 <= bytes.length) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
      if (type === 'tRNS') return true;
      if (type === 'IDAT' || type === 'IEND') return false;
      at += 12 + length;
    }
    return false;
  }

  /* sRGB both ways, as tables. A 2048-pixel bake is four million texels and
   * three transfers each, and the curve is a `pow`: read from a table it is a
   * second's work rather than a minute's. The way back is quantised to a
   * sixteen-bit step, which lands within a twentieth of the byte it writes. */
  let srgbTables = null;

  function srgb() {
    if (srgbTables) return srgbTables;
    const linear = new Float32Array(256);
    for (let i = 0; i < 256; i++) linear[i] = FbxPalette.fromSrgb(i / 255);
    const encoded = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) {
      encoded[i] = Math.round(FbxPalette.toSrgb(i / 65535) * 255);
    }
    srgbTables = { linear, encoded };
    return srgbTables;
  }

  /**
   * A grain resolved down to the size one tile of it will occupy.
   *
   * A grain 512 pixels square tiled twenty-five times across a 2048-pixel paint
   * map has eighty-two pixels to say itself in. Point-sampled it comes out as
   * noise — five texels in six thrown away — where on screen the card would
   * have averaged the ones it skipped. So they are averaged here, which is the
   * same answer by the same means, and a grain finer than the room left for it
   * arrives as what it averages rather than as speckle.
   *
   * In linear light, because that is where the multiply happens.
   */
  function resolveGrain(pixels, width, height, wide, tall) {
    const { linear } = srgb();
    // Four channels rather than three: this is uploaded to a card as it is,
    // and a fourth channel is what spares it a repacking on the way.
    const out = new Float32Array(wide * tall * 4);
    const counts = new Float32Array(wide * tall);
    for (let y = 0; y < height; y++) {
      const row = Math.min(tall - 1, Math.floor(y * tall / height)) * wide;
      for (let x = 0; x < width; x++) {
        const at = (x + y * width) * 4;
        const cell = row + Math.min(wide - 1, Math.floor(x * wide / width));
        for (let k = 0; k < 3; k++) out[cell * 4 + k] += linear[pixels[at + k]];
        counts[cell] += 1;
      }
    }
    for (let cell = 0; cell < counts.length; cell++) {
      const many = counts[cell] || 1;
      for (let k = 0; k < 3; k++) out[cell * 4 + k] /= many;
      out[cell * 4 + 3] = 1;
    }
    return out;
  }

  /* The multiply itself, on the card that was going to draw it anyway.
   *
   * Written as a fragment shader because that is what it is: one output texel
   * per fragment, reading one texel of the picture and one of the grain. Done
   * in JS it is the slowest thing in an export — two seconds of an Audi's five
   * and a half, four of a Renault's eight — and it is the one part of the work
   * a card does without being asked twice.
   *
   * The light comes out right for free here. Both pictures are uploaded as
   * `SRGB8_ALPHA8`, so the sampler decodes them; the target is `SRGB8_ALPHA8`
   * too, so the write encodes the answer back. Which is the same arrangement
   * the viewer draws under, and the reason this agrees with the screen.
   */
  const BAKE_VERTEX = `#version 300 es
    void main() {
      /* One triangle covering the target, from the vertex number alone: there
       * is nothing to send and nothing to bind. */
      vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
    }`;

  const BAKE_FRAGMENT = `#version 300 es
    precision highp float;
    uniform highp sampler2D uPicture;
    uniform highp sampler2D uTile;
    uniform vec2 uOut;
    uniform vec2 uPictureSize;
    uniform vec2 uTileSize;
    uniform float uRepeats;
    uniform float uStrength;
    out vec4 colour;
    void main() {
      /* Both texels chosen by the same arithmetic the fallback uses, so the
       * two paths write the same file. A fetch rather than a sample: the
       * picture is resized by which texel is asked for, and the grain has
       * already been resolved to the size one tile of it has room for. */
      ivec2 at = ivec2(gl_FragCoord.xy);
      ivec2 from = ivec2(vec2(at) * uPictureSize / uOut);
      vec4 base = texelFetch(uPicture,
        min(from, ivec2(uPictureSize) - 1), 0);
      vec2 tiled = (vec2(at) + 0.5) / uOut * uRepeats;
      ivec2 cell = ivec2(fract(tiled) * uTileSize);
      vec3 grain = texelFetch(uTile, min(cell, ivec2(uTileSize) - 1), 0).rgb;
      colour = vec4(base.rgb * min(vec3(4.0), grain * uStrength), base.a);
    }`;

  //: The context the bake runs in, and what it needs bound. Made once.
  let baker = null;

  function bakeContext() {
    if (baker !== null) return baker;
    baker = false;
    const gl = document.createElement('canvas')
      .getContext('webgl2', { alpha: true, premultipliedAlpha: false });
    if (!gl) return baker;
    const compile = (kind, source) => {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
    };
    const vertex = compile(gl.VERTEX_SHADER, BAKE_VERTEX);
    const fragment = compile(gl.FRAGMENT_SHADER, BAKE_FRAGMENT);
    if (!vertex || !fragment) return baker;
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return baker;
    const at = (name) => gl.getUniformLocation(program, name);
    baker = {
      gl,
      program,
      vao: gl.createVertexArray(),
      uniforms: {
        picture: at('uPicture'), tile: at('uTile'), out: at('uOut'),
        pictureSize: at('uPictureSize'), tileSize: at('uTileSize'),
        repeats: at('uRepeats'), strength: at('uStrength'),
      },
    };
    return baker;
  }

  /**
   * The picture and its grain multiplied together on the card.
   *
   * Hands back the same bytes the fallback below would, or nothing at all if
   * anything about the card says no — a context that will not be made, a
   * picture past what it will hold, a framebuffer it will not complete. There
   * is no half-done state to unpick: the answer is read back or it is not.
   */
  function bakeOnCard(picture, tile, wide, tall, width, height, repeats, strength) {
    const made = bakeContext();
    if (!made) return null;
    const { gl, program, uniforms } = made;
    const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (Math.max(width, height, picture.width, picture.height, wide, tall) > limit) {
      return null;
    }
    const pictureTexture = gl.createTexture();
    const tileTexture = gl.createTexture();
    const target = gl.createTexture();
    const frame = gl.createFramebuffer();
    try {
      gl.bindTexture(gl.TEXTURE_2D, pictureTexture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      // Decoded by the sampler, which is where the light gets sorted out.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, picture.width, picture.height,
        0, gl.RGBA, gl.UNSIGNED_BYTE, picture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // The grain already resolved and already linear, so it goes up as it is.
      gl.bindTexture(gl.TEXTURE_2D, tileTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, wide, tall, 0,
        gl.RGBA, gl.FLOAT, tile);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.bindTexture(gl.TEXTURE_2D, target);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, width, height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, target, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        return null;
      }

      gl.useProgram(program);
      gl.bindVertexArray(made.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, pictureTexture);
      gl.uniform1i(uniforms.picture, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, tileTexture);
      gl.uniform1i(uniforms.tile, 1);
      gl.uniform2f(uniforms.out, width, height);
      gl.uniform2f(uniforms.pictureSize, picture.width, picture.height);
      gl.uniform2f(uniforms.tileSize, wide, tall);
      gl.uniform1f(uniforms.repeats, repeats);
      gl.uniform1f(uniforms.strength, strength);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      gl.viewport(0, 0, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const out = new Uint8ClampedArray(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return gl.getError() === gl.NO_ERROR ? out : null;
    } catch (error) {
      return null;                       // a card that will not: the loop will
    } finally {
      gl.bindVertexArray(null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.deleteTexture(pictureTexture);
      gl.deleteTexture(tileTexture);
      gl.deleteTexture(target);
      gl.deleteFramebuffer(frame);
    }
  }

  /** The same multiply where there is no card to do it: texel by texel. */
  function bakeInJs(base, picture, tile, wide, tall, width, height, repeats, strength) {
    const { linear, encoded } = srgb();
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const from = Math.min(picture.height - 1,
        Math.floor(y * picture.height / height)) * picture.width;
      /* Where in its own tile the grain has got to. Both pictures are read the
       * same way up, so this is the shader's `vUv * tiling` said in rows and
       * columns, and no flip enters into it. */
      const gv = (y + 0.5) / height * repeats;
      const row = Math.min(tall - 1, Math.floor((gv - Math.floor(gv)) * tall)) * wide;
      for (let x = 0; x < width; x++) {
        const at = (from + Math.min(picture.width - 1,
          Math.floor(x * picture.width / width))) * 4;
        const gu = (x + 0.5) / width * repeats;
        const cell = (row + Math.min(wide - 1,
          Math.floor((gu - Math.floor(gu)) * wide))) * 4;
        const to = (x + y * width) * 4;
        for (let k = 0; k < 3; k++) {
          const lit = linear[base[at + k]] * Math.min(4, tile[cell + k] * strength);
          out[to + k] = encoded[lit >= 1 ? 65535 : (lit * 65535) | 0];
        }
        out[to + 3] = base[at + 3];
      }
    }
    return out;
  }

  /**
   * The grain a surface is tiled over with, multiplied into its own picture.
   *
   * A game's material wears two: the picture that says where the panels are,
   * and a grain tiled twenty-five or a hundred times across it that says what
   * the surface feels like. Neither glTF nor FBX has a second set of
   * coordinates to tile a map by, so an export carrying only the first is a car
   * whose leather, carpet and carbon have all come out flat — and baked in is
   * the only way the second travels at all.
   *
   * The two are multiplied here exactly as the shader multiplies them, and in
   * the same light: both pictures speak sRGB, the card decodes both before it
   * multiplies, and the grain is taken as neutral at its own average — which is
   * what `scale` is, and why a paint whose grain averages 0.24 does not turn a
   * white car graphite.
   *
   * What is lost is the tiling, and it cannot be otherwise: having its own
   * repeat is the whole reason a grain was allowed to be small. So the bake is
   * done at whichever picture is larger, and one tile of the grain gets the
   * room that leaves it.
   *
   * Nothing is handed back where nothing needed doing — a grain with no room
   * left to say anything in, which is what a tiling in the thousands comes to
   * — and the caller writes the picture it already had.
   */
  async function bakeGrain(picture, grain, tiling, scale) {
    const over = pixelsOf(grain);
    if (!over) return null;
    const width = Math.min(BAKE_LIMIT, Math.max(picture.width, grain.width));
    const height = Math.min(BAKE_LIMIT, Math.max(picture.height, grain.height));
    const repeats = Math.max(tiling, 1e-4);
    // One tile of the grain, at the size it has room for and no larger.
    const wide = Math.max(1, Math.min(grain.width, Math.round(width / repeats)));
    const tall = Math.max(1, Math.min(grain.height, Math.round(height / repeats)));
    const tile = resolveGrain(over, grain.width, grain.height, wide, tall);
    /* Held between the same two ends the viewer holds it between, and read
     * from there rather than repeated here, since what is being written out is
     * what is on screen. An Audi S8's paint wears a grain averaging a tenth,
     * which asks for ten and gets eight. */
    const strength = Math.min(FbxViewer.GRAIN_CEILING,
      Math.max(FbxViewer.GRAIN_FLOOR, scale));
    /* A grain that resolved to one texel of its own average is no grain: every
     * output texel would be multiplied by the same number, and that number is
     * one, because dividing a thing by its own average is what `strength` is.
     * Cars tile grains up to 250,000 times across a panel, so this is not a
     * corner — it is most of what a tiling that high means. The picture goes
     * out as it already was, encoded once, rather than being copied. */
    if (wide === 1 && tall === 1 && flatEnough(tile, strength)) return null;
    let out = bakeOnCard(picture, tile, wide, tall, width, height, repeats, strength);
    if (!out) {
      const base = pixelsOf(picture);
      if (!base) return null;
      out = bakeInJs(base, picture, tile, wide, tall, width, height, repeats, strength);
    }
    const bytes = await FbxPng.encode(out, width, height);
    return bytes ? { bytes, hasAlpha: anyAlpha(out) } : null;
  }

  /**
   * The same bake done both ways, for holding the two against each other.
   *
   * A card and a loop are two implementations of one multiply, and the file
   * that leaves depends on which of them ran. So the loaded car's grained
   * materials are baked twice here and the answers compared texel by texel —
   * the shape of check the rest of this tool applies to its pairs of readers,
   * pointed at the one pair that is chosen by what the machine happens to
   * have.
   *
   * They differ where the sRGB curve is quantised on the way out, and by no
   * more than that: the card walks the real curve, the loop reads a table of
   * sixteen-bit steps. Anything past a step of eight bits is a disagreement.
   */
  async function bakeBothWays(limit = 4) {
    const out = [];
    for (const entry of currentPalette || []) {
      if (out.length >= limit) break;
      const request = entry.textures && entry.textures.detail;
      if (!request || !entry.texture || !(entry.detailTiling > 0)) continue;
      const picture = await decodeTexture(entry.texture, suppliedImages);
      const grain = await decodeTexture(request, suppliedImages);
      const over = picture && grain && pixelsOf(grain);
      const base = over && pixelsOf(picture);
      if (!base) continue;
      const width = Math.min(BAKE_LIMIT, Math.max(picture.width, grain.width));
      const height = Math.min(BAKE_LIMIT, Math.max(picture.height, grain.height));
      const repeats = Math.max(entry.detailTiling, 1e-4);
      const wide = Math.max(1, Math.min(grain.width, Math.round(width / repeats)));
      const tall = Math.max(1, Math.min(grain.height, Math.round(height / repeats)));
      const tile = resolveGrain(over, grain.width, grain.height, wide, tall);
      const strength = Math.min(FbxViewer.GRAIN_CEILING, Math.max(
        FbxViewer.GRAIN_FLOOR,
        typeof entry.detailScale === 'number' ? entry.detailScale : 1));
      const card = bakeOnCard(picture, tile, wide, tall, width, height, repeats, strength);
      if (!card) { out.push({ name: entry.name, card: false }); continue; }
      const loop = bakeInJs(base, picture, tile, wide, tall, width, height,
        repeats, strength);
      let worst = 0;
      let total = 0;
      for (let at = 0; at < loop.length; at++) {
        const gap = Math.abs(card[at] - loop[at]);
        if (gap > worst) worst = gap;
        total += gap;
      }
      out.push({
        name: entry.name, card: true, width, height, tile: `${wide}x${tall}`,
        worst, mean: +(total / loop.length).toFixed(3),
      });
    }
    return out;
  }

  /**
   * Whether a grain resolved to a single texel changes anything at all.
   *
   * Within half a step of eight bits at the brightest a picture goes, which is
   * where a factor shows first. A grain resolved to one texel is *usually*
   * exactly neutral — its one texel is its own average and `strength` is one
   * over that — but a grain whose average was clamped at either end is not,
   * and that one has to be drawn.
   */
  function flatEnough(tile, strength) {
    for (let k = 0; k < 3; k++) {
      if (Math.abs(Math.min(4, tile[k] * strength) - 1) > 1 / 512) return false;
    }
    return true;
  }

  /**
   * Each material's images, ready for a glTF.
   *
   * glTF takes PNG and JPEG and nothing else, so bytes already in one of those
   * are passed through untouched. Anything else — a KTX2 this tool decoded
   * itself, most often — is drawn once and encoded as a PNG, which is the
   * difference between exporting the model and exporting it with its
   * textures.
   *
   * The base colour comes back on its own because it is the one this tool
   * shows and edits; everything else comes back as a list of maps to write
   * straight out again. Each source image is read once however many materials
   * wear it, so the same bytes reach the writer as the same array and are
   * stored once.
   */
  async function textureBytes(palette) {
    const images = new Map();
    const textures = new Map();
    const read = new Map();

    //: Which picture a request is for, so two materials wearing the same one
    //: read it once and reach the writer as the same bytes.
    const keyOf = (request) => `${wearing ? wearing.name : ''}:`
      + (request.embedded ? `embedded:${request.name}` : `file:${baseName(request.path)}`);

    /* What the cache holds is the work, not what it came to.
     *
     * The pictures are read at the same time as each other below, so two
     * materials wearing one can ask for it before either answer exists. Held
     * as results, both would miss and the picture would be decoded and encoded
     * twice; held as promises, the second asker waits on the first's. */
    const once = (key, work) => {
      if (!read.has(key)) read.set(key, work());
      return read.get(key);
    };

    const bytesFor = (request) => once(keyOf(request), async () => {
      /* The skin's own picture first, where it has one for this texture.
       *
       * A picture already in a format glTF allows is written straight across
       * below, without being decoded — so taken from the file rather than from
       * the skin, a car exports wearing whichever of its textures the skin
       * happened not to replace. Every `.dds` goes the long way round and
       * picks the skin up there; a `.png` or a `.jpg` would not. */
      const worn = wearing && wearing.images.get(baseName(request.path || request.name));
      let bytes = worn ? new Uint8Array(await worn.arrayBuffer()) : request.embedded;
      if (!bytes) {
        const file = suppliedImages.get(baseName(request.path));
        if (file) bytes = new Uint8Array(await file.arrayBuffer());
      }
      let image = null;
      const mimeType = bytes && imageType(bytes);
      if (mimeType) {
        image = { bytes, mimeType, hasAlpha: imageHasAlpha(bytes, mimeType) };
      } else {
        const encoded = await encodePng(await decodeTexture(request, suppliedImages));
        if (encoded) {
          image = { bytes: encoded.bytes, mimeType: 'image/png', hasAlpha: encoded.hasAlpha };
        }
      }
      return image;
    });

    const withWrap = (image, request) => ({
      ...image, wrapS: request.wrapS, wrapT: request.wrapT,
    });

    /**
     * A material's picture with its grain baked into it.
     *
     * Held against the two pictures and the tiling rather than against the
     * material, because that is what the answer depends on: a car's interior
     * is one atlas with one grain over it worn by thirty-eight materials, and
     * a bake per material would write that same picture out thirty-eight
     * times.
     */
    const grainedFor = (entry, request) => {
      const tiling = entry.detailTiling;
      const scale = typeof entry.detailScale === 'number' ? entry.detailScale : 1;
      const key = `grain:${keyOf(entry.texture)}:${keyOf(request)}:${tiling}:${scale}`;
      return once(key, async () => {
        let image = null;
        const picture = await decodeTexture(entry.texture, suppliedImages);
        const grain = await decodeTexture(request, suppliedImages);
        if (picture && grain) {
          const baked = await bakeGrain(picture, grain, tiling, scale);
          if (baked) {
            image = {
              bytes: baked.bytes, mimeType: 'image/png', hasAlpha: baked.hasAlpha,
            };
          }
        }
        /* A grain that will not decode, or one with nothing left to say,
         * leaves the picture as it was — which is the picture without it
         * rather than no picture at all, and is fetched under the picture's
         * own key, so a car whose grains all come to nothing writes each of
         * its pictures once. */
        if (!image) image = await bytesFor(entry.texture);
        return image;
      });
    };

    /** A height map as the normal map glTF's normal slot has to hold. */
    const normalsFor = (request) => once(
      `normal:${request.embedded || baseName(request.path)}`, async () => {
        const encoded = await encodeNormals(
          await decodeTexture(request, suppliedImages), BUMP_RELIEF);
        return encoded
          ? { bytes: encoded.bytes, mimeType: 'image/png', hasAlpha: false } : null;
      });

    /* Which material writes which name, decided here and in order.
     *
     * A name is what everything downstream finds a panel by, and two materials
     * may carry one: the first to state a picture is the one that writes it,
     * which is what reading the list in order came to before this read several
     * at a time. Settled before any of the work starts, so the file does not
     * depend on which picture finished decoding first. */
    const spoken = new Set();
    const mapped = new Set();
    const work = [];
    for (const entry of palette) {
      // An image left out of the palette is left out of the file: that is what
      // dropping it was for.
      const writes = !!(entry.texture && wanted(entry, 'baseColor')
        && !spoken.has(entry.name));
      if (writes) spoken.add(entry.name);
      const maps = !!(entry.textures && !mapped.has(entry.name));
      if (maps) mapped.add(entry.name);
      if (writes || maps) work.push({ entry, writes, maps });
    }

    async function forMaterial({ entry, writes, maps }) {
      /* Whether this material's grain is going into its picture. Neither glTF
       * nor FBX has a slot to tile a second map by, so baked in is the only
       * way it travels — and left out entirely a car's leather, carpet and
       * carbon all arrive flat. */
      const grain = entry.textures && entry.textures.detail;
      const bakes = !!(grain && entry.texture && entry.detailTiling > 0
        && wanted(entry, 'detail') && wanted(entry, 'baseColor'));
      if (writes) {
        const image = bakes ? await grainedFor(entry, grain) : await bytesFor(entry.texture);
        if (image) images.set(entry.name, withWrap(image, entry.texture));
      }
      if (maps) {
        const written = [];
        for (const [slot, request] of Object.entries(entry.textures)) {
          if (!wanted(entry, slot)) continue;
          // A grain already multiplied into the picture is not sent a second
          // time: there is nothing at the far end that would tile it, and sent
          // twice it is only weight.
          if (slot === 'detail' && bakes) continue;
          // glTF's normal texture is a direction, and a height map is not one:
          // written straight out it says every surface faces the way its own
          // brightness points. Turned into the normals it stands for, by the
          // same differences the viewer shades it with, it says what it meant.
          const image = slot === 'normal' && !entry.bumpIsNormalMap
            ? await normalsFor(request) : await bytesFor(request);
          if (image) written.push({ slot, ...withWrap(image, request) });
        }
        if (written.length) textures.set(entry.name, written);
      }
    }

    /* Several at a time, because the slow part is not this thread.
     *
     * Every picture that is not already a PNG or a JPEG goes out through
     * `CompressionStream`, which is the platform deflating on a thread of its
     * own — and awaited one after another, that thread does one picture while
     * nothing else happens. A car has a hundred of them. Bounded rather than
     * let loose: each one in flight is holding a decoded picture and a baked
     * one, and a car whose pictures are 2048 square would otherwise have a
     * hundred of each in the air at once. */
    const AT_ONCE = 6;
    let next = 0;
    await Promise.all(Array.from({ length: AT_ONCE }, async () => {
      while (next < work.length) await forMaterial(work[next++]);
    }));
    return { images, textures };
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
      /* Sized and filled rather than spread into. `push(...faces)` hands every
       * triangle over as an argument of its own, and an argument list of much
       * past a hundred thousand overflows the stack — which is not a limit a
       * car has to be unusual to reach: split one body by material and the
       * paint alone is that, so the export threw where the viewer had just
       * drawn the thing. Typed the whole way, which also sorts numerically
       * without a comparator to say so. */
      let total = 0;
      for (const segment of here) total += segment.faces.length;
      const all = new Int32Array(total);
      let at = 0;
      for (const segment of here) {
        all.set(segment.faces, at);
        at += segment.faces.length;
      }
      return all.sort();
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
        /* The materials as the file has them, with the skin's paint on and the
         * assignments over that — which is the order the screen puts them in.
         *
         * Painted here rather than taken from the palette on screen because
         * this one is per part and that one is per scene, and a skin's colour
         * is the one thing on screen that is not in the file: exported without
         * it, a car wearing Sakhir Orange comes out the grey it was unpainted
         * while its textures come out orange. */
        const fresh = part.materials.map((m) => materialEntry(m));
        paintFromSkin(fresh);
        finishFromConfig(fresh);
        let palette = FbxPalette.apply(fresh, materialOverrides);

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

  /**
   * What the file had and the export does not.
   *
   * Most of what goes missing is meant to: removing a number plate here is
   * better than removing it at runtime. What is not acceptable is that it
   * happens in silence — a material merged away by accident leaves a car that
   * cannot be painted, and a node that loses its name leaves whatever looks
   * that name up with nothing to find. So the export says what it dropped and
   * the removal reads as a list of expected names rather than as nothing.
   */
  /**
   * Maps a material names that the export could not write.
   *
   * This is the one omission that changes what the remaining values mean. A
   * factor is a multiplier over its map: `metallicFactor` with no
   * `metallicRoughnessTexture` beside it asserts a surface the file never
   * claimed, and glTF's default for the factor is 1, so a tyre whose map went
   * missing exports as a mirror — permanently, in a file nothing downstream
   * can correct. Supplying the images and exporting again is the fix, which
   * needs saying rather than leaving to be noticed.
   */
  function unwrittenMaps(images, textures) {
    const out = [];
    const seen = new Set();
    for (const entry of currentPalette) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      const written = new Set([
        ...(images.has(entry.name) ? ['baseColor'] : []),
        ...(textures.get(entry.name) || []).map((map) => map.slot),
      ]);
      const declared = [
        ...(entry.texture ? ['baseColor'] : []),
        ...Object.keys(entry.textures || {}),
      ].filter((slot) => wanted(entry, slot));
      for (const slot of declared) {
        if (!written.has(slot)) out.push(`${entry.name} ${slot}`);
      }
    }
    return out;
  }

  function reportDropped(stats, maps) {
    const info = currentAnalysis;
    if (!info) return null;
    const written = new Set(stats.materialNames);
    const placed = new Set(stats.nodeNames);
    const named = (type) => [...new Set(info.objects
      .filter((o) => o.nodeType === type && o.name)
      .map((o) => o.name))];
    // A renamed material is written under the name it now goes by, so it is
    // not a removal; it is listed separately, since the name is the key the
    // game files paint and colour charts against.
    const materials = named('Material').filter((name) => !written.has(shownMaterial(name)));
    const nodes = named('Model').filter((name) => !placed.has(name));
    const renamed = Object.entries(materialOverrides)
      .filter(([origin, set]) => typeof set.name === 'string' && set.name
        && set.name !== origin && written.has(set.name))
      .map(([origin, set]) => `${origin} → ${set.name}`);
    const dropped = { materials, nodes, renamed, maps: maps || [] };
    if (materials.length || nodes.length || renamed.length || dropped.maps.length) {
      console.info('glTF export:'
        + (materials.length ? `\n  ${materials.length} material(s) dropped: ${materials.join(', ')}` : '')
        + (nodes.length ? `\n  ${nodes.length} node(s) dropped: ${nodes.join(', ')}` : '')
        + (renamed.length ? `\n  ${renamed.length} material(s) renamed: ${renamed.join(', ')}` : '')
        + (dropped.maps.length ? `\n  ${dropped.maps.length} map(s) named but not supplied, so `
          + `the factors beside them now stand alone: ${dropped.maps.join(', ')}` : ''));
    }
    return dropped;
  }

  /** The same, as the one line that goes on the end of the status. */
  function describeDropped(dropped) {
    if (!dropped) return '';
    const some = (names, what) => {
      if (!names.length) return null;
      const shown = names.slice(0, 3).join(', ');
      const more = names.length > 3 ? `, +${names.length - 3}` : '';
      return `${names.length} ${what} (${shown}${more})`;
    };
    const parts = [
      some(dropped.materials, dropped.materials.length === 1 ? 'material' : 'materials'),
      some(dropped.nodes, dropped.nodes.length === 1 ? 'node' : 'nodes'),
    ].filter(Boolean);
    const renamed = dropped.renamed.length
      ? ` · ${dropped.renamed.length} renamed` : '';
    // The one omission worth shouting about: a factor without the map it
    // multiplies asserts a surface the file never claimed.
    const maps = (dropped.maps || []).length
      ? ` · ${dropped.maps.length} map(s) missing — supply the images and export again` : '';
    if (!parts.length) return `${renamed || ' · nothing dropped'}${maps}`;
    return ` · dropped ${parts.join(' and ')}${renamed}${maps}`;
  }

  //: What each spelling is called, for the status line and for the failure.
  const EXPORT_NAMES = { glb: 'glTF', gltf: 'glTF', fbx: 'FBX' };

  /**
   * Write what is on screen out, in whichever spelling was asked for.
   *
   * All three are the same scene: the same meshes, the same node tree, the
   * same materials and the same pictures, gathered once and handed to whichever
   * writer. A `.glb` is one file; a `.gltf` is that file's JSON beside its
   * buffer, which is two downloads and the browser asking whether you meant
   * it; an `.fbx` is what the rest of this tool reads, written back out.
   */
  async function exportGltf() {
    if (!currentMesh) return;
    const format = (dom.exportFormat && dom.exportFormat.value) || 'glb';
    try {
      dom.exportGltf.disabled = true;
      setStatus(`Writing ${EXPORT_NAMES[format] || 'the model'}…`);
      await nextFrame();
      const { images, textures } = await textureBytes(currentPalette);
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
      const common = {
        name: stem,
        meshes: scene.meshes,
        nodes: scene.nodes,
        images,
        textures,
        upAxis: dom.upSelect.value,
        flips: flips.slice(),
      };
      let stats;
      if (format === 'fbx') {
        /* FBX is the format the axis and the units are *stated* in, so they go
         * into `GlobalSettings` where they came from and the geometry is
         * written exactly as it stands. glTF has no such field, which is why
         * the other two put the same difference on the root node's matrix. */
        const built = FbxOut.build(Object.assign({}, common, {
          settings: { unitScale: centimetres },
        }));
        const bytes = await FbxOut.serialise(built.tree);
        download(new Blob([bytes], { type: 'application/octet-stream' }), `${stem}.fbx`);
        stats = built.stats;
        stats.bytes = bytes.length;
        stats.files = [`${stem}.fbx`];
      } else {
        const built = FbxGltf.build(Object.assign({}, common, {
          unitScale: centimetres / 100,
        }));
        stats = built.stats;
        if (format === 'gltf') {
          /* Two files, handed over as one.
           *
           * A browser downloads one thing at a time, so a pair means it
           * stopping to ask whether you meant it and then two files that have
           * to stay together and are easy to part. Zipped, it is one download
           * and arrives as what it is — and the JSON still names the buffer
           * beside it, which is where an extraction puts it. */
          const { gltf, bin } = FbxGltf.separate(built, `${stem}.bin`);
          const text = new TextEncoder().encode(gltf);
          const archive = await FbxZip.write([
            { name: `${stem}.gltf`, bytes: text },
            { name: `${stem}.bin`, bytes: bin },
          ]);
          if (archive) {
            download(new Blob([archive], { type: 'application/zip' }), `${stem}.zip`);
            stats.bytes = archive.length;
            stats.files = [`${stem}.zip`];
          } else {
            // Somewhere with no deflate to offer: the two files separately
            // beats an archive nothing can open.
            download(new Blob([bin], { type: 'application/octet-stream' }), `${stem}.bin`);
            download(new Blob([text], { type: 'model/gltf+json' }), `${stem}.gltf`);
            stats.bytes = text.length + bin.length;
            stats.files = [`${stem}.gltf`, `${stem}.bin`];
          }
        } else {
          download(new Blob([built.glb], { type: 'model/gltf-binary' }), `${stem}.glb`);
          stats.files = [`${stem}.glb`];
        }
      }
      const missingMaps = unwrittenMaps(images, textures);
      stats.format = format;
      stats.dropped = currentGeometry ? null : reportDropped(stats, missingMaps);
      lastExport = stats;
      const instanced = stats.triangles > stats.stored
        ? `, ${stats.stored.toLocaleString()} stored` : '';
      setStatus(`Exported ${stats.triangles.toLocaleString()} triangles${instanced} as `
        + `${stats.files.join(' + ')} — `
        + `${stats.meshes} mesh(es) in ${stats.nodes} node(s), `
        + `${stats.vertices.toLocaleString()} vertices, `
        + `${(stats.bytes / 1048576).toFixed(1)} MiB`
        + `${stats.images ? ` with ${stats.images} image(s)` : ''} · `
        + `${(performance.now() - started).toFixed(0)} ms`
        + describeDropped(stats.dropped), 'ok');
    } catch (error) {
      console.error(error);
      setStatus(`Could not write the ${EXPORT_NAMES[format] || 'model'}: `
        + `${error.message}`, 'error');
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

    /* Leaving an image out, or taking that back.
     *
     * A model arrives with whatever its folder held, and not all of it is
     * wanted: a normal map that fights the geometry, a lightmap baked for
     * another renderer. Dropping one here keeps it out of the viewport and out
     * of the export, and the row goes on saying which file the material names
     * so the choice can be undone. */
    dom.materials.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action="drop"]');
      if (!button) return;
      const name = button.dataset.key;
      const slot = button.dataset.slot;
      if (!name || !slot) return;
      const set = materialOverrides[name] || {};
      const dropped = new Set(set.dropped || []);
      if (dropped.has(slot)) dropped.delete(slot);
      else dropped.add(slot);
      const next = Object.assign({}, set);
      if (dropped.size) next.dropped = [...dropped];
      else delete next.dropped;
      // A material with nothing set on it at all is not an assignment.
      if (Object.keys(next).length) materialOverrides[name] = next;
      else delete materialOverrides[name];
      refreshPalette();
      persist();
      renderMaterials();
      refreshTextures();
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
  function materialEntry(material, analysis, index) {
    const info = analysis || currentAnalysis;
    const resolve = (index || objectIndex).resolve;
    // Template defaults sit underneath, so a material with no Properties70
    // still gets the colour and finish its type declares.
    const props = FbxAnalyze.resolvedProperties(material, info.templates);
    const look = FbxAnalyze.materialAppearance(props);
    const maps = materialTextures(material, resolve, info.connections);
    const { baseColor, ...rest } = maps;
    return {
      name: material.displayName,
      uid: material.uid,
      // Values are linear, which is what the shader works in.
      colour: look.colour,
      specular: look.specular,
      roughness: look.roughness,
      // The clear coat over it: a sharp mirror laid on a base that need not be
      // sharp at all, which is what makes car paint read as car paint.
      coat: look.coat,
      coatRoughness: look.coatRoughness,
      opacity: look.opacity,
      // Whatever the file says it is: a .blend and a glTF state a metalness
      // outright, and so does an FBX written from a Physical Material or a
      // standardSurface. A plain Phong material states none, and is a
      // dielectric.
      metallic: look.metallic,
      // Read but never edited: what the surface gives off, and how the file
      // asked to be blended. Both are carried so an export can put them back.
      emissive: look.emissive.slice(),
      alphaMode: look.alphaMode,
      alphaCutoff: look.alphaCutoff,
      // Kept so an assignment can always be undone back to the file itself —
      // the name included, since a material can be renamed and its settings
      // still have to be found under what the file called it.
      fromFile: {
        name: material.displayName,
        colour: look.colour.slice(),
        // The colour before a metalness split it between diffuse and
        // reflectance, which is what the Materials tab edits.
        base: look.base.slice(),
        specular: look.specular.slice(),
        emissive: look.emissive.slice(),
        roughness: look.roughness,
        opacity: look.opacity,
        metallic: look.metallic,
        alphaMode: look.alphaMode,
        alphaCutoff: look.alphaCutoff,
      },
      texture: baseColor || null,
      /* How many times the grain is tiled across the surface.
       *
       * The game states it beside the map, and it is the whole of what makes a
       * detail map a detail: the same leather at 1 is a stretched sheet and at
       * 60 is leather. A material that says it wears none has none, whatever
       * map it also names — an Audi S8 has four such, and drawn they would be
       * a sheet of carbon over a plain grey panel. */
      detailTiling: props.useDetail === 0 ? 0
        : (typeof props.detailUVMultiplier === 'number'
          ? props.detailUVMultiplier : 1),
      // How much of the sun's highlight the surface takes, where it says.
      specularWeight: look.specularWeight,
      /* And the shape of what it returns of the world: how fast the
       * reflection rises as the surface turns away, and how far it is let
       * get. A game states both; nothing else states either, and then the
       * plain Schlick stands. */
      fresnelExp: look.fresnelExp,
      fresnelCeiling: look.fresnelCeiling,
      /* Whether the colour is read through the picture or replaced by it.
       *
       * Most files mean the second: a flat colour is a stand-in for the map
       * that was not written beside it. A game's material means the first —
       * everything it states about a surface is stated for the whole of it,
       * and the picture is the pattern rather than the paint. An Audi S8's
       * wheels are a grey panel map at three per cent of the light, and drawn
       * either way round they are the difference between black rims and
       * white ones. */
      tintTexture: props.TintsTexture === 1 || props.TintsTexture === true,
      // The maps this tool does not show, kept as they were read.
      textures: rest,
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
      .map((m) => materialEntry(m));
  }

  /* --------------------------------------------------------------- textures */

  /** Basename of a path written with either separator, lowercased. */
  function baseName(path) {
    return String(path).split(/[\\/]/).pop().toLowerCase();
  }

  /**
   * The supplied file a texture record names, by name and then by stem.
   *
   * A model usually names the picture it wants and the picture is there. A
   * BeamNG car names the one its artist authored — `bolide_main_b.color.png` —
   * and ships the one the game converted, `bolide_main_b.color.DDS`, so an
   * exact match finds nothing and every surface of the car comes up bare.
   * Falling back to the name without its extension finds it, and is the same
   * kind of allowance as matching by name rather than by path: what a file is
   * called is what it is, and which encoder last touched it is not.
   *
   * Only where the exact name is not there, so a folder holding both keeps
   * whichever the model actually asked for.
   */
  function suppliedFor(supplied, path) {
    const name = baseName(path);
    const exact = supplied.get(name);
    if (exact) return exact;
    const stem = name.replace(/\.[^.]*$/, '');
    if (!stem || stem === name) return undefined;
    for (const [key, file] of supplied) {
      if (key.replace(/\.[^.]*$/, '') === stem) return file;
    }
    return undefined;
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
   * Every texture bound to a material, by the glTF map it fills.
   *
   * A Texture attaches to a Material through an object-to-property connection
   * naming the property it drives. The base colour, the metallic-roughness
   * map and the one that shapes the surface are drawn; the rest are read all
   * the same, so that an export can put them back where it found them rather
   * than write a car with every shut line painted on.
   *
   * The wrap modes come off the bound Texture record rather than the image:
   * a tiling tread that comes back clamped is a visible change on a wheel.
   */
  function materialTextures(material, resolve, connections) {
    const out = {};
    for (const link of connections) {
      if (link.kind !== 'OP' || resolve(link.dst) !== material) continue;
      const slot = FbxAnalyze.textureSlot(link.prop);
      if (!slot || out[slot]) continue;
      const bound = resolve(link.src);
      if (!bound) continue;
      const image = imageBehind(bound, resolve, connections, new Set());
      if (!image) continue;
      const wrap = FbxAnalyze.wrapModes(FbxAnalyze.properties(bound.node));
      out[slot] = { ...image, ...wrap, name: bound.displayName };
    }
    return out;
  }

  /** Decode one image, from embedded bytes or a file the user supplied. */
  const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

  /* Every texture is decoded with its colour and its alpha kept apart.
   *
   * Multiplied together — which is what a browser does by default, and what a
   * 2D canvas can only do — a texel at zero alpha loses its colour outright,
   * since dividing it back out is a division by nothing. That costs nothing on
   * a texel nobody sees, and everything on a material that never asked for
   * alpha in the first place: a `.dds` out of this game routinely carries an
   * alpha channel of nothing beside a picture that matters. One default
   * anywhere in the chain throws the colour away before the next call can
   * ask for it back. */
  const UNMULTIPLIED = { premultiplyAlpha: 'none' };

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
      return await createImageBitmap(
        new ImageData(image.rgba, image.width, image.height), UNMULTIPLIED);
    } catch (error) {
      console.warn('KTX2:', error.message);
      return null;
    } finally {
      FbxWasm.release(mark);
    }
  }

  /**
   * The flattened picture inside a Photoshop document.
   *
   * Same case as a KTX2: no browser will make an image of one, and 3ds Max
   * scenes name them freely — a tyre whose tread lives in a `.psd` is a plain
   * black ring without this.
   */
  async function decodePsd(bytes) {
    try {
      const image = FbxPsd.decode(bytes);
      if (!image) return null;
      return await createImageBitmap(
        new ImageData(image.rgba, image.width, image.height), UNMULTIPLIED);
    } catch (error) {
      console.warn('PSD:', error.message);
      return null;
    }
  }

  /**
   * The picture inside a DirectDraw Surface.
   *
   * Same case again: no browser will make an image of a `.dds`, and Assetto
   * Corsa keeps almost every texture in one — 111 of the 135 in a single car —
   * so a `.kn5` without this opens as a grey model with its paint, its badges
   * and its dials all missing.
   */
  async function decodeDds(bytes) {
    try {
      const image = FbxDds.decode(bytes);
      if (!image) return null;
      return await createImageBitmap(
        new ImageData(image.rgba, image.width, image.height), UNMULTIPLIED);
    } catch (error) {
      console.warn('DDS:', error.message);
      return null;
    }
  }

  async function decodeTexture(request, supplied) {
    /* The skin first, if one is on.
     *
     * This is the one place a supplied file beats an embedded one, and it is
     * the game's own rule rather than a preference: a `.kn5` holds the car
     * unpainted and everything under `skins/<name>/` replaces the texture of
     * that name for as long as that skin is chosen. Which skin is the question
     * the folder is asking, so nothing is chosen here until somebody does.
     */
    const wornFile = wearing && wearing.images.get(baseName(request.path || request.name));
    if (wornFile) {
      const painted = await decodeSupplied(wornFile);
      if (painted) return painted;
    }
    if (request.embedded) {
      if (looksLikeKtx2(request.embedded)) return decodeKtx2(request.embedded);
      if (FbxPsd.looksLikePsd(request.embedded)) return decodePsd(request.embedded);
      if (FbxDds.looksLikeDds(request.embedded)) return decodeDds(request.embedded);
      const blob = new Blob([request.embedded]);
      try {
        return await createImageBitmap(blob, UNMULTIPLIED);
      } catch (error) {
        return null;                       // an image format the browser refuses
      }
    }
    const file = suppliedFor(supplied, request.path);
    return file ? decodeSupplied(file) : null;
  }

  /** One file from disk as an image, whichever of the four kinds it is. */
  async function decodeSupplied(file) {
    if (/\.ktx2$/i.test(file.name)) {
      return decodeKtx2(new Uint8Array(await file.arrayBuffer()));
    }
    if (/\.psd$/i.test(file.name)) {
      return decodePsd(new Uint8Array(await file.arrayBuffer()));
    }
    if (/\.dds$/i.test(file.name)) {
      return decodeDds(new Uint8Array(await file.arrayBuffer()));
    }
    try {
      return await createImageBitmap(file, UNMULTIPLIED);
    } catch (error) {
      return null;
    }
  }

  /**
   * Decode each distinct image of one kind once and assign it an array layer,
   * dropping any that could not be loaded so the shader falls back to what the
   * material states on its own.
   */
  async function resolveLayer(palette, pick, field) {
    const requests = [];
    const layerOf = new Map();
    for (const material of palette) {
      const request = pick(material);
      material[field] = -1;
      if (!request) continue;
      const key = request.embedded
        ? `embedded:${request.name}` : `file:${baseName(request.path)}`;
      if (!layerOf.has(key)) {
        layerOf.set(key, requests.length);
        requests.push(request);
      }
      material[field] = layerOf.get(key);
    }
    if (!requests.length) return { images: [], missing: [], unreadable: [], requested: 0 };

    const decoded = await Promise.all(requests.map((r) => decodeTexture(r, suppliedImages)));

    // Compact the layers so only successfully decoded images take a slot.
    const remap = new Map();
    const images = [];
    decoded.forEach((image, index) => {
      if (image) { remap.set(index, images.length); images.push(image); }
    });
    for (const material of palette) {
      material[field] = remap.has(material[field]) ? remap.get(material[field]) : -1;
    }
    // Two different things go wrong here and they need different words. A file
    // nobody supplied is answered by supplying it; a file that is sitting in
    // the folder and will not decode is not, and telling someone to drop in
    // what they have already dropped in is the tool being wrong about its own
    // state rather than about theirs.
    const failed = requests.filter((_, index) => !decoded[index]);
    const named = (request) => baseName(request.path) || request.name;
    const absent = (request) =>
      !request.embedded && !suppliedFor(suppliedImages, named(request));
    return {
      images,
      missing: failed.filter(absent).map(named),
      unreadable: failed.filter((r) => !absent(r)).map(named),
      requested: requests.length,
    };
  }

  /**
   * How far a height map is allowed to tilt a normal, as the slope it stands
   * for. A bump map says how high the surface is and not which way it faces,
   * so the slope has to be read off the neighbouring texels and scaled by
   * something; four is what makes a leather grain read as grain and a tyre's
   * lettering stand off its sidewall without either turning to gravel.
   */
  const BUMP_RELIEF = 4;

  /**
   * How large a picture the grain may be baked into.
   *
   * Two thousand and forty-eight is what the paint maps to hand are: a car
   * whose body is 2048 and whose grain is 512 comes out at 2048, the size it
   * already was. It is a ceiling rather than a target — a 256-pixel badge with
   * a 512-pixel grain over it comes out at 512 and no more.
   */
  const BAKE_LIMIT = 2048;

  /**
   * The images the viewer draws with: the base colour, the map that says how
   * metallic and how rough the surface is at each texel, and the map that says
   * what shape it is between its own vertices.
   *
   * Only the first is a picture. A metallic-roughness map is read so that a
   * material stating one metalness for the whole of itself, over a map that
   * varies it, is drawn as the map has it — a tyre whose file leaves
   * `metallicFactor` out takes glTF's default of 1, and drawn at that it is a
   * white mirror with its tread cancelled. A bump or normal map is read so
   * that a surface modelled flat and detailed by its maps is not drawn flat.
   */
  const wanted = (entry, slot) => !(entry.droppedMaps || []).includes(slot);

  /**
   * Whether an image states a direction or a height.
   *
   * The same slot carries both. A tangent-space normal map is three channels
   * of a unit vector, and since most of a surface faces roughly the way it
   * already did, it comes out overwhelmingly blue with red and green around
   * the middle. A bump map is a height, which is to say grey. Told apart the
   * wrong way round, a normal map read as a height gives a surface shaped by
   * its own blue channel and a bump map read as a direction tips every normal
   * towards the same corner.
   *
   * Decided on a thumbnail rather than the whole image: this is a question
   * about the image as a whole, and a 32-pixel square answers it.
   */
  function looksLikeNormalMap(image, edge = 32) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = edge;
      canvas.height = edge;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, edge, edge);
      const pixels = context.getImageData(0, 0, edge, edge).data;
      let red = 0;
      let green = 0;
      let blue = 0;
      const count = pixels.length / 4;
      for (let i = 0; i < pixels.length; i += 4) {
        red += pixels[i];
        green += pixels[i + 1];
        blue += pixels[i + 2];
      }
      red /= count * 255;
      green /= count * 255;
      blue /= count * 255;
      // Blue well ahead of the other two is the tell, and it is the one a grey
      // image cannot fake however bright or dark it is.
      return blue - Math.max(red, green) > 0.1
        && Math.abs(red - 0.5) < 0.25 && Math.abs(green - 0.5) < 0.25;
    } catch (error) {
      return false;                // unreadable pixels: treat it as a height
    }
  }

  /**
   * How bright a detail texture is on average, as a thumbnail sees it.
   *
   * A detail map is a *grain*: what it says is where the surface is lighter or
   * darker than itself, tiled dozens of times across a panel. What it does not
   * say is how much of it the game mixes in, and the two readings are far
   * apart — a Mercedes E63's paint wears one averaging 0.24, so multiplied
   * straight its white body comes out graphite, and an Audi's leather wears
   * one at 0.28. So each is taken as neutral at its own average, and only what
   * differs from that shows. The colour a car was authored stays where it was,
   * and the grain and the cast of the picture arrive on top of it.
   *
   * `null` for a picture that is one colour from corner to corner, which is
   * not a grain at all: nothing about it differs from its own average, so
   * there is nothing for it to say. A third of the detail maps in the 67 cars
   * to hand are that — `NULL.dds`, `PURE_RED.dds`, a numbered `2.dds` — the
   * slot filled in and never authored. Taken as a grain, the greys among them
   * come out as the nothing they are, and the 55 that are a flat saturated
   * colour repaint whatever wears them: a Jaguar Mk2 whose paint names a
   * sixteen-pixel square of pure red draws red under every skin it has,
   * liveries and previews notwithstanding.
   */
  function detailScale(image, edge = 32) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = edge;
      canvas.height = edge;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, edge, edge);
      const pixels = context.getImageData(0, 0, edge, edge).data;
      /* Averaged in linear light, which is where the shader multiplies.
       *
       * A canvas hands back what the file holds — display-encoded — and the
       * sampler undoes that encoding before the shader sees it. Averaged as
       * read, a grain at 0.24 comes out five times too dark once its own
       * average is divided back out, and a white Mercedes draws graphite. */
      let total = 0;
      let flat = true;
      for (let i = 0; i < pixels.length; i += 4) {
        total += (FbxPalette.fromSrgb(pixels[i] / 255)
          + FbxPalette.fromSrgb(pixels[i + 1] / 255)
          + FbxPalette.fromSrgb(pixels[i + 2] / 255)) / 3;
        /* Held against the first texel exactly rather than within a
         * tolerance. Scaling a picture that is one colour leaves it that
         * colour, so a flat file answers this whatever size it was; a grain
         * fine enough to average away over 32 pixels still lands a texel or
         * two off, and stays a grain. */
        if (flat && (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1]
          || pixels[i + 2] !== pixels[2])) flat = false;
      }
      if (flat) return null;
      const mean = total / (pixels.length / 4);
      // A map that reads as nothing at all is left alone rather than dividing
      // by it: an alpha of zero comes back black through a canvas.
      return mean > 0.02 ? 1 / mean : 1;
    } catch (error) {
      return 1;                       // unreadable pixels: take it as it comes
    }
  }

  /**
   * The colour of a skin's paint chip, from the file it came in.
   *
   * Drawn at its own size and read back straight: a chip is sixty-four pixels
   * square and the point of it is the one flat colour most of it is, which a
   * resize would blend away. A canvas premultiplies, so the transparent
   * rounding at its corners comes back as black — which is why the reading
   * skips anything not solidly there.
   */
  async function chipColour(file) {
    try {
      const image = await decodeSupplied(file);
      if (!image) return null;
      const width = Math.min(image.width || 0, 2048);
      const height = Math.min(image.height || 0, 2048);
      if (!width || !height) return null;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, width, height).data;
      return FbxSkins.chipColour(pixels, width, height);
    } catch (error) {
      return null;                        // unreadable picture: nothing stated
    }
  }

  async function resolveTextures(palette) {
    const base = await resolveLayer(palette,
      (m) => (wanted(m, 'baseColor') ? m.texture : null), 'layer');
    const finish = await resolveLayer(palette,
      (m) => (wanted(m, 'metallicRoughness') && m.textures
        ? m.textures.metallicRoughness : null), 'finishLayer');
    const relief = await resolveLayer(palette,
      (m) => (wanted(m, 'normal') && m.textures ? m.textures.normal : null), 'bumpLayer');
    const grain = await resolveLayer(palette,
      (m) => (wanted(m, 'detail') && m.detailTiling && m.textures
        ? m.textures.detail : null), 'detailLayer');
    /* And the picture of what a surface gives off, for the ones that give off
     * anything at all. A material stating no emission needs no map of it: a
     * brake disc binds one and states its heat as nought, and that layer would
     * be a square of atlas multiplied by black. */
    const glow = await resolveLayer(palette,
      (m) => (wanted(m, 'emissive') && m.emissive && m.emissive.some((v) => v > 0)
        && m.textures ? m.textures.emissive : null), 'emissiveLayer');
    // Which kind each layer turned out to be, and how hard to take it. A
    // normal map states its own slopes and is taken as written; a height has
    // to be turned into one, and the strength is what says how deep it reads.
    const kinds = relief.images.map((image) => looksLikeNormalMap(image));
    const scales = grain.images.map((image) => detailScale(image));
    for (const material of palette) {
      const layer = material.bumpLayer;
      material.bumpIsNormalMap = layer >= 0 ? kinds[layer] : false;
      material.bumpStrength = material.bumpIsNormalMap ? 1 : BUMP_RELIEF;
      const scale = material.detailLayer >= 0 ? scales[material.detailLayer] : 1;
      /* A picture that turned out to be no grain is dropped rather than
       * multiplied in. The tiling goes with it, since that is what the export
       * asks before baking a grain into a picture — left set, a car would
       * leave carrying the flat colour the viewer had just refused to draw. */
      if (scale === null) {
        material.detailLayer = -1;
        material.detailTiling = 0;
      }
      material.detailScale = scale === null ? 1 : scale;
    }
    return {
      images: base.images,
      requested: base.requested,
      // A map that was named and did not arrive is worth saying so about,
      // whichever of the three it was.
      missing: [...new Set([...base.missing, ...finish.missing, ...relief.missing,
        ...grain.missing, ...glow.missing])],
      unreadable: [...new Set([...base.unreadable, ...finish.unreadable,
        ...relief.unreadable, ...grain.unreadable, ...glow.unreadable])],
      finish: finish.images,
      bump: relief.images,
      detail: grain.images,
      glow: glow.images,
    };
  }

  /**
   * Offer the skins that came with the car, and say what each one brings.
   *
   * A skin is worth offering for the pictures it replaces even when it says
   * nothing else, so what is counted is how many of the textures this model
   * names it has — a skin holding fifteen of an Audi's hundred and nineteen is
   * the fifteen that make it Alpine White. One that brings none of them is
   * for another car and is left out.
   */
  async function populateSkins(doc) {
    dom.skinSelect.innerHTML = '';
    wearing = null;
    if (!suppliedSkins.size || !doc || doc.format !== 'kn5') {
      dom.skinSelect.hidden = true;
      return;
    }
    const objects = FbxAnalyze.child(doc.root, 'Objects');
    const named = (type) => (objects ? objects.children : [])
      .filter((entry) => entry.name === type)
      .map((entry) => String(entry.props[1].value).split('\u0000')[0]);
    const worn = new Set(named('Video').map((n) => n.toLowerCase()));
    /* Which picture each material wears, which is what says whether a skin has
     * already painted it. The base colour alone: a skin replacing a normal map
     * has not painted anything.
     *
     * Read from the document rather than from the palette, since the palette is
     * built later than this and would be the last car's. */
    const pictures = new Map();
    for (const name of named('Material')) pictures.set(name.toLowerCase(), '');
    const info = currentAnalysis;
    if (info) {
      const { resolve } = objectIndex;
      for (const link of info.connections) {
        if (link.kind !== 'OP' || FbxAnalyze.textureSlot(link.prop) !== 'baseColor') continue;
        const material = resolve(link.dst);
        const bound = resolve(link.src);
        if (!material || !bound || material.nodeType !== 'Material') continue;
        const key = String(material.displayName || '').toLowerCase();
        if (pictures.get(key)) continue;
        pictures.set(key, baseName(String(bound.displayName || '')).toLowerCase());
      }
    }

    const read = [];
    for (const skin of suppliedSkins.values()) {
      read.push(await FbxSkins.read(skin, { worn }));
    }
    FbxSkins.settle(read, { pictures, fallback: carPaintNames,
      brightness: carPaintBrightness });
    /* And, for the ones still stating no colour, the chip they carry a picture
     * of — which is the only thing left saying what colour they are. Settled
     * first, since whether it is worth reading depends on which material the
     * car calls its paint and what picture that material wears. */
    for (const state of read) {
      if (state.wantsChip) {
        FbxSkins.fromChip(state, await chipColour(state.livery), pictures);
      }
    }
    const offered = read.filter((skin) => skin.replaces > 0)
      .sort((a, b) => b.replaces - a.replaces || a.name.localeCompare(b.name));
    if (!offered.length) {
      dom.skinSelect.hidden = true;
      return;
    }
    skinsOffered = offered;
    const bare = document.createElement('option');
    bare.value = '';
    bare.textContent = 'No skin — as the file has it';
    dom.skinSelect.appendChild(bare);
    for (const skin of offered) {
      const option = document.createElement('option');
      option.value = skin.name;
      option.textContent = `${skin.name} — ${skin.replaces} texture`
        + `${skin.replaces === 1 ? '' : 's'}`
        + (skin.paints.length ? ` + ${skin.paints.length} paint`
          + `${skin.paints.length === 1 ? '' : 's'}` : '');
      dom.skinSelect.appendChild(option);
    }
    dom.skinSelect.hidden = false;
    dom.skinSelect.value = '';
  }

  /** Put a skin on, or take the one that is on off, and draw it again. */
  async function wearSkin(name) {
    wearing = skinsOffered.find((skin) => skin.name === name) || null;
    if (!currentPalette.length) return;
    setStatus(wearing ? `Putting ${wearing.name} on…` : 'Taking the skin off…');
    const textures = await refreshTextures();
    // The paint is a palette setting rather than a texture, so it goes on with
    // the palette rather than with the images.
    paintFromSkin(currentPalette);
    finishFromConfig(currentPalette);
    FbxPalette.apply(currentPalette, materialOverrides);
    viewer.setPalette(currentPalette);
    renderMaterials();
    setStatus(wearing
      ? `${wearing.name}: ${wearing.replaces} texture(s) over the top of the car`
        + (wearing.paints.length
          ? `, and its paint on ${wearing.paints.map((p) => p.material).join(', ')}`
          : '')
      : 'The car as the file has it.');
    return textures;
  }

  function populateGeometry(doc) {
    const candidates = FbxAnalyze.findAllGeometry(doc);
    sceneParts = collectParts();
    // Which needs the parts, since what is drawn is the parts and not the
    // meshes they share.
    applySceneSmoothing(doc, sceneParts);
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
    // Materials from a second file are matched part by part, so the scene is
    // what they are put on — even where one part on its own would otherwise be
    // shown as the mesh it is.
    const merging = pendingDonor && sceneParts.length > 0;
    return sceneParts.length > 1 || placed || merging
      ? showScene() : showGeometry(candidates[0]);
  }

  /**
   * Start where the file says it was modelled.
   *
   * A 3ds Max scene built with TurboSmooth stores the cage, and drawing the
   * cage is drawing something nobody modelled — so the smoothing control opens
   * on the rounds the modifier asks for. It is a control like any other and
   * can be turned down; what it must not do is override a choice already made.
   */
  /* What a scene costs to draw, and what to spend without being asked.
   *
   * The mesh is unindexed and carries thirty floats a triangle — position,
   * normal, texture coordinate, material and part, three corners each — so its
   * weight on the card is a straight multiple of its triangles. A Pontiac
   * whose file asks for one round of subdivision is 4.65 million triangles and
   * 533 MiB of vertex buffers, and a card that cannot find the room draws
   * nothing at all: the model still reads, the parts are still counted, and
   * the viewport is empty.
   *
   * So the level the file asks for is a ceiling rather than an instruction.
   * The budget is what a machine can be assumed to take rather than what any
   * particular one will: 384 MiB, against the 533 that drew nothing on a real
   * Firefox and the 134 that drew. Turning it up by hand is one click away,
   * which is the right way round for a choice nobody asked for.
   */
  const DRAW_BYTES_PER_TRIANGLE = 30 * 4;
  const AUTO_DRAW_BUDGET = 384 * 1048576;

  /**
   * How many triangles the scene on screen becomes after so many rounds.
   *
   * Counted over the parts that are drawn rather than the meshes that are
   * stored — a car of 58 parts is often 40 meshes, four wheels being one — and
   * from corners rather than faces, since a cage of five-sided faces subdivides
   * to more than one of quads. A face of n corners fans to n-2 triangles and
   * subdivides into n quads, each of which is two triangles from then on.
   */
  function trianglesAfter(parts, level) {
    let corners = 0;
    let faces = 0;
    for (const part of parts) {
      const run = FbxAnalyze.child(part.geometry.node, 'PolygonVertexIndex');
      const held = FbxAnalyze.arrayLength(run) || 0;
      corners += held;
      // Every polygon ends on a complemented index, so the run says how many
      // there are without reading a single number of it.
      faces += Math.max(1, Math.round(held / 4));
    }
    if (!corners) return 0;
    if (level < 1) return Math.max(0, corners - 2 * faces);
    return 2 * corners * (4 ** (level - 1));
  }

  function applySceneSmoothing(doc, parts) {
    if (modeChosen || subdivisionLevel) return;
    const rounds = (doc.extra && doc.extra.smoothing) || 0;
    const smoothed = (doc.extra && doc.extra.smoothed) || 0;
    if (!rounds || !smoothed) return;
    const asked = Math.min(rounds, 2);
    let wanted = asked;
    while (wanted > 0
      && trianglesAfter(parts, wanted) * DRAW_BYTES_PER_TRIANGLE > AUTO_DRAW_BUDGET) {
      wanted--;
    }
    heldBackSmoothing = wanted < asked ? asked : 0;
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
      offerLights();
      setSelectedPart(-1);
      // Only a scene of several parts has anything to pull apart.
      dom.explodeSlider.disabled = partTable.length < 2;
      if (dom.explodeSlider.disabled) dom.explodeSlider.value = '0';
      viewer.setExplode(Number(dom.explodeSlider.value) / 100);
      updateEditControls();

      const textures = await resolveTextures(built.palette);
      missingTextures = textures.missing;
      unreadableTextures = textures.unreadable;
      installPalette(built.palette, built.mesh);
      await viewer.setTextures(textures.images);
      await viewer.setFinishTextures(textures.finish);
      await viewer.setBumpTextures(textures.bump);
      await viewer.setDetailTextures(textures.detail);
      await viewer.setGlowTextures(textures.glow);
      defaultShadingMode(built.palette.length > 0);
      dom.textureToggle.disabled = textures.images.length === 0
        && textures.finish.length === 0 && textures.bump.length === 0
        && textures.detail.length === 0 && textures.glow.length === 0;
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
      text += textureNote(textures);
      text += drawNote();
      dom.meshInfo.textContent = text;
      // The scene is whole now, so the parts are there to be dressed. This
      // rebuilds it, which is why it comes last rather than in the middle.
      await dressFromDonor();
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

    /* Which faces share a smooth normal, where the file says so. A 3ds Max
     * scene stores no normals at all — only the cage — and without this the
     * mesh can only be shaded flat, whatever it is subdivided to. */
    let smoothing = null;
    const smoothingLayer = entry.children.find((c) => c.name === 'LayerElementSmoothing');
    if (smoothingLayer) {
      const byPolygon = FbxAnalyze.pathValue(smoothingLayer, ['MappingInformationType']);
      // Per edge is the other way FBX writes them, and is not what this reads.
      if (byPolygon === 'ByPolygon') {
        smoothing = intsOf(smoothingLayer.children.find((c) => c.name === 'Smoothing'));
      }
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
      materials, smoothing,
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
      offerLights();
      setSelectedPart(-1);
      dom.explodeSlider.disabled = true;
      dom.explodeSlider.value = '0';
      viewer.setExplode(0);
      updateEditControls();
      if (hadEdits) setStatus('The mesh was rebuilt, so every part is back.', 'warn');

      const textures = await resolveTextures(palette);
      missingTextures = textures.missing;
      unreadableTextures = textures.unreadable;
      // The assembled palette, not the geometry's own: an assignment can add
      // materials to it, and the mesh was put together against that one.
      installPalette(built.palette, mesh);
      await viewer.setTextures(textures.images);
      await viewer.setFinishTextures(textures.finish);
      await viewer.setBumpTextures(textures.bump);
      await viewer.setDetailTextures(textures.detail);
      await viewer.setGlowTextures(textures.glow);
      defaultShadingMode(palette.length > 0);
      dom.textureToggle.disabled = textures.images.length === 0
        && textures.finish.length === 0 && textures.bump.length === 0
        && textures.detail.length === 0 && textures.glow.length === 0;

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
      text += textureNote(textures);
      if (chosen.fromGeometry) {
        text += ` · ${chosen.axis.toUpperCase()} up from the geometry`;
        if (currentAnalysis.globalSettings.upAxis) {
          text += `, though the file declares ${currentAnalysis.globalSettings.upAxis}`;
        }
      }
      text += drawNote();
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
    dom.pickerFolder.addEventListener('click', () => dom.folderInput.click());
    dom.folderInput.addEventListener('change', () => {
      if (dom.folderInput.files.length) loadFiles(dom.folderInput.files);
      dom.folderInput.value = '';
    });
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
      if (!event.dataTransfer) return;
      // The entries have to be taken while the event is still being handled;
      // the transfer is emptied the moment it returns.
      const dropped = droppedEntries(event.dataTransfer);
      const plain = Array.from(event.dataTransfer.files || []);
      if (!dropped.length && !plain.length) return;
      collectDropped(dropped, plain).then((files) => {
        if (files.length) loadFiles(files);
      });
    });

    dom.geometrySelect.addEventListener('change', () => {
      if (dom.geometrySelect.value === 'scene') { showScene(); return; }
      const candidates = FbxAnalyze.findAllGeometry(currentDoc);
      const entry = candidates[Number(dom.geometrySelect.value)];
      if (entry) showGeometry(entry);
    });
    dom.skinSelect.addEventListener('change', () => {
      wearSkin(dom.skinSelect.value).catch((error) => {
        setStatus(`could not put that skin on: ${error.message}`, 'error');
      });
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
    dom.flipButtons.forEach((button, axis) => {
      if (!button) return;
      button.addEventListener('click', () => {
        flips[axis] = !flips[axis];
        applyFlips();
        rememberFlips();
      });
    });
    if (dom.turnButton) {
      dom.turnButton.addEventListener('click', () => {
        heading = (heading + 1) % 4;
        applyHeading();
        rememberHeading();
      });
    }
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
    dom.lightsToggle.addEventListener('change',
      () => viewer.setLightsOn(dom.lightsToggle.checked));
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
      /* A scene too big to draw has no other symptom: the model reads, the
       * parts are counted, the line says how many triangles are in it, and the
       * viewport stays empty. The card gives way a frame or more after the
       * upload, so this is said when it happens rather than when it is asked
       * for. */
      viewer.onDrawFailure = (why, bytes) => {
        const note = `Nothing is drawn — ${why} `
          + `(${(bytes / 1048576).toFixed(0)} MiB of vertex buffers). `
          + 'Turn the smoothing down, or pick one part from the list.';
        setStatus(note, 'error');
        if (dom.meshInfo && !/Nothing is drawn/.test(dom.meshInfo.textContent)) {
          dom.meshInfo.textContent += ` · ${note}`;
        }
      };
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
      get unreadableTextures() { return unreadableTextures; },
      get loadCount() { return loadCount; },
      get palette() { return currentPalette; },
      get parts() { return sceneParts.length; },
      get partTable() { return partTable; },
      //: The skins the folder brought, and what each paints.
      get skins() { return skinsOffered.slice(); },
      //: The two ways a grain is baked into a picture, held against each
      //: other on whichever car is loaded. See `bakeBothWays`.
      bakeBothWays,
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
      get flips() { return flips.slice(); },
      get heading() { return heading; },
      get lastExport() { return lastExport; },
      get lastSurvey() { return lastSurvey; },
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
