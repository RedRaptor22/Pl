/* ==========================================================================
   PLUME / tools.js — the tool state machine and every pen-driven operation.
   --------------------------------------------------------------------------
   Architecture note that matters: DURING A STROKE THE SCREEN SAMPLES ARE THE
   SOURCE OF TRUTH. World points are derived from them by projection (onto the
   active guide, or onto the camera-facing plane through the pivot when there
   is none). That is what lets Stable Stroke smooth in the space the hand
   actually works in, and lets Draw Shape re-fit a clean line/circle and then
   re-project it onto the guide without any special-casing.
   ========================================================================== */
(function(P){
'use strict';

var T = P.TUNE, S = P.Strokes, G = P.Guides;

var TOOL = P.TOOL = {
  mode        : 'draw',      // draw|shape|guide|bend|erase|vacuum|select|liquify|eyedrop|inject
  brush       : 'pen',
  color       : new THREE.Color('#1b1c21'),   // dark ink on the light default scene
  sizeMM      : 14,
  eraserMM    : 20,          // GUESS: the eraser has its OWN size — see stepErase()
  opacity     : 1,
  pressureOn  : true,        // FACT (C.3): pressure toggle lives in the Brush Panel
  pressureTarget : 'size',
  stableOn    : true,        // FACT (C.2): Stable Stroke
  stable      : 0.45,
  mirror      : null,        // FACT (C.10): null | 'x' | 'z'
  autoGuide   : true,        // C.1 INFERENCE: with no guide, the first stroke makes one
  shapeHold   : true,
  /* n-fold symmetry about the vertical axis; 1 is off. Composes with mirror. */
  radial      : 1,
  /* FACT: the Liquify panel carries size, range and strength, each adjusted by
     sliding up or down, and a mode you tap or drag to change. */
  liquify     : { mode:'push', size:120, range:60, strength:55 }
};

var Tools = P.Tools = {};

/* ---- brush radius in world units ----------------------------------------- */
function baseRadius(){
  return P.clamp(TOOL.sizeMM, T.brushMinMM, T.brushMaxMM) * P.MM * 0.5;
}
Tools.baseRadius = baseRadius;

function eraserRadius(){
  return P.clamp(TOOL.eraserMM, T.brushMinMM, T.brushMaxMM) * P.MM * 0.5;
}
Tools.eraserRadius = eraserRadius;

/* Which size the size control edits: the eraser has one of its own, and the
   readout follows the tool you are holding. */
Tools.sizeTarget = function(){
  return (TOOL.mode === 'erase' || TOOL.mode === 'vacuum') ? 'eraserMM' : 'sizeMM';
};

/* ==========================================================================
   Projection: screen sample -> world point
   ========================================================================== */
var _v = new THREE.Vector3();

function projectSample(x, y){
  if(G.hasActive()){
    var hit = G.project(x, y);
    if(hit) return hit;
    /* An active guide that refuses the sample means "this is not on the
       surface". Falling through to the pivot plane here would quietly plant
       the point in mid-air — which is exactly what let strokes run off the
       edge of an imported image (A.4: "you cannot draw outside its
       boundaries") and off a guide with clamping switched off. */
    return null;
  }
  var p = P.planePoint(x, y, new THREE.Vector3());
  if(!p) return null;
  return { point:p, normal:P.cam().getWorldDirection(_v.clone()).negate(), onSurface:false };
}
Tools.projectSample = projectSample;

/* ==========================================================================
   Sample density
   --------------------------------------------------------------------------
   A stroke is stored at whatever rate the platform delivers pointermove. That
   is fine for a slow, considered line and poor for a fast one: at 60Hz a flick
   across the screen lands samples 30-50px apart, and the tube drawn through
   them is a visible polygon — the "low poly" look, which is a sampling problem
   rather than a tessellation one.

   Two answers, and both are needed. input.js asks the platform for the samples
   it already coalesced away, which is the real fix on a pen that reports at
   240Hz. This is the other half: on commit, a sparse screen path is resampled
   through a CENTRIPETAL Catmull-Rom, which passes exactly through the points
   the pen actually gave and only adds curvature between them. Nothing is
   smoothed away — that is Stable Stroke's job, and it stays opt-in.
   ========================================================================== */
/* GUESS: 8px. The deviation of a chord from the curve it cuts is about
   chord^2/8R, so an 8px step on a curve of even 30px radius is a quarter of a
   pixel off — invisible — while halving the point count a 4px step would
   store. Density is not free: it is carried by every undo step and every
   exported triangle. */
var MAX_STEP_PX = 8;

function crPoint(p0, p1, p2, p3, t01, out){
  /* Barry-Goldman with alpha = 0.5. Centripetal because the uniform form
     loops and cusps when samples are unevenly spaced, which is exactly the
     case here — a hand speeds up and slows down mid-stroke. */
  function knot(ti, a, b){
    var d = Math.sqrt(Math.hypot(b.x-a.x, b.y-a.y));
    return ti + (d > 1e-6 ? d : 1e-3);
  }
  var t0 = 0, t1 = knot(t0,p0,p1), t2 = knot(t1,p1,p2), t3 = knot(t2,p2,p3);
  if(t2 - t1 < 1e-9){ out.x = p1.x; out.y = p1.y; return out; }
  var t = t1 + (t2 - t1) * t01;
  function mix(a, b, ta, tb, o){
    var f = (tb - ta) < 1e-9 ? 0 : (t - ta) / (tb - ta);
    o.x = a.x + (b.x - a.x) * f; o.y = a.y + (b.y - a.y) * f;
    return o;
  }
  var A1 = mix(p0,p1,t0,t1,{x:0,y:0}), A2 = mix(p1,p2,t1,t2,{x:0,y:0}),
      A3 = mix(p2,p3,t2,t3,{x:0,y:0});
  var B1 = mix(A1,A2,t0,t2,{x:0,y:0}), B2 = mix(A2,A3,t1,t3,{x:0,y:0});
  return mix(B1,B2,t1,t2,out);
}

function densifyScreen(scr){
  var n = scr.length;
  if(n < 2) return scr;
  var out = [scr[0]], i, k;
  for(i=0;i<n-1;i++){
    var p1 = scr[i], p2 = scr[i+1];
    var p0 = scr[i-1] || p1, p3 = scr[i+2] || p2;
    var d = Math.hypot(p2.x-p1.x, p2.y-p1.y);
    var steps = Math.min(24, Math.ceil(d / MAX_STEP_PX));
    for(k=1;k<steps;k++){
      var f = k/steps, q = crPoint(p0, p1, p2, p3, f, {x:0,y:0});
      out.push({ x:q.x, y:q.y,
                 pressure: p1.pressure + (p2.pressure - p1.pressure)*f,
                 tilt: f < 0.5 ? p1.tilt : p2.tilt });
    }
    out.push(p2);
  }
  return out;
}

/* Rebuild a committed curve from a denser screen path. Every added sample is
   re-projected like a real one, so it lands on the guide rather than on a
   chord across it — and a guide that refuses a sample still refuses it. */
function densifyCurve(l){
  if(!l.stroke || l.screen.length < 2) return;
  var dense = densifyScreen(l.screen);
  if(dense.length <= l.screen.length) return;

  var world = [], normals = [], screen = [], frames = [], i;
  for(i=0;i<dense.length;i++){
    var h = projectSample(dense[i].x, dense[i].y);
    if(!h) continue;
    world.push(h.point.clone()); normals.push(h.normal.clone());
    frames.push(h.frame || null); screen.push(dense[i]);
  }
  if(world.length < 2) return;

  l.world = world; l.normals = normals; l.screen = screen;
  l.stroke.pts.length = 0;
  for(i=0;i<world.length;i++) pushLivePoint(l.stroke, world[i], screen[i], normals[i], frames[i]);
}

/* ==========================================================================
   Live stroke
   ========================================================================== */
var live = null;

function newStroke(){
  return {
    id: P.uid(),
    brush: P.brushName(TOOL.brush),
    color: TOOL.color.clone(),
    baseRadius: baseRadius(),
    opacity: TOOL.opacity,
    /* A brush may insist on WHICH property pressure drives - the pencil wants
       tone, not width, because pressing harder lays more graphite rather than
       a broader mark. It still only applies when pressure is switched on. */
    pressureTarget: TOOL.pressureOn
      ? (P.BRUSH[P.brushName(TOOL.brush)].pressure || TOOL.pressureTarget)
      : 'none',
    seedRef: null,
    group: S.ensureGroup().id,        // a curve is drawn INTO a group
    /* and ONTO a guide, when there is one. Remembering which lets the tools
       that move points afterwards put them back on the surface they belong to
       instead of leaving them floating beside it. */
    guide: G.hasActive() ? G.active.id : null,
    pts: [], mesh: null, selected: false
  };
}

/* pen tilt -> a cross-section axis in world space (C.3). With no tilt data the
   nib lies along screen-horizontal, which is what a mouse or a finger gets. */
var camRight = new THREE.Vector3(), camUp = new THREE.Vector3(), camFwd = new THREE.Vector3();
function orientationAxis(tiltAz, out){
  P.camBasis(camRight, camUp, camFwd);
  var az = (tiltAz === null || tiltAz === undefined) ? 0 : tiltAz + Math.PI/2;
  return out.copy(camRight).multiplyScalar(Math.cos(az)).addScaledVector(camUp, Math.sin(az));
}

function tiltOf(ev){
  var tx = ev.tiltX || 0, ty = ev.tiltY || 0;
  var mag = Math.min(90, Math.sqrt(tx*tx + ty*ty));
  return { az: (tx === 0 && ty === 0) ? null : Math.atan2(ty, tx), alt: 1 - mag/90 };
}
Tools.tiltOf = tiltOf;

function pressureOf(ev){
  if(!TOOL.pressureOn) return 1;
  return (ev.pressure !== undefined && ev.pressure > 0) ? ev.pressure : 0.5;
}

var MIN_PX = 2.0;                      // screen-space resample distance

Tools.begin = function(x, y, ev){
  var mode = TOOL.mode;

  if(mode === 'erase' || mode === 'vacuum'){ beginErase(x, y); return; }
  if(mode === 'smooth'){ beginSmooth(x, y); return; }
  if(mode === 'fill'){ Tools.fillGuide(); return; }
  if(mode === 'liquify'){ beginLiquify(x, y); return; }
  if(mode === 'lasso'){ beginLasso(x, y); return; }
  if(mode === 'select'){ return; }                  // handled on tap/hold
  if(mode === 'eyedrop' || mode === 'inject'){ sample(x, y); return; }

  /* Guide-making roles. C.1: with autoGuide on and nothing active, the first
     stroke becomes the guide — the documented Feather premise. */
  var role = 'curve';
  if(mode === 'flatguide') role = 'flat';
  else if(mode === 'guide') role = 'guide';
  else if(mode === 'bend' && G.hasActive()) role = 'bend';
  else if(mode === 'draw' && TOOL.autoGuide && !G.hasActive()) role = 'guide';

  /* the plane a guide/bend stroke is drawn on: camera-facing, through the
     pivot for a new guide, through the orange anchor for a swept bend, and
     through the centre of the mesh for a deform bend */
  if(role === 'bend'){
    P.refreshDrawPlane(G.active.sweep ? G.active.sweep.anchor : G.centreOf(G.active));
  }
  else if(role === 'flat'){
    /* AT THE DEPTH OF WHAT IS UNDER THE STROKE. Drawing an outline over
       existing work should put the sheet where that work is, not at the pivot
       behind it. Nothing under the finger falls back to the pivot plane. */
    P.refreshDrawPlane(depthUnder(x, y));
  }
  else if(role === 'guide' || !G.hasActive()) P.refreshDrawPlane();

  var first = (role === 'curve') ? projectSample(x, y)
                                 : planeOnly(x, y);
  if(!first) return;

  live = {
    role: role,
    screen: [{x:x, y:y, pressure:pressureOf(ev), tilt:tiltOf(ev)}],
    world:  [first.point.clone()],
    normals:[first.normal.clone()],
    sm: {x:x, y:y},
    stroke: (role === 'curve') ? newStroke() : null,
    mirror: null
  };
  P.camBasis(camRight, camUp, camFwd);
  if(live.stroke){
    live.stroke.seedRef = orientationAxis(live.screen[0].tilt.az, new THREE.Vector3()).clone();
    S.Live.begin(live.stroke);
    pushLivePoint(live.stroke, first.point, live.screen[0], first.normal, first.frame);
    S.Live.append(live.stroke);
    beginLiveMirror();
  }
  syncLive();
  armShapeHold();                    // curves, guide profiles and bend paths
};

/* one point record; `axis` is the tilt-derived cross-section hint that
   freezeFrames turns into a roll angle on commit */
function pushLivePoint(stroke, world, sample, normal, frame){
  stroke.pts.push({
    p: world.clone(), tan:null, ref:null, roll:0,
    pressure: sample.pressure,
    tiltAz: sample.tilt.az, tiltAlt: sample.tilt.alt,
    nrm: normal ? normal.clone() : null,
    /* where this point sits on the guide, so the nib can be trimmed to the
       surface's edge. Transient — freezeFrames spends it and drops it. */
    surf: frame || null,
    axis: orientationAxis(sample.tilt.az, new THREE.Vector3()).clone()
  });
}

function planeOnly(x, y){
  var p = P.planePoint(x, y, new THREE.Vector3());
  if(!p) return null;
  return { point:p, normal:P.cam().getWorldDirection(_v.clone()).negate(), onSurface:false };
}

Tools.extend = function(x, y, ev){
  if(!live) {
    if(TOOL.mode === 'erase' || TOOL.mode === 'vacuum') stepErase(x, y);
    else if(TOOL.mode === 'smooth') stepSmooth(x, y);
    else if(TOOL.mode === 'liquify') stepLiquify(x, y);
    else if(TOOL.mode === 'lasso')  stepLasso(x, y);
    return;
  }
  /* once the shape is frozen, the pen drives its parameters, not its samples */
  if(live.adjusting){ adjustShape(x, y); return; }

  /* FACT (C.2): Stable Stroke is a stabiliser on the input, adjustable. */
  var sx = x, sy = y;
  if(TOOL.stableOn){
    var k = 1 - P.clamp(TOOL.stable, 0, 0.95);
    live.sm.x += (x - live.sm.x) * k;
    live.sm.y += (y - live.sm.y) * k;
    sx = live.sm.x; sy = live.sm.y;
  } else { live.sm.x = x; live.sm.y = y; }

  var last = live.screen[live.screen.length-1];
  var dx = sx - last.x, dy = sy - last.y;
  if(dx*dx + dy*dy < MIN_PX*MIN_PX) return;

  var hit = (live.role === 'curve') ? projectSample(sx, sy) : planeOnly(sx, sy);
  if(!hit) return;

  var sample = {x:sx, y:sy, pressure:pressureOf(ev), tilt:tiltOf(ev)};
  live.screen.push(sample);
  live.world.push(hit.point.clone());
  live.normals.push(hit.normal.clone());
  if(live.stroke){
    pushLivePoint(live.stroke, hit.point, sample, hit.normal, hit.frame);
    S.Live.append(live.stroke);
    extendLiveMirror(hit.point, sample, hit.normal);
  }
  syncLive();
  armShapeHold();                        // the pen moved, so restart the clock
};

/* Curves stream straight into their growable buffer, so there is nothing left
   to sync; only the guide/bend preview polyline needs redrawing. */
function syncLive(){
  if(!live) return;
  if(live.role !== 'curve') P.previewPath(live.world, live.role);
}

/* FACT (C.10): live symmetry, so the other halves are visible while drawing.
   Each copy is its own incrementally built stroke rather than a fresh clone per
   sample — cloning re-allocated and rebuilt the whole mirrored tube on every
   pointermove. With radial symmetry there are now up to 2n-1 of them, so that
   difference matters a great deal more than it used to. */
var liveSym = [];
var _symPt = new THREE.Vector3();
var _symMat3 = new THREE.Matrix3();

function beginLiveMirror(){
  clearLiveMirror();
  if(!live || !live.stroke) return;
  var mats = S.symmetryOf(TOOL);
  if(!mats.length) return;
  var p0 = live.stroke.pts[0];
  for(var i=0;i<mats.length;i++){
    var m = mats[i];
    var ghost = newStroke();
    ghost.brush = live.stroke.brush;
    ghost.color = live.stroke.color.clone();
    ghost.baseRadius = live.stroke.baseRadius;
    ghost.opacity = live.stroke.opacity;
    ghost.pressureTarget = live.stroke.pressureTarget;
    ghost.seedRef = live.stroke.seedRef.clone()
      .applyMatrix3(_symMat3.setFromMatrix4(m).clone());
    liveSym.push({ stroke:ghost, m:m });
    S.Live.begin(ghost);
    pushSymPoint(liveSym[i], p0);
    S.Live.append(ghost);
  }
}

function extendLiveMirror(world, sample, normal){
  if(!liveSym.length) return;
  var src = { p:world, pressure:sample.pressure,
              tiltAz:sample.tilt.az, tiltAlt:sample.tilt.alt, nrm:normal };
  for(var i=0;i<liveSym.length;i++){
    pushSymPoint(liveSym[i], src);
    S.Live.append(liveSym[i].stroke);
  }
}

function pushSymPoint(entry, src){
  _symPt.copy(src.p).applyMatrix4(entry.m);
  entry.stroke.pts.push({
    p:_symPt.clone(), tan:null, ref:null, roll:0,
    pressure: src.pressure, tiltAz: src.tiltAz, tiltAlt: src.tiltAlt, nrm:null
  });
}

function clearLiveMirror(){
  for(var i=0;i<liveSym.length;i++) S.Live.discard(liveSym[i].stroke);
  liveSym.length = 0;
}

/* ==========================================================================
   Finishing a stroke
   ========================================================================== */
Tools.finish = function(){
  disarmShapeHold();
  if(TOOL.mode === 'erase' || TOOL.mode === 'vacuum'){ endErase(); return; }
  if(TOOL.mode === 'smooth'){ endSmooth(); return; }
  if(TOOL.mode === 'liquify'){ endLiquify(); return; }
  if(TOOL.mode === 'lasso'){ endLasso(); return; }
  if(!live) return;
  var l = live; live = null;
  clearLiveMirror();
  P.clearPreview();

  if(l.role === 'flat')   return finishFlatGuide(l);
  if(l.role === 'guide')  return finishGuide(l);
  if(l.role === 'bend')   return finishBend(l);
  return finishCurve(l);
};

Tools.cancel = function(){
  disarmShapeHold();
  if(live && live.stroke) S.Live.discard(live.stroke);
  clearLiveMirror();
  P.clearPreview();
  live = null;
  /* drag tools keep their own session state outside `live` */
  eraseSession = null;
  smoothSession = null;
  if(lasso){ lasso = null; P.clearLasso(); }
};

function finishCurve(l){
  clearLiveMirror();
  if(l.world.length === 0){ S.Live.discard(l.stroke); return; }

  /* FACT (C.9): Draw Shape auto-corrects to a straight line, a smooth curve or
     a perfect circle based on how close the input already is. */
  /* Already frozen and hand-adjusted by hold-to-shape — do not re-fit it.
     Not gated on the Shape tool: holding works while drawing normally too. */
  if(l.adjusting && l.shape){
    S.freezeFrames(l.stroke);
    S.rebuild(l.stroke);
    var made0 = [l.stroke];
    var sym0 = S.symmetryOf(TOOL);
    for(var s0=0;s0<sym0.length;s0++) made0.push(S.transformedCopy(l.stroke, sym0[s0]));
    P.History.run({
      label: 'draw shape', cost: P.History.costOf(made0),
      redo: function(){ for(var i=0;i<made0.length;i++) S.add(made0[i]); },
      undo: function(){ for(var i=0;i<made0.length;i++) S.remove(made0[i]); }
    });
    if(!P.VIEW.pinned) P.autoPivot();
    P.onSceneChange();
    return;
  }

  if(TOOL.mode === 'shape' && l.screen.length >= 3){
    var fitted = fitShapeScreen(l.screen);
    if(fitted){
      var world = [], normals = [], screen = [], frames = [];
      for(var i=0;i<fitted.pts.length;i++){
        var h = projectSample(fitted.pts[i].x, fitted.pts[i].y);
        if(!h) continue;
        world.push(h.point.clone());
        normals.push(h.normal.clone());
        frames.push(h.frame || null);
        screen.push({x:fitted.pts[i].x, y:fitted.pts[i].y,
                     pressure: l.screen[Math.min(i, l.screen.length-1)].pressure,
                     tilt: l.screen[Math.min(i, l.screen.length-1)].tilt});
      }
      if(world.length >= 2){
        /* the fitted shape replaces the raw samples wholesale */
        l.world = world; l.normals = normals; l.screen = screen;
        l.stroke.pts.length = 0;
        for(var k=0;k<world.length;k++) pushLivePoint(l.stroke, world[k], screen[k], normals[k], frames[k]);
      }
      P.toast('Shape: ' + fitted.kind);
    }
  }

  /* fill in what the platform did not report before the one exact rebuild */
  densifyCurve(l);
  S.dedupe(l.stroke);          // a clamped guide can hand back the same point twice

  /* hand off from the growable live buffer to one exact batch rebuild, so a
     stored stroke never carries the incremental path's numerical drift */
  S.Live.finish(l.stroke);

  var made = [l.stroke];
  var sym = S.symmetryOf(TOOL);
  for(var sy=0;sy<sym.length;sy++) made.push(S.transformedCopy(l.stroke, sym[sy]));

  P.History.run({
    label: 'draw', cost: P.History.costOf(made),
    redo: function(){ for(var i=0;i<made.length;i++) S.add(made[i]); },
    undo: function(){ for(var i=0;i<made.length;i++) S.remove(made[i]); }
  });
  if(!P.VIEW.pinned) P.autoPivot();
  P.onSceneChange();
}

/* the first thing the pointer is over: a curve, or a guide, or nothing */
function depthUnder(x, y){
  var r = P.rayFrom(x, y), hits = [];
  for(var i=0;i<S.list.length;i++){
    var st = S.list[i];
    if(st.mesh && S.visible(st)) hits.push(st.mesh);
  }
  for(i=0;i<G.resources.length;i++){
    if(G.resources[i].mesh) hits.push(G.resources[i].mesh);
  }
  if(G.active && G.active.mesh && hits.indexOf(G.active.mesh) < 0) hits.push(G.active.mesh);
  if(!hits.length) return null;
  var got = r.intersectObjects(hits, false);
  return got.length ? got[0].point.clone() : null;
}

function finishFlatGuide(l){
  if(l.world.length < 3){ P.toast('Draw a closed shape to make a flat guide'); return; }
  var viewDir = P.cam().getWorldDirection(new THREE.Vector3());
  P.camBasis(camRight, camUp, camFwd);
  var made = G.createFlatFromStroke(l.world, viewDir, camRight);
  if(!made){ P.toast('That shape encloses no area'); return; }
  var prev = G.active;
  P.History.run({
    label: 'create flat guide',
    redo: function(){ G.setActive(made); },
    undo: function(){ G.setActive(prev); }
  });
  P.toast('Flat guide created — draw on it, or Fill it');
  P.onSceneChange();
}

function finishGuide(l){
  if(l.world.length < 2){ return; }
  P.camBasis(camRight, camUp, camFwd);
  var viewDir = P.cam().getWorldDirection(new THREE.Vector3());
  var made = G.createFromStroke(l.world, viewDir, camRight, camUp);
  if(!made) return;
  var prev = G.active;
  P.History.run({
    label: 'create guide',
    redo: function(){ G.setActive(made); },
    undo: function(){ G.setActive(prev); }
  });
  P.toast('3D guide created — orbit and draw on it');
  P.onSceneChange();
}

function finishBend(l){
  if(l.world.length < 2) return;
  var guide = G.active;

  /* guides without a sweep — lofts, primitives, imported models — bend as a
     curve deform of their mesh instead of by replacing a path */
  if(!guide.sweep){
    var wasBent = guide.bendPath ? guide.bendPath.map(function(p){ return p.clone(); }) : null;
    /* A FLAT GUIDE STOPS BEING FLAT once it is bent. Drawing and trimming
       carry on working - both read the mesh's own parameterisation, which the
       deform moves but does not invalidate - but the analytic plane behind
       Fill would be describing a sheet that is no longer there, so it is given
       up rather than left to lie. Fill then declines on this guide, which is
       the honest answer until the sampler can walk a deformed sheet. */
    var wasPlane = guide.plane || null;
    if(!G.bendMesh(guide, l.world)) return;
    if(wasPlane) delete guide.plane;
    var nowBent = guide.bendPath.map(function(p){ return p.clone(); });
    P.History.run({
      label:'bend guide',
      redo: function(){ G.bendMesh(guide, nowBent); if(wasPlane) delete guide.plane; },
      undo: function(){
        if(wasBent) G.bendMesh(guide, wasBent);
        else G.unbendMesh(guide);
        if(wasPlane) guide.plane = wasPlane;
      }
    });
    P.onSceneChange();
    return;
  }

  var before = guide.sweep.path.map(function(p){ return p.clone(); });
  var beforeIdx = guide.sweep.anchorIndex;
  if(!G.bend(guide, l.world)) return;
  var after = guide.sweep.path.map(function(p){ return p.clone(); });
  P.History.run({
    label: 'bend guide',
    redo: function(){
      guide.sweep.path = after.map(function(p){ return p.clone(); });
      guide.sweep.anchorIndex = 0; G.rebuildSweep(guide);
    },
    undo: function(){
      guide.sweep.path = before.map(function(p){ return p.clone(); });
      guide.sweep.anchorIndex = beforeIdx; G.rebuildSweep(guide);
    }
  });
  P.onSceneChange();
}

/* ==========================================================================
   Draw Shape fitting, in screen space  (C.9)
   ========================================================================== */
function fitShapeScreen(screen){
  var pts2 = screen.map(function(s){ return {x:s.x, y:s.y}; });
  var span = 0, i;
  for(i=1;i<pts2.length;i++) span += Math.hypot(pts2[i].x-pts2[i-1].x, pts2[i].y-pts2[i-1].y);
  if(span < 12) return null;

  var closed = Math.hypot(pts2[0].x - pts2[pts2.length-1].x,
                          pts2[0].y - pts2[pts2.length-1].y) < span*0.22;

  var line = P.fitLine(pts2);
  if(line.ok && line.dev < 0.035){                    // GUESS: straightness gate
    return shapePoints({kind:'line', a:{x:line.a.x,y:line.a.y}, b:{x:line.b.x,y:line.b.y}});
  }

  if(closed){
    var circ = P.fitCircle(pts2);
    if(circ.ok && circ.dev < 0.14){                   // GUESS: roundness gate
      return shapePoints({kind:'circle', cx:circ.cx, cy:circ.cy, r:circ.r});
    }
  }

  /* otherwise: a smooth curve through the input */
  var v3 = pts2.map(function(p){ return new THREE.Vector3(p.x, p.y, 0); });
  var sm = P.smoothPolyline(v3, 6, 0.6);
  var re = P.resample(sm, Math.min(64, Math.max(8, sm.length)));
  return shapePoints({kind:'curve', bow:0,
                      base: re.map(function(p){ return {x:p.x, y:p.y}; })});
}

/* Turn shape parameters into screen points, and keep the parameters attached
   so hold-to-adjust can rewrite them without re-fitting. */
function shapePoints(shape){
  var out = [], i;
  if(shape.kind === 'line'){
    for(i=0;i<=32;i++){
      out.push({x: shape.a.x + (shape.b.x-shape.a.x)*(i/32),
                y: shape.a.y + (shape.b.y-shape.a.y)*(i/32)});
    }
  } else if(shape.kind === 'circle'){
    for(i=0;i<=64;i++){
      var a = (i/64)*Math.PI*2;
      out.push({x: shape.cx + Math.cos(a)*shape.r, y: shape.cy + Math.sin(a)*shape.r});
    }
  } else {
    /* bow the fitted curve by an even parabola along its length, so holding
       still leaves it untouched and dragging bends it smoothly */
    var b = shape.base, n = b.length;
    var ax = b[0].x, ay = b[0].y, bx = b[n-1].x, by = b[n-1].y;
    var dx = bx-ax, dy = by-ay, L = Math.hypot(dx,dy) || 1;
    var px = -dy/L, py = dx/L;
    for(i=0;i<n;i++){
      var u = i/(n-1), w = 4*u*(1-u)*(shape.bow || 0);
      out.push({x: b[i].x + px*w, y: b[i].y + py*w});
    }
  }
  shape.pts = out;
  return shape;
}

/* ==========================================================================
   Draw Shape: hold to adjust  (C.9)
   --------------------------------------------------------------------------
   FACT: "Hold after drawing to adjust length/endpoint (lines) or curvature
   (curves); press-hold-drag to size a circle." So: keep the pen down, stop
   moving, and the stroke snaps to its fitted shape — from then on the pen
   drives one parameter of that shape instead of adding samples.
   ========================================================================== */
var SHAPE_HOLD_MS = 420;                    // GUESS: the docs give no figure
var shapeHoldTimer = null;

/* A pen resting on glass wanders a pixel or two, and MIN_PX admits anything
   past 2px as travel. Every such sample used to restart the hold clock, so
   "hold the pen still" only ever fired for a perfectly steady hand. The clock
   now survives jitter inside this radius of wherever it started. */
var STILL_PX = 6;

/* The circle a bare press starts at, before the drag sizes it. Small enough
   that it reads as a seed rather than a shape you have to shrink. */
var SEED_R_PX = 8;
var holdAnchor = null;

/* Hold-to-shape is armed for anything drawn as a stroke — a curve, a guide
   profile, or a bend path. FACT (C.9): Draw Shape "also works to create/bend
   guides", and holding is how you reach it without switching tools. It is a
   deliberate pause with the pen still down, so it does not fire while you are
   moving, and it can be switched off entirely. */
var HOLD_ROLES = { curve:1, guide:1, bend:1, flat:1 };

function armShapeHold(){
  if(!TOOL.shapeHold) return;
  if(!live || !HOLD_ROLES[live.role]) return;
  var now = live.screen[live.screen.length-1];
  /* still inside the slop circle: the pen has not really moved, so let the
     clock that is already running keep running */
  if(shapeHoldTimer && holdAnchor &&
     Math.hypot(now.x - holdAnchor.x, now.y - holdAnchor.y) <= STILL_PX) return;
  holdAnchor = {x:now.x, y:now.y};
  clearTimeout(shapeHoldTimer);
  shapeHoldTimer = setTimeout(enterShapeAdjust, SHAPE_HOLD_MS);
}
function disarmShapeHold(){
  clearTimeout(shapeHoldTimer);
  shapeHoldTimer = null;
  holdAnchor = null;
}

/* how far the pen has actually travelled this stroke, in screen pixels */
function liveTravel(){
  var t = 0, sc = live.screen;
  for(var i=1;i<sc.length;i++) t += Math.hypot(sc[i].x-sc[i-1].x, sc[i].y-sc[i-1].y);
  return t;
}

function enterShapeAdjust(){
  shapeHoldTimer = null;
  if(!live || live.adjusting || !HOLD_ROLES[live.role]) return;

  var fitted = null;

  /* FACT (C.9): "press-hold-drag to size a circle". A press that never went
     anywhere has no shape to fit — there is nothing to auto-correct — so it
     seeds a circle on the spot and hands the drag straight to its radius.
     Only under the Shape tool: pausing to steady your hand before a normal
     stroke is ordinary, and turning that into a circle would ruin it. */
  if(TOOL.mode === 'shape' && liveTravel() <= STILL_PX){
    var a = live.screen[0];
    fitted = shapePoints({kind:'circle', cx:a.x, cy:a.y, r:SEED_R_PX});
  } else {
    if(live.screen.length < 3) return;
    fitted = fitShapeScreen(live.screen);
  }
  if(!fitted) return;
  live.adjusting = true;
  live.shape = fitted;
  /* leave the streaming buffer behind; adjusting rebuilds the whole stroke */
  if(live.stroke){
    S.Live.discard(live.stroke);
    clearLiveMirror();
  }
  applyShapePreview();

  var what = live.role === 'guide' ? ' profile'
           : live.role === 'bend'  ? ' sweep' : '';
  P.toast(fitted.kind === 'circle' ? ('Circle' + what + ' — drag to size it')
        : fitted.kind === 'line'   ? ('Straight' + what + ' — drag the end')
                                   : ('Smoothed' + what + ' — drag to bend it'));
}

function adjustShape(x, y){
  var sh = live.shape;
  if(sh.kind === 'line'){
    sh.b = {x:x, y:y};
  } else if(sh.kind === 'circle'){
    sh.r = Math.max(2, Math.hypot(x - sh.cx, y - sh.cy));
  } else {
    var b = sh.base, n = b.length;
    var ax = b[0].x, ay = b[0].y, bx = b[n-1].x, by = b[n-1].y;
    var dx = bx-ax, dy = by-ay, L = Math.hypot(dx,dy) || 1;
    var px = -dy/L, py = dx/L;
    var mx = (ax+bx)/2, my = (ay+by)/2;
    sh.bow = (x-mx)*px + (y-my)*py;         // signed distance from the chord
  }
  shapePoints(sh);
  applyShapePreview();
}

/* Rebuild the preview from the current shape. A curve becomes its tube again;
   a guide profile or bend path is only ever a polyline, so it just redraws. */
function applyShapePreview(){
  var sh = live.shape, world = [], normals = [], screen = [];
  var onGuide = (live.role === 'curve');
  var base = live.screen[0];

  for(var i=0;i<sh.pts.length;i++){
    /* guide and bend strokes are drawn on their plane, not projected onto the
       active guide — same rule as when the samples were first taken */
    var h = onGuide ? projectSample(sh.pts[i].x, sh.pts[i].y)
                    : planeOnly(sh.pts[i].x, sh.pts[i].y);
    if(!h) continue;
    world.push(h.point.clone());
    normals.push(h.normal.clone());
    screen.push({x:sh.pts[i].x, y:sh.pts[i].y, pressure:base.pressure, tilt:base.tilt});
  }
  if(world.length < 2) return;
  live.world = world; live.normals = normals; live.screen = screen;

  if(!live.stroke){
    P.previewPath(live.world, live.role);      // guide / bend
    return;
  }
  var st = live.stroke;
  st.pts.length = 0;
  for(var k=0;k<world.length;k++) pushLivePoint(st, world[k], screen[k], normals[k]);
  S.freezeFrames(st);
  S.rebuild(st);
}

/* ==========================================================================
   Erase / Vacuum  (C.6)
   ========================================================================== */
var eraseSession = null;

function beginErase(x, y){
  eraseSession = {removed:[], added:[]};
  stepErase(x, y);
}

function stepErase(x, y){
  if(!eraseSession) return;
  /* THE ERASER IS NOT THE BRUSH. It used to take the brush's radius, so
     picking a 90mm nib gave you a 90mm eraser and one tap took 36px of curve
     out — "it erases a good chunk". The cut itself is exact (measured: the arc
     removed equals the disc diameter to within a pixel at every size), so the
     fix is the size, not the maths. Erasing keeps its own, smaller default and
     the size control edits whichever of the two the active tool uses. */
  var rPx = Math.max(4, P.worldToPx(eraserRadius()));
  if(TOOL.mode === 'vacuum'){
    var killed = S.vacuumAt(x, y);
    for(var i=0;i<killed.length;i++) eraseSession.removed.push(killed[i]);
  } else {
    var res = S.eraseScreen(x, y, rPx);
    for(var a=0;a<res.removed.length;a++){
      /* a piece produced earlier in this same drag then re-cut: drop it from
         `added` instead of recording a phantom removal */
      var k = eraseSession.added.indexOf(res.removed[a]);
      if(k >= 0) eraseSession.added.splice(k,1);
      else eraseSession.removed.push(res.removed[a]);
    }
    for(var b=0;b<res.added.length;b++) eraseSession.added.push(res.added[b]);
  }
}

function endErase(){
  var e = eraseSession; eraseSession = null;
  if(!e || (e.removed.length === 0 && e.added.length === 0)) return;
  P.History.push({
    label: 'erase', cost: P.History.costOf(e.removed) + P.History.costOf(e.added),
    redo: function(){
      for(var i=0;i<e.removed.length;i++) S.remove(e.removed[i]);
      for(var j=0;j<e.added.length;j++)   S.add(e.added[j]);
    },
    undo: function(){
      for(var j=0;j<e.added.length;j++)   S.remove(e.added[j]);
      for(var i=0;i<e.removed.length;i++) S.add(e.removed[i]);
    }
  });
  P.onSceneChange();
}

/* ==========================================================================
   Smooth — a drag-on brush that relaxes the curves under the pen.
   --------------------------------------------------------------------------
   Stable Stroke (C.2) smooths input as it arrives; this is its after-the-fact
   counterpart, for a line that came out shaky. Points inside the brush are
   pulled toward the average of their neighbours, weighted by how central they
   are under the cursor, so the effect feathers instead of leaving a seam.
   ========================================================================== */
var smoothSession = null;
var _sm = {x:0, y:0, z:0};

/* ONE REBUILD PER FRAME, NOT ONE PER EVENT.
   Smooth and Liquify move points and then have to re-solve the frames and
   re-cut the mesh of every stroke they touched. Doing that inside the
   pointer handler rebuilt 173 meshes over a 40-move drag — four strokes
   per event — and a pen delivers several coalesced moves per frame, so the
   work piled up faster than it could be drawn.

   The maths reads and writes point POSITIONS, which stay eager, so nothing
   about the result changes: only the mesh that displays them is deferred,
   to the frame that is about to show it. */
/* OCCLUSION, ONCE PER POINT PER DRAG.
   G.isMasked answers "is the active guide between the camera and this point",
   and there is no spatial index behind it, so each test walks the guide. With
   a 300mm brush the smooth disc covers most of a model and every point in it
   is tested on every move: 7312 rays over one 40-move drag, 194ms, 97% of the
   tool's cost. The guide-side cache is keyed on position and a tool that MOVES
   points misses it by design.
   Neither the camera nor the guides move during a drag, and a smoothing pass
   shifts a point by a fraction of a millimetre, so the answer cannot change
   under us: it is worth having once, per point, for the life of the drag. */
var dragSeq = 0;
function beginMaskEpoch(){ dragSeq++; }
function maskedInDrag(pt){
  if(pt.maskSeq === dragSeq) return pt.masked;
  var m = P.Guides.isMasked(pt.p);
  pt.maskSeq = dragSeq; pt.masked = m;
  return m;
}

var dirtyStrokes = [];
function markDirty(st){
  if(dirtyStrokes.indexOf(st) < 0) dirtyStrokes.push(st);
}
/* A curve painted on a guide belongs to that surface. Smooth averages a point
   with its two neighbours, which cuts the corner off a curved surface, and
   Liquify pushes points bodily; both work in free space. Measured on a barrel
   guide, paint that started at 0.00mm off the surface ended up 6.4mm off after
   a Smooth pass and 47.7mm off after a Liquify one.

   Snapping the moved points back is exactly what the Clamp setting already
   promises while drawing — "strokes leaving the guide clamp to its nearest
   point" — applied to the tools that move them afterwards, and switched off
   with the same toggle. */
function reprojectToGuide(st){
  if(!G.clampOffSurface || !st || st.guide === null || st.guide === undefined) return;
  var g = G.byId(st.guide);
  /* an image guide is a plane a stroke cannot leave in the first place, and it
     opts out of clamping by name */
  if(!g || !g.mesh || g.noClamp) return;
  var ctx = G.snapContext(g);
  for(var i=0;i<st.pts.length;i++) G.snapToSurface(st.pts[i].p, g, st.pts[i].p, ctx);
}

P.flushDirtyStrokes = function(){
  if(!dirtyStrokes.length) return;
  for(var i=0;i<dirtyStrokes.length;i++){
    reprojectToGuide(dirtyStrokes[i]);
    S.freezeFrames(dirtyStrokes[i]);
    S.rebuild(dirtyStrokes[i]);
  }
  dirtyStrokes.length = 0;
};

/* ==========================================================================
   Liquify  (FACT: documented tool)
   --------------------------------------------------------------------------
   "Select the curves or sketches you want to modify and tap Liquify. Press and
   drag with your pen to liquify your curves or drawings." The panel carries a
   SIZE, a RANGE and a STRENGTH, each adjusted by sliding up or down, a mode
   you tap or drag to change, and an Apply button. The three documented modes:

     push   "distorts naturally, as if pushing or pulling with a finger"
     pinch  "distorts sharply and precisely, as if pinching. Useful for
             extending or shrinking specific curves"
     comb   "gently smooths and aligns as if combing", for straightening wavy
             curves, "works best when used with a rubbing motion"

   It works on the SELECTION, so it can be aimed: liquifying a face does not
   drag the wall behind it.

   INFERENCE — the parts the docs name but do not define:
     - size is the radius of the affected area, in screen pixels, because that
       is the space the hand works in and the same space Stable Stroke and the
       eraser use.
     - range is the softness of the falloff inside that radius. 0 concentrates
       everything at the centre; 100 spreads it evenly to the edge.
     - displacement happens in the CAMERA PLANE. A drag is two-dimensional, and
       pushing points along the view direction from a 2D gesture would be a
       guess about depth on every sample. Points keep their distance from the
       eye and move where the pen moved.
     - a liquified point leaves the guide it was drawn on. That is the point of
       the tool: the cube brush exists to be deformed afterwards.
   ========================================================================== */
var liquifySession = null;
var _lqP = new THREE.Vector3(), _lqD = new THREE.Vector3(),
    _lqR = new THREE.Vector3(), _lqU = new THREE.Vector3(), _lqScr = {x:0,y:0,z:0};

Tools.liquifyTargets = function(){
  var sel = S.selection.filter(function(st){ return S.visible(st); });
  return sel;
};

function beginLiquify(x, y){
  var targets = Tools.liquifyTargets();
  if(!targets.length){ P.toast('Select the curves to liquify first'); return; }
  liquifySession = {
    strokes: targets,
    before: targets.map(function(st){
      return st.pts.map(function(q){ return q.p.clone(); });
    }),
    last: {x:x, y:y},
    moved: false
  };
}

/* screen-space falloff: 1 at the centre, 0 at the rim, `range` deciding how
   much of the disc is at full strength */
function liquifyFalloff(d, r, range){
  if(d >= r) return 0;
  var t = 1 - d/r;
  var soft = P.clamp(range/100, 0, 1);
  /* range 100 -> a wide, gentle shoulder; range 0 -> a sharp spike */
  var k = 1 + (1 - soft) * 6;
  return Math.pow(t, k);
}

function stepLiquify(x, y){
  var s = liquifySession;
  if(!s) return;
  var cfg = TOOL.liquify;
  var dxPx = x - s.last.x, dyPx = y - s.last.y;
  var dragPx = Math.hypot(dxPx, dyPx);
  if(cfg.mode !== 'comb' && dragPx < 0.01) return;
  s.last.x = x; s.last.y = y;
  s.moved = true;

  var rPx = Math.max(8, cfg.size);
  var strength = P.clamp(cfg.strength/100, 0, 1);
  P.camBasis(_lqR, _lqU, _lqD);            // right, up, forward

  for(var i=0;i<s.strokes.length;i++){
    var st = s.strokes[i], pts = st.pts, touched = false;
    if(S.farFromDisc(st, x, y, rPx)) continue;
    for(var j=0;j<pts.length;j++){
      P.worldToScreen(pts[j].p, _lqScr);
      if(_lqScr.z < -1 || _lqScr.z > 1) continue;
      var d = Math.hypot(_lqScr.x - x, _lqScr.y - y);
      var w = liquifyFalloff(d, rPx, cfg.range);
      if(w <= 0) continue;

      var mx = 0, my = 0;
      if(cfg.mode === 'push'){
        mx = dxPx * w * strength;
        my = dyPx * w * strength;
      } else if(cfg.mode === 'pinch'){
        /* toward the cursor, by how far the pen moved — a squeeze rather than
           a shove, so a curve can be drawn in or stretched out */
        var toX = x - _lqScr.x, toY = y - _lqScr.y;
        var len = Math.hypot(toX, toY) || 1;
        var pull = Math.min(len, dragPx * w * strength);
        mx = toX/len * pull; my = toY/len * pull;
      } else {
        /* comb: pull each point toward the line its neighbours make, which is
           what straightens a wobble without moving the curve as a whole */
        if(j === 0 || j === pts.length-1) continue;
        var a = pts[j-1].p, b = pts[j+1].p;
        _lqP.copy(a).add(b).multiplyScalar(0.5).sub(pts[j].p);
        pts[j].p.addScaledVector(_lqP, w * strength * 0.5);
        touched = true;
        continue;
      }
      if(!mx && !my) continue;
      /* pixels -> world, in the plane facing the camera at this point's depth */
      var scale = P.pxToWorldAt(pts[j].p);   // depth-correct, so it tracks the pen
      pts[j].p.addScaledVector(_lqR, mx * scale)
              .addScaledVector(_lqU, -my * scale);
      touched = true;
    }
    if(touched) markDirty(st);
  }
}

/* Apply — the documented button, and also what leaving the tool does. One
   history step for the whole session, so a minute of pushing undoes at once
   rather than a hundred times. */
function endLiquify(){
  var s = liquifySession; liquifySession = null;
  P.flushDirtyStrokes();
  if(!s || !s.moved) return;
  var after = s.strokes.map(function(st){
    return st.pts.map(function(q){ return q.p.clone(); });
  });
  function apply(snap){
    for(var i=0;i<s.strokes.length;i++){
      var st = s.strokes[i];
      for(var j=0;j<st.pts.length && j<snap[i].length;j++) st.pts[j].p.copy(snap[i][j]);
      S.freezeFrames(st); S.rebuild(st);
    }
  }
  P.History.push({
    label:'liquify',
    redo: function(){ apply(after); },
    undo: function(){ apply(s.before); }
  });
  P.onSceneChange();
}
Tools.liquifyApply = function(){
  endLiquify();
  P.toast('Liquify applied');
};

function beginSmooth(x, y){
  beginMaskEpoch();
  smoothSession = { before: [], strokes: [] };
  stepSmooth(x, y);
}

function snapshotFor(session, st){
  if(session.strokes.indexOf(st) >= 0) return;
  session.strokes.push(st);
  session.before.push(st.pts.map(function(q){ return q.p.clone(); }));
}

function stepSmooth(x, y){
  if(!smoothSession) return;
  var rPx = Math.max(12, P.worldToPx(baseRadius()) * 3);
  var r2 = rPx*rPx;
  var avg = new THREE.Vector3();

  for(var i=0;i<S.list.length;i++){
    var st = S.list[i], pts = st.pts, n = pts.length;
    if(n < 3 || !S.visible(st)) continue;
    if(S.farFromDisc(st, x, y, rPx)) continue;
    var touched = false;
    /* one pass, endpoints pinned so the curve keeps its extent */
    for(var j=1;j<n-1;j++){
      P.worldToScreen(pts[j].p, _sm);
      if(_sm.z < -1 || _sm.z > 1) continue;
      var dx = _sm.x - x, dy = _sm.y - y, d2 = dx*dx + dy*dy;
      if(d2 > r2) continue;
      if(maskedInDrag(pts[j])) continue;
      if(!touched){ snapshotFor(smoothSession, st); touched = true; }
      var w = (1 - d2/r2) * 0.45;                   // GUESS: feels right by hand
      avg.copy(pts[j-1].p).add(pts[j+1].p).multiplyScalar(0.5);
      pts[j].p.lerp(avg, w);
    }
    if(touched) markDirty(st);
  }
}

function endSmooth(){
  var s = smoothSession; smoothSession = null;
  P.flushDirtyStrokes();
  if(!s || !s.strokes.length) return;
  var after = s.strokes.map(function(st){
    return st.pts.map(function(q){ return q.p.clone(); });
  });
  function apply(snap){
    for(var i=0;i<s.strokes.length;i++){
      var st = s.strokes[i];
      for(var j=0;j<st.pts.length && j<snap[i].length;j++) st.pts[j].p.copy(snap[i][j]);
      S.freezeFrames(st); S.rebuild(st);
    }
  }
  P.History.push({
    label:'smooth',
    redo: function(){ apply(after); },
    undo: function(){ apply(s.before); }
  });
  P.onSceneChange();
}

/* ==========================================================================
   Fill — coat a whole guide in one go
   --------------------------------------------------------------------------
   A bucket fill, for blocking in a large shape without dragging the nib back
   and forth across it fifty times.

   It lays down ORDINARY STROKES, one per row, rather than some new kind of
   filled object. That is the whole point: everything downstream already knows
   what a stroke is, so a fill can be erased, liquified, smoothed, bent,
   grouped, exported and undone like anything else you drew, and it picks up
   the current brush and colour because it IS the current brush.

   Rows, not one long snake. A serpentine path would turn 180 degrees at the
   end of every row, and a hairpin is precisely the case a swept cross-section
   cannot round: it is the fold that dedupe exists to delete. Parallel strokes
   avoid the question, and overlapping paint has read as one flat surface ever
   since the shading was taken from the guide.

   Spacing divides the crossing distance into a whole number of rows rather
   than stepping by a fixed nib width and leaving a remainder at the far edge.
   Rows sit half a pitch in from each edge, so the outermost nib hangs over by
   half its width and gets trimmed back to the boundary — the same trim a
   hand-painted edge stroke gets. */
/* finish a run of samples as a stroke, if it is long enough to be one */
function closeRun(run, into){
  if(run && run.pts.length >= 2){
    S.dedupe(run);
    S.freezeFrames(run);
    S.rebuild(run);
    into.push(run);
  }
  return null;
}

var FILL_OVERLAP = 0.9;      // rows this fraction of a nib apart, so no seams
var FILL_MAX_ROWS = 400;     // a runaway fill is a hang; refuse instead

Tools.fillGuide = function(guide){
  var g = guide || G.active;
  if(!g){ P.toast('Select a guide to fill'); return null; }
  var span = G.surfaceSpan(g);
  if(!span){ P.toast('This guide cannot be filled'); return null; }

  var proto = newStroke();
  var cfg = P.BRUSH[P.brushName(proto.brush)];
  var half = S.nibHalfWidth(proto, baseRadius() * cfg.wide);
  var pitch = Math.max(half * 2 * FILL_OVERLAP, 1e-5);

  /* run the strokes the LONG way, so a fill is a few long curves and not
     hundreds of stubs */
  var alongV  = span.Lv >= span.Lu;
  var lengthL = alongV ? span.Lv : span.Lu;
  var across  = alongV ? span.Lu : span.Lv;
  if(!(lengthL > P.EPS) || !(across > P.EPS)){ P.toast('This guide is too small to fill'); return null; }

  /* CEIL, NOT ROUND. Rounding down leaves a step wider than the nib and the
     rows stop touching: a 960mm guide under a 238mm nib rounded to 4 rows at
     240mm apart and left a 2mm groove down every seam. Rounding up can only
     make rows overlap more, which is invisible. */
  var rows = Math.max(1, Math.ceil(across / pitch));
  if(rows > FILL_MAX_ROWS){
    P.toast('Brush too fine to fill this guide — make it larger');
    return null;
  }
  var step = across / rows;

  /* follow the surface at its own resolution along the stroke; a flat guide
     has no grid to follow, so sample it every few millimetres instead - fine
     enough to cut a row cleanly where it crosses the outline */
  var nodes = alongV ? span.nv : span.nu;
  var steps = nodes >= 2 ? P.clamp(nodes, 2, 240)
                         : P.clamp(Math.ceil(lengthL / (2*P.MM)), 2, 240);

  var made = [], r, i;
  for(r=0; r<rows; r++){
    var lateral = (r + 0.5) * step;
    /* A ROW IS NOT ALWAYS ONE STROKE. Off a rectangle it is, but a drawn
       outline can be concave or pinched, and a row crossing the gap in a
       horseshoe leaves the shape and comes back. Skipping the missing samples
       would join the two halves with a stroke straight across the hole, so a
       row is broken into runs of consecutive samples that are actually on the
       surface, and each run becomes its own stroke. */
    var run = null;
    for(i=0; i<steps; i++){
      var along = lengthL * (i/(steps-1));
      var hit = G.sampleSurface(g, alongV ? lateral : along, alongV ? along : lateral);
      if(!hit){ run = closeRun(run, made); continue; }
      if(!run) run = newStroke();
      pushLivePoint(run, hit.point, {pressure:1, tilt:{az:null, alt:1}},
                    hit.normal, hit.frame);
    }
    closeRun(run, made);
  }
  if(!made.length){ P.toast('Nothing to fill'); return null; }

  P.History.run({
    label: 'fill', cost: P.History.costOf(made),
    redo: function(){ for(var k=0;k<made.length;k++) S.add(made[k]); },
    undo: function(){ for(var k=0;k<made.length;k++) S.remove(made[k]); }
  });
  P.toast('Filled with ' + made.length + (made.length === 1 ? ' stroke' : ' strokes'));
  P.onSceneChange();
  return made;
};

/* ==========================================================================
   Lasso select — drag a loop, take everything inside it
   ========================================================================== */
var lasso = null;

function beginLasso(x, y){
  beginMaskEpoch();                  // endLasso reads the same per-drag memo
  lasso = [{x:x, y:y}]; P.lassoPreview(lasso);
}

function stepLasso(x, y){
  if(!lasso) return;
  var last = lasso[lasso.length-1];
  if(Math.hypot(x-last.x, y-last.y) < 3) return;
  lasso.push({x:x, y:y});
  P.lassoPreview(lasso);
}

/* even-odd ray crossing */
function pointInPoly(px, py, poly){
  var inside = false;
  for(var i=0, j=poly.length-1; i<poly.length; j=i++){
    var xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    if(((yi>py) !== (yj>py)) && (px < (xj-xi)*(py-yi)/((yj-yi)||1e-12) + xi)) inside = !inside;
  }
  return inside;
}

function endLasso(){
  var poly = lasso; lasso = null;
  P.clearLasso();
  if(!poly || poly.length < 3) return;

  var before = S.selection.slice();
  var hits = [];
  for(var i=0;i<S.list.length;i++){
    var st = S.list[i], pts = st.pts, inside = 0, seen = 0;
    if(!S.visible(st)) continue;
    for(var j=0;j<pts.length;j++){
      P.worldToScreen(pts[j].p, _sm);
      if(_sm.z < -1 || _sm.z > 1) continue;
      if(maskedInDrag(pts[j])) continue;     // A.9 applies to select too
      seen++;
      if(pointInPoly(_sm.x, _sm.y, poly)) inside++;
    }
    /* majority inside, so a curve clipped by the loop edge is not grabbed */
    if(seen > 0 && inside/seen > 0.5) hits.push(st);
  }

  P.History.run({
    label:'lasso select',
    redo: function(){
      S.clearSelection();
      for(var k=0;k<hits.length;k++) S.setSelected(hits[k], true);
    },
    undo: function(){
      S.clearSelection();
      for(var k=0;k<before.length;k++) S.setSelected(before[k], true);
    }
  });
  P.toast(hits.length ? (S.selection.length + ' selected') : 'Nothing inside the loop');
  P.onSceneChange();
}

/* ==========================================================================
   Groups
   --------------------------------------------------------------------------
   The panel operations, all of them undoable — FACT (C.8) lists "add/delete
   group" among the things undo covers.

   `selectWithGroup` is gone on purpose. It made tapping any curve select every
   curve grouped with it, which was reasonable when grouping was rare and is
   wrong now that every curve is in a group by default: a tap would always take
   the whole layer. Selecting a group is now an explicit gesture — a long press
   on its row.
   ========================================================================== */
Tools.newGroup = function(name){
  var g = S.addGroup(name);
  var prevActive = S.activeGroup;
  P.History.run({
    label: 'add group',
    redo: function(){
      if(!S.findGroup(g.id)) S.insertGroup(g, 0);
      S.activeGroup = g.id;
    },
    undo: function(){ S.removeGroup(g.id); S.activeGroup = prevActive; S.ensureGroup(); }
  });
  P.onSceneChange();
  return g;
};

/* Deleting a group takes its curves with it, as a layer does. Undo puts both
   back — which is the reason this is not behind a confirmation dialog. */
Tools.deleteGroup = function(id){
  var g = S.findGroup(id);
  if(!g) return false;
  if(S.groups.length <= 1){ P.toast('A sketch needs at least one group'); return false; }
  var members = S.membersOf(id);
  var at = S.groups.indexOf(g);
  var prevActive = S.activeGroup;
  P.History.run({
    label: 'delete group', cost: P.History.costOf(members),
    redo: function(){
      for(var i=0;i<members.length;i++) S.remove(members[i]);
      S.removeGroup(id);
      if(S.activeGroup === id){ S.ensureGroup(); }
    },
    undo: function(){
      S.insertGroup(g, at);
      for(var i=0;i<members.length;i++) S.add(members[i]);
      S.activeGroup = prevActive;
    }
  });
  P.toast(members.length ? ('Deleted ' + g.name + ' and ' + members.length +
          (members.length === 1 ? ' curve' : ' curves')) : ('Deleted ' + g.name));
  P.onSceneChange();
  return true;
};

Tools.duplicateGroup = function(id){
  var g = S.findGroup(id);
  if(!g) return null;
  var at = S.groups.indexOf(g);
  var copy = { id: S.nextGroup++, name: g.name + ' copy', visible: g.visible };
  var members = S.membersOf(id).map(function(st){
    var c = S.clone(st); c.group = copy.id; return c;
  });
  P.History.run({
    label: 'duplicate group', cost: P.History.costOf(members),
    redo: function(){
      S.insertGroup(copy, at);
      for(var i=0;i<members.length;i++) S.add(members[i]);
      S.activeGroup = copy.id;
    },
    undo: function(){
      for(var i=0;i<members.length;i++) S.remove(members[i]);
      S.removeGroup(copy.id);
      S.activeGroup = id;
    }
  });
  P.toast('Duplicated ' + g.name);
  P.onSceneChange();
  return copy;
};

Tools.renameGroup = function(id, name){
  var g = S.findGroup(id);
  name = String(name || '').trim().slice(0, 40);
  if(!g || !name || name === g.name) return false;
  var was = g.name;
  P.History.run({
    label: 'rename group',
    redo: function(){ g.name = name; },
    undo: function(){ g.name = was; }
  });
  P.onSceneChange();
  return true;
};

Tools.setGroupVisible = function(id, on){
  var g = S.findGroup(id);
  if(!g || g.visible === !!on) return false;
  P.History.run({
    label: 'group visibility',
    redo: function(){ S.setGroupVisible(id, on); },
    undo: function(){ S.setGroupVisible(id, !on); }
  });
  P.onSceneChange();
  return true;
};

/* THE ARROW. Select curves on the canvas, tap a group's arrow, and they move
   there — the one gesture the panel exists for. */
Tools.assignSelection = function(id){
  var g = S.findGroup(id);
  if(!g) return 0;
  var sel = S.selection.filter(function(st){ return st.group !== id; });
  if(!sel.length){
    P.toast(S.selection.length ? ('Already in ' + g.name) : 'Select some curves first');
    return 0;
  }
  var prev = sel.map(function(st){ return st.group; });
  P.History.run({
    label: 'move to group',
    redo: function(){
      for(var i=0;i<sel.length;i++) sel[i].group = id;
      S.applyVisibility();
    },
    undo: function(){
      for(var i=0;i<sel.length;i++) sel[i].group = prev[i];
      S.applyVisibility();
    }
  });
  P.toast(sel.length + (sel.length === 1 ? ' curve' : ' curves') + ' moved to ' + g.name);
  P.onSceneChange();
  return sel.length;
};

/* Long press on a row. */
Tools.selectGroup = function(id){
  var g = S.findGroup(id);
  if(!g) return 0;
  S.clearSelection();
  var members = S.membersOf(id);
  if(!g.visible){
    P.toast(g.name + ' is hidden');
    return 0;
  }
  for(var i=0;i<members.length;i++) S.setSelected(members[i], true);
  P.toast(members.length ? (members.length + (members.length === 1 ? ' curve' : ' curves') +
          ' selected in ' + g.name) : (g.name + ' is empty'));
  P.onSceneChange();
  return members.length;
};

Tools.setActiveGroup = function(id){
  if(!S.findGroup(id)) return false;
  S.activeGroup = id;
  P.onSceneChange();
  return true;
};

/* The old Group / Ungroup buttons, restated: one makes a group out of what is
   selected, the other sends the selection back to the first group. */
Tools.groupSelection = function(){
  var sel = S.selection.slice();
  if(!sel.length){ P.toast('Select some curves first'); return; }
  var g = S.addGroup('Group ' + (S.groups.length + 1));
  var prev = sel.map(function(st){ return st.group; });
  var prevActive = S.activeGroup;
  P.History.run({
    label: 'group',
    redo: function(){
      if(!S.findGroup(g.id)) S.insertGroup(g, 0);
      for(var i=0;i<sel.length;i++) sel[i].group = g.id;
      S.activeGroup = g.id;
    },
    undo: function(){
      for(var i=0;i<sel.length;i++) sel[i].group = prev[i];
      S.removeGroup(g.id); S.activeGroup = prevActive; S.ensureGroup();
    }
  });
  P.toast(sel.length + ' curves moved into ' + g.name);
  P.onSceneChange();
};

/* "Duplicate symmetrically" from the selection action bar: copy the selection
   and reflect the copy, so one gesture gives you the matching half. Uses the
   live Mirror axis when one is set, otherwise X. */
Tools.duplicateMirrored = function(axis){
  var sel = S.selection.slice();
  if(!sel.length){ P.toast('Nothing selected'); return; }
  var ax = axis || TOOL.mirror || 'x';
  var copies = sel.map(function(st){ return S.mirroredCopy(st, ax); });
  P.History.run({
    label:'duplicate mirrored', cost: P.History.costOf(copies),
    redo: function(){
      S.clearSelection();
      for(var i=0;i<copies.length;i++){ S.add(copies[i]); S.setSelected(copies[i], true); }
    },
    /* put the original selection back — removing the copies deselects them,
       and landing on an empty selection after an undo is disorienting */
    undo: function(){
      for(var i=0;i<copies.length;i++) S.remove(copies[i]);
      S.clearSelection();
      for(i=0;i<sel.length;i++) S.setSelected(sel[i], true);
    }
  });
  P.toast('Mirrored ' + copies.length + ' across ' + ax.toUpperCase());
  P.onSceneChange();
};

/* FACT (C.8): copy is in the documented undo coverage. */
Tools.duplicateSelection = function(){
  var sel = S.selection.slice();
  if(!sel.length){ P.toast('Nothing selected'); return; }
  var offset = new THREE.Vector3();
  var right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
  P.camBasis(right, up, fwd);
  offset.copy(right).multiplyScalar(P.pxToWorld(24));

  var copies = sel.map(function(st){
    var c = S.clone(st);
    S.transform([c], new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));
    return c;
  });
  P.History.run({
    label:'duplicate', cost: P.History.costOf(copies),
    redo: function(){
      S.clearSelection();
      for(var i=0;i<copies.length;i++){ S.add(copies[i]); S.setSelected(copies[i], true); }
    },
    undo: function(){
      for(var i=0;i<copies.length;i++) S.remove(copies[i]);
      S.clearSelection();
      for(i=0;i<sel.length;i++) S.setSelected(sel[i], true);
    }
  });
  P.toast(copies.length + ' duplicated');
  P.onSceneChange();
};

/* ==========================================================================
   Eyedropper / Injector  (C.7)
   FACT: the Eyedropper samples colour; the Injector samples the broader brush
   properties.
   ========================================================================== */
function sample(x, y){
  var hit = S.hitTest(x, y);
  if(!hit){ P.toast('Nothing to sample'); return; }
  var st = hit.stroke;
  TOOL.color.copy(st.color);
  if(TOOL.mode === 'inject'){
    TOOL.brush = st.brush;
    TOOL.sizeMM = P.clamp(st.baseRadius*2/P.MM, T.brushMinMM, T.brushMaxMM);
    TOOL.opacity = st.opacity;
    TOOL.pressureTarget = st.pressureTarget === 'none' ? TOOL.pressureTarget : st.pressureTarget;
  }
  P.toast(TOOL.mode === 'inject' ? 'Brush sampled' : 'Colour sampled');
  P.onToolChange();
}

/* ==========================================================================
   Selection  (A.9 mask applies)
   ========================================================================== */
/* TAPPING ADDS. `additive` used to come from the shift key, which a tablet
   does not have, so every tap threw away what you had picked and there was no
   way to select two curves by tapping at all. A tap on a curve now toggles it
   in or out of the selection; a tap on empty space clears, which is the only
   gesture that needs to mean "start again". */
Tools.tapSelect = function(x, y, additive){
  if(additive === undefined) additive = true;
  var hit = S.hitTest(x, y);
  if(!hit){
    var had = S.selection.slice();
    if(had.length){
      P.History.run({
        label:'deselect',
        redo: function(){ S.clearSelection(); },
        undo: function(){ for(var i=0;i<had.length;i++) S.setSelected(had[i], true); }
      });
    }
    return null;
  }
  var st = hit.stroke, was = st.selected;
  var before = S.selection.slice();
  P.History.run({
    label:'select',
    redo: function(){
      if(!additive) S.clearSelection();
      /* one tap, one curve — the whole group is a long press on its row */
      S.setSelected(st, !was);
    },
    undo: function(){
      S.clearSelection();
      for(var i=0;i<before.length;i++) S.setSelected(before[i], true);
    }
  });
  /* FACT (B.8): selecting a curve aligns the view centre to it. */
  if(st.selected){
    P.VIEW.pinned = true;
    P.VIEW.pivot.copy(S.bounds([st]).getCenter(new THREE.Vector3()));
  }
  P.onSceneChange();
  return st;
};

/* SWEEPING PICKS UP EVERYTHING IT CROSSES.
   Tapping curve after curve is fine for two and tedious for twenty, and a
   selection is usually a run of neighbouring strokes - the ones you just drew.
   Dragging over them adds each in turn. It shares the tap's gesture: the press
   is a tap until it moves, and only then does this take over, so one gesture
   serves both without a mode to choose between them.

   Strokes are marked as they are crossed, for feedback, and the whole sweep is
   ONE history step - undoing a sweep should not walk back through it curve by
   curve. */
var sweepSel = null;

var SWEEP_STEP_PX = 4;

Tools.sweepSelect = function(x, y, origin){
  /* the sweep starts where the PRESS did, not where the first move landed:
     a curve sitting right under the finger at the start was otherwise the one
     stroke a sweep across four reliably missed */
  if(!sweepSel){
    sweepSel = { before: S.selection.slice(), added: [],
                 last: origin ? {x:origin.x, y:origin.y} : null };
  }
  /* ALONG THE SEGMENT, not just at the point. A pen crossing a thin curve
     covers it in a fraction of a frame: sampling only where the pointer landed
     picked up one stroke in four when sweeping across strokes a few pixels
     wide. Walking the gap between this sample and the last catches what the
     hand actually passed over. */
  var from = sweepSel.last || {x:x, y:y};
  var dx = x - from.x, dy = y - from.y;
  var steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / SWEEP_STEP_PX));
  for(var i=1;i<=steps;i++){
    var hit = S.hitTest(from.x + dx*(i/steps), from.y + dy*(i/steps));
    if(!hit) continue;
    var st = hit.stroke;
    if(!st.selected){
      S.setSelected(st, true);
      sweepSel.added.push(st);
      P.onSceneChange();
    }
  }
  sweepSel.last = {x:x, y:y};
  return sweepSel.added.length;
};

