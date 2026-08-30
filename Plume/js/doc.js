/* ==========================================================================
   PLUME / doc.js — the document: serialise, restore, autosave, import/export.
   --------------------------------------------------------------------------
   Everything in Plume was already plain data, so the schema is a direct
   transcription rather than a parallel model: a stroke is its point records,
   a swept guide is {local, path, anchorIndex, basisR, basisT}, a loft is the
   curves it was built from, a primitive is its kind and sliders.

   Numbers are stored as flat arrays and quantised, which is what keeps a
   sketch small enough to autosave on every edit without stalling the pen.

   Autosave targets IndexedDB rather than localStorage: localStorage is
   synchronous (it would block the draw loop) and capped at a few megabytes,
   which a real sketch passes quickly. This matters more on Android than on
   desktop — the OS evicts backgrounded WebViews aggressively, so unsaved work
   is lost work.
   ========================================================================== */
(function(P){
'use strict';

var S = P.Strokes, G = P.Guides;

var D = P.Doc = {
  FORMAT  : 'plume',
  /* v2 adds named groups with their own visibility. v1 stored `group` as a
     bare number with no name and no list, so a v1 file is read by inventing
     one group per distinct id — see restoreGroups(). */
  VERSION : 2,
  dirty   : false,
  lastSaved : 0
};

/* ---- number packing -------------------------------------------------------
   6 decimals is ~1 micrometre at our 1 unit = 1000 mm scale: far below what
   any pen can resolve, and it roughly halves the JSON. */
var Q = 1e6;
function q(n){ return Math.round(n*Q)/Q; }
function packVec(v){ return [q(v.x), q(v.y), q(v.z)]; }
function unpackVec(a){ return new THREE.Vector3(a[0], a[1], a[2]); }

function packPoints(pts){
  var n = pts.length;
  var p = new Array(n*3), tan = new Array(n*3), ref = new Array(n*3),
      nrm = new Array(n*3), roll = new Array(n), pr = new Array(n),
      az = new Array(n), alt = new Array(n);
  var fitL = new Array(n), fitR = new Array(n);
  var hasNrm = false, hasFit = false;
  for(var i=0;i<n;i++){
    var t = pts[i];
    p[i*3]=q(t.p.x); p[i*3+1]=q(t.p.y); p[i*3+2]=q(t.p.z);
    if(t.tan){ tan[i*3]=q(t.tan.x); tan[i*3+1]=q(t.tan.y); tan[i*3+2]=q(t.tan.z); }
    if(t.ref){ ref[i*3]=q(t.ref.x); ref[i*3+1]=q(t.ref.y); ref[i*3+2]=q(t.ref.z); }
    if(t.nrm){ hasNrm = true;
      nrm[i*3]=q(t.nrm.x); nrm[i*3+1]=q(t.nrm.y); nrm[i*3+2]=q(t.nrm.z); }
    roll[i] = q(t.roll || 0);
    fitL[i] = t.fitL === undefined ? 1 : q(t.fitL);
    fitR[i] = t.fitR === undefined ? 1 : q(t.fitR);
    if(fitL[i] < 1 || fitR[i] < 1) hasFit = true;
    pr[i]   = q(t.pressure);
    az[i]   = (t.tiltAz === null || t.tiltAz === undefined) ? null : q(t.tiltAz);
    alt[i]  = (t.tiltAlt === undefined) ? 1 : q(t.tiltAlt);
  }
  var out = {n:n, p:p, tan:tan, ref:ref, roll:roll, pressure:pr, tiltAz:az, tiltAlt:alt};
  if(hasNrm) out.nrm = nrm;
  /* only carried when a nib was actually trimmed to a guide's edge */
  if(hasFit){ out.fitL = fitL; out.fitR = fitR; }
  return out;
}

function unpackPoints(d){
  var pts = [], n = d.n;
  for(var i=0;i<n;i++){
    pts.push({
      p:   new THREE.Vector3(d.p[i*3], d.p[i*3+1], d.p[i*3+2]),
      tan: d.tan && d.tan[i*3] !== undefined
             ? new THREE.Vector3(d.tan[i*3], d.tan[i*3+1], d.tan[i*3+2]) : null,
      ref: d.ref && d.ref[i*3] !== undefined
             ? new THREE.Vector3(d.ref[i*3], d.ref[i*3+1], d.ref[i*3+2]) : null,
      nrm: d.nrm ? new THREE.Vector3(d.nrm[i*3], d.nrm[i*3+1], d.nrm[i*3+2]) : null,
      roll: d.roll[i],
      fitL: d.fitL ? d.fitL[i] : 1,
      fitR: d.fitR ? d.fitR[i] : 1,
      pressure: d.pressure[i],
      tiltAz: d.tiltAz[i],
      tiltAlt: d.tiltAlt[i]
    });
  }
  return pts;
}

/* ---- strokes ------------------------------------------------------------- */
function packStroke(st){
  var o = packPoints(st.pts);
  o.brush = st.brush;
  o.color = '#' + st.color.getHexString();
  o.radius = q(st.baseRadius);
  o.opacity = q(st.opacity);
  o.pressureTarget = st.pressureTarget;
  if(st.group) o.group = st.group;
  return o;
}

function unpackStroke(d){
  return {
    id: P.uid(),
    brush: P.brushName(d.brush),
    color: new THREE.Color(d.color),
    baseRadius: d.radius,
    opacity: d.opacity === undefined ? 1 : d.opacity,
    pressureTarget: d.pressureTarget || 'size',
    seedRef: null,
    group: d.group || null,
    pts: unpackPoints(d),
    mesh: null, selected: false
  };
}

/* ---- guides -------------------------------------------------------------- */
function packGuide(g){
  var o = { kind:g.kind, name:g.name, opacity:q(g.opacity) };
  g.obj.updateMatrix();
  if(!g.obj.matrix.equals(new THREE.Matrix4())){
    o.matrix = g.obj.matrix.elements.map(q);
  }
  if(g.sweep){
    var sw = g.sweep;
    var local = new Array(sw.local.length*3);
    for(var i=0;i<sw.local.length;i++){
      local[i*3]=q(sw.local[i].x); local[i*3+1]=q(sw.local[i].y); local[i*3+2]=q(sw.local[i].z);
    }
    var path = new Array(sw.path.length*3);
    for(i=0;i<sw.path.length;i++){
      path[i*3]=q(sw.path[i].x); path[i*3+1]=q(sw.path[i].y); path[i*3+2]=q(sw.path[i].z);
    }
    o.sweep = {
      local: local, path: path, anchorIndex: sw.anchorIndex,
      anchor: packVec(sw.anchor), basisR: packVec(sw.basisR),
      basisT: packVec(sw.basisT), depth: q(sw.depth)
    };
  }
  if(g.plane){
    /* a flat guide is its plane and the outline drawn on it - the mesh is
       triangulated back from those on load */
    var pl = g.plane, out = new Array(pl.outline.length*2);
    for(var k=0;k<pl.outline.length;k++){
      out[k*2] = q(pl.outline[k].u); out[k*2+1] = q(pl.outline[k].v);
    }
    o.plane = { origin: packVec(pl.origin), right: packVec(pl.right),
                up: packVec(pl.up), normal: packVec(pl.normal),
                Lu: q(pl.Lu), Lv: q(pl.Lv), outline: out };
  }
  if(g.kind === 'primitive'){
    o.prim = { kind:g.primKind, seg:g.primSeg, taper:q(g.primTaper) };
  }
  if(g.kind === 'image'){
    /* the data URL travels with the document, so a reloaded sketch still has
       its reference art without asking for the file again */
    o.image = { url:g.imageURL, aspect:q(g.imageAspect) };
  }
  if(g.kind === 'model' && g.mesh){
    var gp = g.mesh.geometry.attributes.position;
    var gn = g.mesh.geometry.attributes.normal;
    var pa = new Array(gp.count*3), na = gn ? new Array(gn.count*3) : null;
    for(var m=0;m<gp.count;m++){
      pa[m*3]=q(gp.getX(m)); pa[m*3+1]=q(gp.getY(m)); pa[m*3+2]=q(gp.getZ(m));
      if(na){ na[m*3]=q(gn.getX(m)); na[m*3+1]=q(gn.getY(m)); na[m*3+2]=q(gn.getZ(m)); }
    }
    o.model = { pos:pa, nor:na };
  }
  if(g.kind === 'loft' && g.loftCurves){
    o.loft = {
      tension: q(g.loftTension === undefined ? 1 : g.loftTension),
      curves: g.loftCurves.map(function(c){
        var a = new Array(c.length*3);
        for(var k=0;k<c.length;k++){ a[k*3]=q(c[k].x); a[k*3+1]=q(c[k].y); a[k*3+2]=q(c[k].z); }
        return a;
      })
    };
  }
  return o;
}

function unpackGuide(d){
  var g = null, i;
  if(d.kind === 'image' && d.image){
    g = G.fromImage(d.image.url, d.image.aspect, 1, d.name);
  } else if(d.kind === 'model' && d.model){
    var mg = new THREE.BufferGeometry();
    mg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(d.model.pos), 3));
    if(d.model.nor){
      mg.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(d.model.nor), 3));
    } else mg.computeVertexNormals();
    mg.setAttribute('uvw', new THREE.BufferAttribute(
      new Float32Array(mg.attributes.position.count*2), 2));
    mg.computeBoundingSphere(); mg.computeBoundingBox();
    g = G.fromModel(mg, d.name);
  } else if(d.plane){
    g = G.fromPlaneData(d.plane);
  } else if(d.kind === 'primitive' && d.prim){
    g = G.primitive(d.prim.kind, d.prim.seg, d.prim.taper);
  } else if(d.kind === 'loft' && d.loft){
    var curves = d.loft.curves.map(function(a){
      var c = [];
      for(var k=0;k<a.length;k+=3) c.push(new THREE.Vector3(a[k], a[k+1], a[k+2]));
      return c;
    });
    g = G.loftFromCurves(curves, d.loft.tension);
  } else if(d.sweep){
    g = G.fromSweepData({
      local: (function(){
        var out = [];
        for(i=0;i<d.sweep.local.length;i+=3){
          out.push({x:d.sweep.local[i], y:d.sweep.local[i+1], z:d.sweep.local[i+2]});
        }
        return out;
      })(),
      path: (function(){
        var out = [];
        for(i=0;i<d.sweep.path.length;i+=3){
          out.push(new THREE.Vector3(d.sweep.path[i], d.sweep.path[i+1], d.sweep.path[i+2]));
        }
        return out;
      })(),
      anchorIndex: d.sweep.anchorIndex,
      anchor: unpackVec(d.sweep.anchor),
      basisR: unpackVec(d.sweep.basisR),
      basisT: unpackVec(d.sweep.basisT),
      depth: d.sweep.depth
    });
  }
  if(!g) return null;
  if(d.name) g.name = d.name;
  if(d.matrix){
    g.obj.matrix.fromArray(d.matrix);
    g.obj.matrix.decompose(g.obj.position, g.obj.quaternion, g.obj.scale);
    g.obj.updateMatrixWorld(true);
  }
  G.setOpacity(g, d.opacity === undefined ? P.TUNE.guideOpacityInit : d.opacity);
  return g;
}

