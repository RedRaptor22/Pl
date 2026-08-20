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
  lassoPath.style.display = '';
};
P.clearLasso = function(){
  if(!lassoPath) lassoPath = document.getElementById('lassoPath');
  if(lassoPath){ lassoPath.style.display = 'none'; lassoPath.setAttribute('d',''); }
};

/* ==========================================================================
   Hover cursor — FACT (C.3): hover previews brush size and colour on a guide
   ========================================================================== */
var hoverRing = new THREE.Mesh(
  new THREE.RingGeometry(0.9, 1.0, 44),
  new THREE.MeshBasicMaterial({color:0xff8a3d, transparent:true, opacity:0.9,
                               side:THREE.DoubleSide, depthTest:false})
);
hoverRing.renderOrder = 900;
hoverRing.visible = false;
P.scene.add(hoverRing);

P.hideHoverCursor = function(){ hoverRing.visible = false; };

P.updateHoverCursor = function(x, y, ev){
  var onGuide = G.hasActive();
  if(!onGuide) P.refreshDrawPlane();
  var hit = Tools.projectSample(x, y);
  if(!hit){ hoverRing.visible = false; return; }

  hoverRing.position.copy(hit.point);
  hoverRing.quaternion.copy(P.cam().quaternion);

  var eraser = (TOOL.mode === 'erase' || TOOL.mode === 'vacuum');
  var r = Tools.baseRadius();
  var tilt = ev ? Tools.tiltOf(ev) : {az:null, alt:1};
  var squash = (TOOL.brush === 'flat' || TOOL.brush === 'wide') ? 0.3 : 1;
  hoverRing.scale.set(Math.max(r, 1e-4), Math.max(r*squash, 1e-4), 1);
  if(tilt.az !== null && squash < 1) hoverRing.rotateZ(tilt.az + Math.PI/2);

  hoverRing.material.color.set(eraser ? 0xff5d7e : TOOL.color.getHex());
  hoverRing.material.opacity = hit.onSurface ? 0.95 : 0.5;   // dimmer off-surface
  hoverRing.visible = true;
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
  if(TOOL.mode === 'select' && mode !== 'select'){
    S.clearSelection();
    if(G.active) G.setSelected(G.active, false);
  }
  TOOL.mode = mode;

  if(mode === 'prim') Tools.primPreview(P.UI ? P.UI.primKind : 'cube',
                                        P.UI ? P.UI.primSeg : 24,
                                        P.UI ? P.UI.primTaper : 1);
  P.onToolChange();
};

/* ==========================================================================
   Change hooks — the UI listens through these
   ========================================================================== */
P.onSceneChange = function(){ if(P.UI) P.UI.refresh(); };
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
  if(!P.viewAnimating()) P.tickSpin();
  P.tickView(now);
  P.updatePivotMarker();
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