Tools.endSweepSelect = function(){
  var sw = sweepSel; sweepSel = null;
  if(!sw || !sw.added.length) return 0;
  var after = S.selection.slice();
  P.History.push({
    label: 'select',
    redo: function(){
      S.clearSelection();
      for(var i=0;i<after.length;i++) S.setSelected(after[i], true);
    },
    undo: function(){
      S.clearSelection();
      for(var i=0;i<sw.before.length;i++) S.setSelected(sw.before[i], true);
    }
  });
  P.onSceneChange();
  return sw.added.length;
};
Tools.sweepingSelection = function(){ return !!sweepSel; };

/* FACT (A.5): Select tool + long-press on the guide turns it translucent green
   and hands it to the joystick. */
Tools.longPressSelect = function(x, y){
  var g = G.pick(x, y);
  if(g){
    G.setSelected(g, !g.selected);
    if(g.selected) S.clearSelection();
    P.onSceneChange();
    return 'guide';
  }
  return null;
};

/* ==========================================================================
   Joystick transform  (D.1) — drives the selection, or the selected guide
   ========================================================================== */
var xform = null;

Tools.transformTarget = function(){
  if(G.active && G.active.selected) return {kind:'guide', guide:G.active};
  if(S.selection.length) return {kind:'strokes', strokes:S.selection.slice()};
  return null;
};