/* ==========================================================================
   Serialise / restore
   ========================================================================== */
D.serialize = function(){
  var V = P.VIEW, E = P.ENV, T = P.TOOL;
  return {
    format: D.FORMAT,
    version: D.VERSION,
    modified: Date.now(),
    view: {
      theta:q(V.theta), phi:q(V.phi), radius:q(V.radius), roll:q(V.roll),
      pivot:packVec(V.pivot), focal:q(V.focal), ortho:!!V.ortho, pinned:!!V.pinned
    },
    env: {
      bg:'#'+E.bg.getHexString(), grid:!!E.grid, axis:!!E.axis,
      fog:!!E.fog, shaded:!!E.shaded,
      render:!!E.render, groundShadow:!!E.groundShadow,
      /* the light belongs to the sketch: a drawing lit from the left is a
         different drawing, and reopening it under the default sun would be a
         change nobody asked for */
      light: { az:q(P.LIGHT.az), alt:q(P.LIGHT.alt),
               color:'#'+P.LIGHT.color.getHexString(),
               intensity:q(P.LIGHT.intensity), ambient:q(P.LIGHT.ambient),
               toon:!!P.LIGHT.toon, toonSteps:P.LIGHT.toonSteps },
      /* and so do the post effects, for the same reason: a sketch shot at
         f/2.8 through heavy grain is a different picture from the same curves
         rendered clean, and reopening it sharp is a change nobody asked for */
      fx: { dof:!!P.FX.dofOn, fstop:q(P.FX.fstop),
            grain:!!P.FX.grainOn, grainLevel:q(P.FX.grain),
            pixel:!!P.FX.pixelOn, pixelSize:q(P.FX.pixel) }
    },
    tool: {
      brush:T.brush, color:'#'+T.color.getHexString(), sizeMM:q(T.sizeMM),
      opacity:q(T.opacity), pressureOn:!!T.pressureOn, pressureTarget:T.pressureTarget,
      radial:Math.max(1, Math.round(T.radial || 1)),
      stableOn:!!T.stableOn, stable:q(T.stable), mirror:T.mirror,
      autoGuide:!!T.autoGuide
    },
    groups: {
      active: S.activeGroup,
      list: S.groups.map(function(g){
        return { id:g.id, name:g.name, visible:g.visible !== false };
      })
    },
    strokes: S.list.map(packStroke),
    guides: {
      active: G.active ? packGuide(G.active) : null,
      resources: G.resources.map(packGuide)
    }
  };
};

