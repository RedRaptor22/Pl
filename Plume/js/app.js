/* ==========================================================================
   PLUME / app.js — glue: previews, hover cursor, pivot policy, toasts,
   the tool switch, and the render loop.
   ========================================================================== */
(function(P){
'use strict';

var S = P.Strokes, G = P.Guides, Tools = P.Tools, TOOL = P.TOOL;

P.loftTension = 1;
P.stagedGuide = null;

/* ==========================================================================
   Preview line for guide / bend strokes (they are not curves, so they never
   become stroke meshes)
   ========================================================================== */
var previewLine = null;
P.previewPath = function(worldPts, role){
  P.clearPreview();
  if(!worldPts || worldPts.length < 2) return;
  var geom = new THREE.BufferGeometry().setFromPoints(worldPts);
  previewLine = new THREE.Line(geom, new THREE.LineBasicMaterial({
    color: role === 'bend' ? 0xff8a3d : 0x9fd0ff,
    transparent:true, opacity:0.95, depthTest:false
  }));
  previewLine.renderOrder = 950;
  P.scene.add(previewLine);
};
P.clearPreview = function(){
  if(previewLine){
    P.scene.remove(previewLine);
    previewLine.geometry.dispose();
    previewLine.material.dispose();
    previewLine = null;
  }
};

/* ==========================================================================
   Lasso overlay — a screen-space loop, so it lives in SVG rather than in the
   scene. Drawing it in 3D would make it swim with the camera.
   ========================================================================== */
var lassoPath = null;
P.lassoPreview = function(pts){
  if(!lassoPath) lassoPath = document.getElementById('lassoPath');
  if(!lassoPath || !pts || pts.length < 2){ return; }
  var d = 'M' + pts.map(function(p){ return p.x.toFixed(1) + ',' + p.y.toFixed(1); }).join('L') + 'Z';
  lassoPath.setAttribute('d', d);
  /* 'block', not ''. The stylesheet carries `display:none` for the resting
     state, and clearing the INLINE style just lets that rule apply again - so
     the loop was drawn on an element that could never show it. The path had a
     `d` and a display the whole time, which is why this looked like it worked
     from the outside. */
  lassoPath.style.display = 'block';
};
P.clearLasso = function(){
  if(!lassoPath) lassoPath = document.getElementById('lassoPath');
  if(lassoPath){ lassoPath.style.display = 'none'; lassoPath.setAttribute('d',''); }
};

/* ==========================================================================
   Hover cursor — FACT (C.3): hover previews brush size and colour on a guide
   ========================================================================== */
/* THE PREVIEW IS THE NIB, not a token circle standing in for it. It is built
   from the very cross-section the brush draws with - S.sectionPoint, the same
   outline writeRing walks - scaled by the same half-width the trim measures
   against. So a wide brush previews as the broad ribbon it is rather than at a
   third of its real size, and the sketch pencil shows its chisel. The old ring
   sized itself off baseRadius alone and squashed itself only for two brushes
   by name, so every brush added since previewed as a plain circle at up to a
   third of the width it would actually lay down.

   It lies FLAT ON THE SURFACE, mapping the section's two axes onto the two
   directions across the guide. INFERENCE: a nib's cross-section stands
   perpendicular to its path, so a literal one would be edge-on and invisible
   from the side you draw from. What a preview is for is the footprint - how
   much ground this brush covers and in what proportion - and that is what
   lying it down shows.

   Filled at 50%, with the outline kept as the on/off-surface signal: solid
   where the stroke would land on the guide, faint where it would go in the
   air. */
var HOVER_FILL = 0.5;

var hoverGeom = { key:null, geom:null, edge:null };
function hoverSection(square, seg){
  var key = square.toFixed(2) + '|' + seg;
  if(hoverGeom.key === key) return hoverGeom;
  if(hoverGeom.geom){ hoverGeom.geom.dispose(); hoverGeom.edge.dispose(); }

  var out = {x:0, y:0}, ring = new Float32Array(seg*3), i;
  for(i=0;i<seg;i++){
    P.Strokes.sectionPoint(i/seg * Math.PI*2, square, out);
    ring[i*3] = out.x; ring[i*3+1] = out.y; ring[i*3+2] = 0;
  }
  /* a fan about the centre, written as ordinary indexed triangles - three.js
     dropped Mesh.drawMode, so TriangleFanDrawMode is not a thing to lean on */
  var fan = new Float32Array((seg+1)*3);          // 0 = centre, then the ring
  fan.set(ring, 3);
  var idx = new Uint16Array(seg*3);
  for(i=0;i<seg;i++){
    idx[i*3] = 0; idx[i*3+1] = i+1; idx[i*3+2] = (i+1) % seg + 1;
  }

  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(fan, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  var e = new THREE.BufferGeometry();
  e.setAttribute('position', new THREE.BufferAttribute(ring, 3));

  hoverGeom = { key:key, geom:g, edge:e };
  return hoverGeom;
}

var hoverFill = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.MeshBasicMaterial({color:0xff8a3d, transparent:true,
                               opacity:HOVER_FILL, side:THREE.DoubleSide,
                               depthTest:false, depthWrite:false})
);
var hoverEdge = new THREE.LineLoop(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({color:0xff8a3d, transparent:true, opacity:0.9,
                               depthTest:false})
);
hoverFill.renderOrder = 900; hoverEdge.renderOrder = 901;
hoverFill.visible = hoverEdge.visible = false;
hoverFill.frustumCulled = hoverEdge.frustumCulled = false;
P.scene.add(hoverFill); P.scene.add(hoverEdge);

P.hideHoverCursor = function(){ hoverFill.visible = hoverEdge.visible = false; };

var _hu = new THREE.Vector3(), _hw = new THREE.Vector3(), _hn = new THREE.Vector3(),
    _hfwd = new THREE.Vector3(), _hm = new THREE.Matrix4();

P.updateHoverCursor = function(x, y, ev){
  if(!G.hasActive()) P.refreshDrawPlane();
  var hit = Tools.projectSample(x, y);
  if(!hit){ P.hideHoverCursor(); return; }

  var eraser = (TOOL.mode === 'erase' || TOOL.mode === 'vacuum');
  var rx, ry, square;
  if(eraser){
    rx = ry = Tools.eraserRadius(); square = 0;
  } else {
    var cfg = P.Strokes.cfgOf({ brush: TOOL.brush });
    var r = Tools.baseRadius() * cfg.wide;
    var proto = { brush: TOOL.brush, baseRadius: Tools.baseRadius() };
    rx = P.Strokes.nibHalfWidth(proto, r);
    ry = P.Strokes.nibHalfThick(proto, r);
    square = cfg.square || 0;
  }
  /* a cursor is small on screen and cheap either way, so a round section gets
     a smooth outline rather than the eight facets a small nib is built with */
  var seg = square > 0.5 ? 8 : 48;
  var built = hoverSection(square, seg);
  hoverFill.geometry = built.geom;
  hoverEdge.geometry = built.edge;

  /* lay it on the surface: both section axes across the guide, lifted a hair
     along the normal so it does not fight the guide for the same pixels */
  _hn.copy(hit.normal && hit.normal.lengthSq() > 1e-12
             ? hit.normal : P.cam().getWorldDirection(_hn).negate()).normalize();
  P.camBasis(_hu, _hw, _hfwd);                          // _hu = camera right
  _hu.addScaledVector(_hn, -_hu.dot(_hn));
  if(_hu.lengthSq() < 1e-12) P.perpTo(_hn, _hu);
  _hu.normalize();
  _hw.crossVectors(_hn, _hu).normalize();

  _hm.makeBasis(_hu, _hw, _hn);
  hoverFill.quaternion.setFromRotationMatrix(_hm);
  hoverEdge.quaternion.copy(hoverFill.quaternion);
  hoverFill.position.copy(hit.point).addScaledVector(_hn, Math.max(rx, ry) * 0.02);
  hoverEdge.position.copy(hoverFill.position);
  hoverFill.scale.set(Math.max(rx, 1e-5), Math.max(ry, 1e-5), 1);
  hoverEdge.scale.copy(hoverFill.scale);

  var hex = eraser ? 0xff5d7e : TOOL.color.getHex();
  hoverFill.material.color.setHex(hex);
  hoverEdge.material.color.setHex(hex);
  hoverFill.material.opacity = HOVER_FILL;
  hoverEdge.material.opacity = hit.onSurface ? 0.9 : 0.35;
  hoverFill.visible = hoverEdge.visible = true;
};

/* ==========================================================================
   Pivot policy
   --------------------------------------------------------------------------
   B.2 is an inference in the spec: the orbit point "changes in real-time",
   algorithm undisclosed. Model used here: unless the user has pinned it, the
   pivot recentres on the sketch (strokes plus the active guide) whenever the
   scene changes, and the camera is held physically still while it moves.
   ========================================================================== */
P.autoPivot = function(force){
  if(P.VIEW.pinned && !force) return;
  var box = S.bounds();
  if(G.hasActive()){
    G.active.obj.updateMatrixWorld(true);
    box.expandByObject(G.active.mesh);
  }
  if(box.isEmpty()) return;
  var eye = P.cam().position.clone();
  box.getCenter(P.VIEW.pivot);
  P.syncViewToEye(eye);
  P.applyCamera();
};

/* ==========================================================================
   Toast
   ========================================================================== */
var toastEl = null, toastTimer = null;
P.toast = function(msg){
  if(!toastEl){
    toastEl = document.getElementById('toast');
    if(!toastEl) return;
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ toastEl.classList.remove('show'); }, 1600);
};

/* ==========================================================================
   Tool switching
   ========================================================================== */
P.setTool = function(mode){
  if(mode === TOOL.mode) return;
  /* leaving a staged tool throws its preview away (Cancel semantics) */
  if((TOOL.mode === 'loft' || TOOL.mode === 'prim') && mode !== TOOL.mode){
    Tools.stagedCancel();
  }
  /* Liquify works ON the selection — "select the curves you want to modify
     and tap Liquify" — so it is the one tool you can leave Select for without
     losing what you just picked. */
  if(TOOL.mode === 'select' && mode !== 'select' && mode !== 'liquify' &&
     mode !== 'loft'){
    S.clearSelection();
    if(G.active) G.setSelected(G.active, false);
  }
  TOOL.mode = mode;

  /* Loft works ON the selection, the way Liquify does: whatever is picked when
     you reach for it is what gets lofted. */
  if(mode === 'loft') Tools.loftAdopt();
  if(mode === 'prim') Tools.primPreview(P.UI ? P.UI.primKind : 'cube',
                                        P.UI ? P.UI.primSeg : 24,
                                        P.UI ? P.UI.primTaper : 1);
  P.onToolChange();
};

/* ==========================================================================
   Change hooks — the UI listens through these
   ========================================================================== */
P.onSceneChange = function(){
  P.invalidateGroundShadow(); if(P.UI) P.UI.refresh(); };
P.onToolChange  = function(){ if(P.UI) P.UI.refresh(); };
P.onViewChange  = function(){ if(P.UI) P.UI.refreshView(); };
P.onGuideChange = function(){ if(P.UI) P.UI.refresh(); };

/* ==========================================================================
   Render loop
   ========================================================================== */
/* Not every viewport change arrives as a resize event — Android WebViews move
   their insets, browser chrome collapses, and emulators change size out of
   band. applyMode/resize both early-out when nothing changed, so sampling the
   width a couple of times a second is far cheaper than a stale layout. */
var sizeTick = 0, lastW = 0, lastH = 0;
function watchViewport(){
  if((++sizeTick % 30) !== 0) return;
  var w = document.documentElement.clientWidth;
  var h = document.documentElement.clientHeight;
  if(w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  P.resize();
  if(P.UI) P.UI.applyMode();
}

function tick(now){
  watchViewport();
  P.flushDirtyStrokes();          // geometry a drag deferred, just before it shows

  if(!P.viewAnimating()) P.tickSpin();
  P.tickView(now);
  P.updatePivotMarker();
  P.updateGroundShadow();         // cached; only redrawn when the light or the sketch moves
  P.renderer.render(P.scene, P.cam());
  requestAnimationFrame(tick);
}

/* ==========================================================================
   Boot
   ========================================================================== */
P.boot = function(){
  P.diag = {
    type  : document.getElementById('dType'),
    press : document.getElementById('dPress'),
    tilt  : document.getElementById('dTilt'),
    btn   : document.getElementById('dBtn'),
    hover : document.getElementById('dHover'),
    barrel: document.getElementById('dBarrel'),
    count : document.getElementById('dCount')
  };
  P.applyEnv();
  P.applyLight();
  P.resize();
  P.applyCamera();
  window.addEventListener('resize', P.resize);
  window.addEventListener('orientationchange', function(){ setTimeout(P.resize, 150); });
  if(P.UI) P.UI.init();
  requestAnimationFrame(tick);

  /* Pick up where the last session left off. Async, so the canvas is already
     live and interactive before this resolves — a restored sketch simply
     appears. A failure here is never fatal: you get an empty sketch.

     P.ready settles once that attempt is finished either way. Anything that
     must not race the restore — the test harness above all — waits on it. */
  P.ready = (P.Doc ? P.Doc.loadAutosave() : Promise.resolve(false))
    .then(function(restored){
      if(restored){
        P.toast('Restored your last sketch');
        if(P.UI){ P.UI.refresh(); P.UI.refreshView(); }
      }
      return !!restored;
    })
    .catch(function(){ return false; });
};

})(window.P);