Tools.beginTransform = function(){
  var t = Tools.transformTarget();
  if(!t) return false;
  xform = { target:t, accum:new THREE.Matrix4() };
  if(t.kind === 'guide'){
    xform.start = {
      pos: t.guide.obj.position.clone(),
      quat: t.guide.obj.quaternion.clone(),
      scale: t.guide.obj.scale.clone()
    };
  }
  return true;
};

/* delta is a world-space matrix applied about the target's centre */
Tools.stepTransform = function(delta){
  if(!xform) return;
  var t = xform.target;
  if(t.kind === 'strokes'){
    S.transform(t.strokes, delta);
  } else {
    var g = t.guide;
    g.obj.applyMatrix4(delta);
    g.obj.updateMatrixWorld(true);
  }
  xform.accum.premultiply(delta);
};

Tools.endTransform = function(){
  if(!xform) return;
  var x = xform; xform = null;
  if(x.accum.equals(new THREE.Matrix4())) return;
  var inv = x.accum.clone().invert();
  var t = x.target;
  P.History.push({
    label:'transform',
    redo: function(){
      if(t.kind === 'strokes') S.transform(t.strokes, x.accum);
      else { t.guide.obj.applyMatrix4(x.accum); t.guide.obj.updateMatrixWorld(true); }
    },
    undo: function(){
      if(t.kind === 'strokes') S.transform(t.strokes, inv);
      else { t.guide.obj.applyMatrix4(inv); t.guide.obj.updateMatrixWorld(true); }
    }
  });
  if(t.kind === 'guide') G.bakeTransform(t.guide);
  P.onSceneChange();
};