/* Groups, or an honest reconstruction of them.

   A v2 file carries the list. A v1 file carries only a number per stroke, so
   every distinct number becomes a group — named, because a nameless group is
   not something the panel can show — and strokes that were never grouped land
   in the first one. Either way the document ends up with at least one group
   and a valid active id, because a sketch always has somewhere to draw. */
function restoreGroups(doc, strokes, maxGroup){
  S.groups.length = 0;
  S.nextGroup = Math.max(1, maxGroup + 1);

  if(doc.groups && doc.groups.list && doc.groups.list.length){
    for(var i=0;i<doc.groups.list.length;i++){
      var g = doc.groups.list[i];
      S.groups.push({ id:g.id, name:g.name || ('Group ' + (i+1)),
                      visible: g.visible !== false });
      if(g.id >= S.nextGroup) S.nextGroup = g.id + 1;
    }
    S.activeGroup = doc.groups.active;
  } else {
    /* v1: invent one group per id that was actually used */
    var seen = [], k;
    for(k=0;k<strokes.length;k++){
      if(strokes[k].group && seen.indexOf(strokes[k].group) < 0) seen.push(strokes[k].group);
    }
    seen.sort(function(a,b){ return a-b; });
    S.groups.push({ id: S.nextGroup++, name:'Group 1', visible:true });
    for(k=0;k<seen.length;k++){
      S.groups.push({ id: seen[k], name:'Group ' + (k+2), visible:true });
    }
    for(k=0;k<strokes.length;k++){
      if(!strokes[k].group) strokes[k].group = S.groups[0].id;
    }
    S.activeGroup = S.groups[0].id;
  }
  S.ensureGroup();
}

/* Replaces the scene wholesale. History is cleared rather than preserved:
   undoing from a freshly opened document back into the previous one would be
   a surprising thing for the arrow to do. */
D.restore = function(doc){
  if(!doc || doc.format !== D.FORMAT) return false;
  if(doc.version > D.VERSION) return false;      // written by a newer build

  D.clear(true);

  var i;
  if(doc.strokes){
    var maxGroup = 0, restored = [];
    for(i=0;i<doc.strokes.length;i++){
      var st = unpackStroke(doc.strokes[i]);
      if(st.group && st.group > maxGroup) maxGroup = st.group;
      if(st.pts.length) restored.push(st);
    }
    restoreGroups(doc, restored, maxGroup);
    /* added AFTER the groups exist, so each mesh is built with the right
       visibility rather than flashing on and being hidden a frame later */
    for(i=0;i<restored.length;i++) S.add(restored[i]);
  } else {
    restoreGroups(doc, [], 0);
  }
  if(doc.guides){
    if(doc.guides.resources){
      for(i=0;i<doc.guides.resources.length;i++){
        var r = unpackGuide(doc.guides.resources[i]);
        if(r) G.resources.push(r);
      }
    }
    if(doc.guides.active){
      var a = unpackGuide(doc.guides.active);
      if(a) G.setActive(a);
    }
  }

  var V = P.VIEW;
  if(doc.view){
    V.theta = doc.view.theta; V.phi = doc.view.phi;
    V.radius = doc.view.radius; V.roll = doc.view.roll;
    V.pivot.fromArray(doc.view.pivot);
    V.focal = doc.view.focal; V.ortho = !!doc.view.ortho; V.pinned = !!doc.view.pinned;
  }
  if(doc.env){
    P.ENV.bg.set(doc.env.bg);
    P.ENV.grid = !!doc.env.grid; P.ENV.axis = !!doc.env.axis;
    P.ENV.fog = !!doc.env.fog; P.ENV.shaded = !!doc.env.shaded;
    P.ENV.render = !!doc.env.render;
    if(doc.env.groundShadow !== undefined) P.ENV.groundShadow = !!doc.env.groundShadow;
    P.applyEnv();
    S.setShaded(P.ENV.shaded);
    var L = doc.env.light;
    if(L){
      P.LIGHT.az = L.az; P.LIGHT.alt = L.alt;
      P.LIGHT.color.set(L.color);
      P.LIGHT.intensity = L.intensity; P.LIGHT.ambient = L.ambient;
      P.LIGHT.toon = !!L.toon;
      if(L.toonSteps) P.LIGHT.toonSteps = L.toonSteps;
    }
    var X = doc.env.fx;
    if(X){
      P.FX.dofOn   = !!X.dof;
      P.FX.grainOn = !!X.grain;
      P.FX.pixelOn = !!X.pixel;
      if(X.fstop      !== undefined) P.FX.fstop = X.fstop;
      if(X.grainLevel !== undefined) P.FX.grain = X.grainLevel;
      if(X.pixelSize  !== undefined) P.FX.pixel = X.pixelSize;
    }
    P.applyLight();
  }
  if(doc.tool){
    var T = P.TOOL;
    T.brush = P.brushName(doc.tool.brush);
    T.color.set(doc.tool.color);
    T.sizeMM = doc.tool.sizeMM; T.opacity = doc.tool.opacity;
    T.pressureOn = !!doc.tool.pressureOn;
    T.pressureTarget = doc.tool.pressureTarget || 'size';
    T.stableOn = !!doc.tool.stableOn; T.stable = doc.tool.stable;
    T.mirror = doc.tool.mirror || null;
    T.radial = Math.max(1, Math.round(doc.tool.radial || 1));
    T.autoGuide = !!doc.tool.autoGuide;
  }

  P.applyCamera();
  P.History.clear();
  D.dirty = false;
  P.onSceneChange();
  P.onViewChange();
  return true;
};