Tools.transformCentre = function(){
  var t = Tools.transformTarget();
  if(!t) return null;
  if(t.kind === 'guide'){
    var b = new THREE.Box3().setFromObject(t.guide.obj);
    return b.isEmpty() ? null : b.getCenter(new THREE.Vector3());
  }
  var box = S.bounds(t.strokes);
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
};

/* ==========================================================================
   Loft staging  (A.7)
   ========================================================================== */
var loftSel = [];
Tools.loftPick = function(x, y){
  var hit = S.hitTest(x, y);
  if(!hit) return loftSel.length;
  var st = hit.stroke, i = loftSel.indexOf(st);
  if(i >= 0){ loftSel.splice(i,1); S.setSelected(st,false); }
  else { loftSel.push(st); S.setSelected(st,true); }
  Tools.loftPreview();
  return loftSel.length;
};
/* LOFT TAKES THE SELECTION YOU ALREADY MADE.
   It used to be the other way round - choose Loft, then pick curves with it -
   which meant the selection you had in hand was thrown away at the door and
   made again with a different tool. Entering Loft now adopts whatever is
   selected, so the order is the one you would expect: pick the curves, then
   say what to do with them. Tapping more curves still adds and removes them. */
Tools.loftAdopt = function(){
  if(loftSel.length) return loftSel.length;        // already staging
  var sel = S.selection.slice();
  if(sel.length < 2) return 0;
  for(var i=0;i<sel.length;i++) loftSel.push(sel[i]);
  Tools.loftPreview();
  return loftSel.length;
};

Tools.loftCount = function(){ return loftSel.length; };
Tools.loftClear = function(){
  for(var i=0;i<loftSel.length;i++) S.setSelected(loftSel[i], false);
  loftSel = [];
  if(P.stagedGuide){ G.dispose(P.stagedGuide); P.stagedGuide = null; }
};
Tools.loftPreview = function(tension){
  if(P.stagedGuide){ G.dispose(P.stagedGuide); P.stagedGuide = null; }
  if(loftSel.length < 2) return null;
  var g = G.loft(loftSel, tension === undefined ? P.loftTension : tension);
  if(g){ P.scene.add(g.obj); P.stagedGuide = g; }
  return g;
};
Tools.loftCommit = function(){
  var g = P.stagedGuide;
  if(!g) return false;
  P.scene.remove(g.obj);
  P.stagedGuide = null;
  var prev = G.active;
  for(var i=0;i<loftSel.length;i++) S.setSelected(loftSel[i], false);
  loftSel = [];
  P.History.run({
    label:'loft',
    redo: function(){ G.setActive(g); },
    undo: function(){ G.setActive(prev); }
  });
  P.onSceneChange();
  return true;
};

/* ==========================================================================
   Primitive staging  (A.8)
   ========================================================================== */
Tools.primPreview = function(kind, seg, taper){
  if(P.stagedGuide){
    var keep = P.stagedGuide.obj.matrix.clone();
    G.dispose(P.stagedGuide); P.stagedGuide = null;
    var g2 = G.primitive(kind, seg, taper);
    g2.obj.applyMatrix4(keep);
    P.scene.add(g2.obj);
    P.stagedGuide = g2;
    G.setSelected(g2, true);
    return g2;
  }
  var g = G.primitive(kind, seg, taper);
  P.scene.add(g.obj);
  P.stagedGuide = g;
  G.setSelected(g, true);
  return g;
};
Tools.primCommit = function(){
  var g = P.stagedGuide;
  if(!g) return false;
  P.scene.remove(g.obj);
  P.stagedGuide = null;
  G.setSelected(g, false);
  var prev = G.active;
  P.History.run({
    label:'primitive',
    redo: function(){ G.setActive(g); },
    undo: function(){ G.setActive(prev); }
  });
  P.onSceneChange();
  return true;
};
Tools.stagedCancel = function(){
  if(P.stagedGuide){ G.dispose(P.stagedGuide); P.stagedGuide = null; }
  Tools.loftClear();
  P.onSceneChange();
};