D.clear = function(quiet){
  S.clear();
  S.clearSelection();
  S.groups.length = 0;
  S.activeGroup = 0;
  S.ensureGroup();
  G.setActive(null);
  for(var i=0;i<G.resources.length;i++) G.dispose(G.resources[i]);
  G.resources.length = 0;
  if(P.stagedGuide){ G.dispose(P.stagedGuide); P.stagedGuide = null; }
  P.History.clear();
  D.dirty = false;
  if(!quiet){ P.onSceneChange(); }
};

/* ==========================================================================
   IndexedDB autosave
   ========================================================================== */
var DB_NAME = 'plume', DB_STORE = 'docs', AUTOSAVE_KEY = 'autosave';
var dbPromise = null;

function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise(function(resolve, reject){
    if(!window.indexedDB){ reject(new Error('no indexedDB')); return; }
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function(){
      var db = req.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = function(){ resolve(req.result); };
    req.onerror = function(){ reject(req.error); };
  });
  return dbPromise;
}

function idbPut(key, value){
  return openDB().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}

function idbGet(key){
  return openDB().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(DB_STORE, 'readonly');
      var req = tx.objectStore(DB_STORE).get(key);
      req.onsuccess = function(){ resolve(req.result || null); };
      req.onerror = function(){ reject(req.error); };
    });
  });
}

function idbDelete(key){
  return openDB().then(function(db){
    return new Promise(function(resolve){
      var tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = function(){ resolve(true); };
      tx.onerror = function(){ resolve(false); };
    });
  });
}

D.saveNow = function(){
  var doc;
  try { doc = D.serialize(); }
  catch(err){ return Promise.reject(err); }
  return idbPut(AUTOSAVE_KEY, doc).then(function(){
    D.dirty = false;
    D.lastSaved = Date.now();
    if(P.onSaveState) P.onSaveState('saved');
    return true;
  }).catch(function(err){
    if(P.onSaveState) P.onSaveState('error');
    throw err;
  });
};

D.loadAutosave = function(){
  return idbGet(AUTOSAVE_KEY).then(function(doc){
    if(!doc) return false;
    return D.restore(doc);
  }).catch(function(){ return false; });
};

D.discardAutosave = function(){ return idbDelete(AUTOSAVE_KEY); };

/* Debounced: drawing fires history events far faster than we want to write.
   A short idle delay batches a burst of strokes into one save. */
var saveTimer = null, SAVE_DELAY = 900;

/* Off switch, so a harness driving the app does not overwrite the real
   sketch sitting in this origin's autosave slot. */
D.autosave = true;

D.touch = function(){
  if(!D.autosave) return;
  D.dirty = true;
  if(P.onSaveState) P.onSaveState('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){
    saveTimer = null;
    D.saveNow().catch(function(){});
  }, SAVE_DELAY);
};

/* Flush synchronously-ish when the app is going away. Android kills
   backgrounded WebViews without warning, and visibilitychange is the last
   reliable signal we get. */
D.flush = function(){
  if(!D.dirty) return;
  clearTimeout(saveTimer); saveTimer = null;
  D.saveNow().catch(function(){});
};

/* ==========================================================================
   File export / import
   ========================================================================== */
D.exportBlob = function(){
  return new Blob([JSON.stringify(D.serialize())], {type:'application/json'});
};

D.download = function(name){
  P.Export.saveBlob(D.exportBlob(), (name || 'sketch-' + Date.now()) + '.plume.json');
};

D.importFile = function(file){
  return new Promise(function(resolve, reject){
    var fr = new FileReader();
    fr.onload = function(){
      var doc;
      try { doc = JSON.parse(fr.result); }
      catch(err){ reject(new Error('Not a Plume file')); return; }
      if(!D.restore(doc)) reject(new Error('Unsupported Plume file'));
      else resolve(true);
    };
    fr.onerror = function(){ reject(fr.error); };
    fr.readAsText(file);
  });
};

/* ---- wiring -------------------------------------------------------------- */
P.History.listeners.push(function(){ D.touch(); });

document.addEventListener('visibilitychange', function(){
  if(document.visibilityState === 'hidden') D.flush();
});
window.addEventListener('pagehide', function(){ D.flush(); });

})(window.P);