/* ==========================================================================
   Guide close / save, as undoable commands  (A.5)
   ========================================================================== */
Tools.closeGuide = function(){
  var g = G.active;
  if(!g) return;
  P.History.run({
    label:'close guide',
    redo: function(){ G.setActive(null); },
    undo: function(){ G.setActive(g); }
  });
  P.onSceneChange();
};
Tools.saveGuide = function(){
  var g = G.active;
  if(!g) return;
  P.History.run({
    label:'save guide',
    redo: function(){ G.save(g); },
    undo: function(){
      var i = G.resources.indexOf(g);
      if(i>=0) G.resources.splice(i,1);
      G.setActive(g);
    }
  });
  P.toast('Saved to resources');
  P.onSceneChange();
};
/* ==========================================================================
   References
   --------------------------------------------------------------------------
   Bringing a picture in makes a place to draw ON it and a place to put what
   you draw: the reference becomes the active guide, and a curve group named
   after the file becomes the active group, so tracing lands in its own layer
   instead of piling into whatever happened to be open.

   It also joins the resource list, which it did not before — an imported
   reference was active but unlisted, so there was nothing to hide it by, name
   it by, or throw it away by.

   All of it is one history step: one undo takes the picture and its empty
   layer back out together.
   ========================================================================== */
Tools.addReference = function(guide){
  if(!guide) return null;
  var prevGuide = G.active, prevGroup = S.activeGroup;
  var prevAt = G.resources.indexOf(prevGuide);
  var grp = S.addGroup(guide.name);
  var at = -1;
  P.History.run({
    label: 'import reference',
    redo: function(){
      if(!S.findGroup(grp.id)) S.insertGroup(grp, 0);
      S.activeGroup = grp.id;
      at = G.resources.length;
      /* it is on screen and you are looking at it, so the row's eye has to say
         so — `visible` is what that eye reads, and only the save path used to
         set it */
      guide.visible = true;
      G.restore(guide, at, true);
    },
    undo: function(){
      G.remove(guide);
      if(prevGuide) G.restore(prevGuide, prevAt, true);
      S.removeGroup(grp.id);
      S.activeGroup = prevGroup;
      S.ensureGroup();
    }
  });
  P.onSceneChange();
  return grp;
};

/* Deleting a reference takes the picture, not the drawing. Whatever you traced
   onto it keeps its own group and stays exactly where it is — losing the work
   along with the scaffold is never what the tap meant. */
Tools.deleteResource = function(guide){
  if(!guide) return false;
  var at = G.resources.indexOf(guide);
  var wasActive = (G.active === guide);
  if(at < 0 && !wasActive) return false;
  P.History.run({
    label: 'delete reference',
    redo: function(){ G.remove(guide); },
    undo: function(){ G.restore(guide, at, wasActive); }
  });
  P.onSceneChange();
  return true;
};

Tools.activateResource = function(guide){
  var prev = G.active;
  P.History.run({
    label:'use guide',
    redo: function(){ G.setActive(guide); },
    undo: function(){ G.setActive(prev); }
  });
  P.onSceneChange();
};

Tools.isDrawing = function(){ return !!live; };
Tools.liveRole  = function(){ return live ? live.role : null; };
/* true once Draw Shape has frozen the stroke and the pen is steering the
   shape's parameters rather than adding samples (C.9) */
Tools.isAdjustingShape = function(){ return !!(live && live.adjusting); };
Tools.liveShape = function(){ return live ? live.shape : null; };

})(window.P);
