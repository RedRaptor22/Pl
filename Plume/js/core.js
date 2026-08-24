/* ==========================================================================
   PLUME / core.js — namespace, units, math, history.
   Loaded as a plain script (no modules) so plume.html still opens from file://.
   --------------------------------------------------------------------------
   UNITS: 1 world unit = 1000 mm. That is Feather's documented grid unit
   (support docs, Environment Tab), and every "mm" number in the UI is
   converted through P.MM so the spec's figures (10-500mm focal length, 1mm
   minimum brush) map onto world space directly.
   ========================================================================== */
window.P = window.P || {};
(function(P){
'use strict';

P.EPS = 1e-9;
P.MM  = 0.001;                 // millimetres -> world units

/* Tunables the spec explicitly leaves undocumented. Every one of these is a
   guess; they are collected here so they are easy to find and re-tune.
   (Spec "Caveats": extrusion depth, guide symmetry, section-line density,
   guide transparency, default FOV, transition durations, zoom clamps and undo
   depth are all unpublished.) */
P.TUNE = {
  guideDepthFactor : 1.5,      // GUESS: extrusion half-depth = 1.5x profile extent
  guideDepthMin    : 0.6,      // GUESS: world units
  guideDepthMax    : 40,       // GUESS: keeps the guide inside the 40-unit grid
  guideDepthOfView : 0.35,     // GUESS: ...but at least this fraction of orbit radius
  guideDepthFront  : 0.12,     // GUESS: fraction of the depth extruded TOWARD the
                               //        camera, so the orange starting edge sits at
                               //        one side of the surface, as documented
  guideGridStep    : 0.25,     // GUESS: section line every 250 mm
  guideOpacityMax  : 0.92,     // FACT: "cannot be made completely opaque"
  guideOpacityInit : 0.42,     // GUESS
  guideProfileSeg  : 96,       // profile resampling for the surface mesh
  guidePathSeg     : 64,       // sweep-path resampling
  viewSnapMs       : 340,      // GUESS: spec suggests ~300-400ms
  focalMin         : 10,       // FACT: 10mm-500mm
  focalMax         : 500,
  focalDefault     : 50,       // GUESS: default FOV is unpublished. The spec infers
                               //        ~100mm from the grid's 100m focal reference,
                               //        but that reference is a distance, not a lens —
                               //        50mm frames a 1m sketch without flattening it
  radiusDefault    : 4,        // GUESS: ~4m back, which frames a sketch a metre or two
                               //        across and keeps mm brush sizes legible
  sensorHeightMM   : 24,       // 35mm-format sensor height, for focal -> fov
  radiusMin        : 0.25,     // GUESS: zoom clamps are unpublished
  radiusMax        : 400,
  undoDepth        : 200,      // GUESS: undo depth is unpublished
  undoPointBudget  : 400000,   // GUESS: ~400k retained points (~20 MB of point
                               //        records) before the oldest steps are
                               //        dropped, so a long session cannot grow
                               //        the history without bound
  brushMinMM       : 1,        // FACT: minimum brush size changed 5mm -> 1mm
  brushMaxMM       : 300      // FACT: the brush panel runs 1mm - 300mm
};

/* ---- small vector scratch ------------------------------------------------ */
var _a = new THREE.Vector3();

P.perpTo = function(t, out){
  var ax = Math.abs(t.x) < 0.9 ? _a.set(1,0,0) : _a.set(0,1,0);
  out.crossVectors(t, ax);
  if(out.lengthSq() < P.EPS) out.set(1,0,0); else out.normalize();
  return out;
};

/* Tangents by central difference, with fallbacks for coincident points. */
P.computeTangents = function(pts){
  var n = pts.length, T = new Array(n), i, v = new THREE.Vector3();
  if(n === 1){ T[0] = new THREE.Vector3(0,0,1); return T; }
  var back = new THREE.Vector3(), fwd = new THREE.Vector3();
  for(i=0;i<n;i++){
    if(i===0)        v.subVectors(pts[1],     pts[0]);
    else if(i===n-1) v.subVectors(pts[n-1],   pts[n-2]);
    else {
      /* THE BISECTOR OF THE TWO UNIT CHORDS, not the chord p[i+1]-p[i-1].
         Clamping samples onto a guide bunches them: a stroke painted across a
         narrow guide came back with steps of 2.5mm, 1.7mm, 0.75mm, 0.4mm, and
         at that last one the span p[i+1]-p[i-1] measured 0.35mm - SHORTER than
         either step either side of it, because the path doubles back inside a
         single sample. The central difference then points backwards, the ring
         built on it is inside out, and a wide nib turns that into a plate of
         paint standing off the surface at a wild angle.
         Averaging the two chords as unit vectors weights them equally however
         uneven the spacing, and can only fail on an exact 180 degree hairpin -
         where carrying on forwards is the sane answer anyway. */
      back.subVectors(pts[i], pts[i-1]);
      fwd.subVectors(pts[i+1], pts[i]);
      var lb = back.lengthSq(), lf = fwd.lengthSq();
      if(lb > P.EPS && lf > P.EPS){
        back.multiplyScalar(1/Math.sqrt(lb));
        fwd.multiplyScalar(1/Math.sqrt(lf));
        v.addVectors(back, fwd);
        if(v.lengthSq() <= P.EPS) v.copy(fwd);
      }
      else if(lf > P.EPS) v.copy(fwd);
      else if(lb > P.EPS) v.copy(back);
      else v.set(0,0,0);
    }
    if(v.lengthSq() > P.EPS){ T[i] = v.clone().normalize(); continue; }
    if(T[i-1]){ T[i] = T[i-1].clone(); continue; }
    var found = null;
    for(var j=i+1;j<n && !found;j++){
      v.subVectors(pts[j], pts[i]);
      if(v.lengthSq() > P.EPS) found = v.clone().normalize();
    }
    T[i] = found || new THREE.Vector3(0,0,1);
  }
  return T;
};

/* Rotation-minimising frames by double reflection (Wang et al. 2008).
   Used for stroke cross-sections AND as the parallel-transport sweep behind
   Bend, so a profile carried round a curve does not twist. */
P.transportFrames = function(pts, seedRef){
  var T = P.computeTangents(pts), n = pts.length, R = new Array(n);
  var r0 = new THREE.Vector3();
  if(seedRef){
    r0.copy(seedRef).addScaledVector(T[0], -seedRef.dot(T[0]));
    if(r0.lengthSq() < P.EPS) P.perpTo(T[0], r0); else r0.normalize();
  } else P.perpTo(T[0], r0);
  R[0] = r0;

  var v1=new THREE.Vector3(), v2=new THREE.Vector3(),
      rL=new THREE.Vector3(), tL=new THREE.Vector3(), rN=new THREE.Vector3();

  for(var i=0;i<n-1;i++){
    v1.subVectors(pts[i+1], pts[i]);
    var c1 = v1.lengthSq();
    if(c1 < P.EPS){
      rN.copy(R[i]);
    } else {
      rL.copy(R[i]).addScaledVector(v1, -2*v1.dot(R[i])/c1);
      tL.copy(T[i]).addScaledVector(v1, -2*v1.dot(T[i])/c1);
      v2.subVectors(T[i+1], tL);
      var c2 = v2.lengthSq();
      rN.copy(rL);
      if(c2 >= P.EPS) rN.addScaledVector(v2, -2*v2.dot(rL)/c2);
    }
    var r = rN.clone().addScaledVector(T[i+1], -rN.dot(T[i+1]));
    if(r.lengthSq() < P.EPS) P.perpTo(T[i+1], r); else r.normalize();
    R[i+1] = r;
  }
  return {T:T, R:R};
};

/* ---- polyline helpers ---------------------------------------------------- */
P.arcLengths = function(pts){
  var L = [0];
  for(var i=1;i<pts.length;i++) L.push(L[i-1] + pts[i].distanceTo(pts[i-1]));
  return L;
};
P.polyLength = function(pts){ var L = P.arcLengths(pts); return L[L.length-1]; };

/* Uniform arc-length resampling. Returns n fresh Vector3s. */
P.resample = function(pts, n){
  if(pts.length === 0) return [];
  var out = [], i;
  if(pts.length === 1){
    for(i=0;i<n;i++) out.push(pts[0].clone());
    return out;
  }
  var L = P.arcLengths(pts), total = L[L.length-1], j = 0;
  if(total < P.EPS){
    for(i=0;i<n;i++) out.push(pts[0].clone());
    return out;
  }
  for(i=0;i<n;i++){
    var target = total * (i/(n-1));
    while(j < L.length-2 && L[j+1] < target) j++;
    var span = L[j+1] - L[j];
    var t = span < P.EPS ? 0 : (target - L[j]) / span;
    out.push(pts[j].clone().lerp(pts[j+1], t));
  }
  return out;
};

/* Chaikin-style smoothing with endpoints pinned. Behind Stable Stroke and the
   curve branch of Draw Shape. */
P.smoothPolyline = function(pts, iterations, strength){
  var cur = pts.map(function(p){ return p.clone(); });
  var s = (strength === undefined) ? 0.5 : strength;
  for(var it=0; it<iterations; it++){
    if(cur.length < 3) break;
    var next = [cur[0].clone()];
    for(var i=1;i<cur.length-1;i++){
      var avg = cur[i-1].clone().add(cur[i+1]).multiplyScalar(0.5);
      next.push(cur[i].clone().lerp(avg, s));
    }
    next.push(cur[cur.length-1].clone());
    cur = next;
  }
  return cur;
};

/* Cardinal spline segment. `tension` 0 = sharp (piecewise linear), 1 = smooth.
   This is the interpolator behind Loft's tension slider. */
P.catmullRom = function(p0, p1, p2, p3, t, tension){
  var tn = (tension === undefined) ? 1 : tension;
  var t2 = t*t, t3 = t2*t;
  var m1 = p2.clone().sub(p0).multiplyScalar(0.5*tn);
  var m2 = p3.clone().sub(p1).multiplyScalar(0.5*tn);
  var out = p1.clone().multiplyScalar(2*t3 - 3*t2 + 1);
  out.addScaledVector(m1, t3 - 2*t2 + t);
  out.addScaledVector(p2, -2*t3 + 3*t2);
  out.addScaledVector(m2, t3 - t2);
  return out;
};

/* Sample a chain of control points with the cardinal spline, clamping ends. */
P.sampleChain = function(ctrl, samples, tension){
  var n = ctrl.length, out = [], i;
  if(n === 0) return out;
  if(n === 1){ for(i=0;i<samples;i++) out.push(ctrl[0].clone()); return out; }
  var segs = n - 1;
  for(i=0;i<samples;i++){
    var u = (i/(samples-1)) * segs;
    var s = Math.min(segs-1, Math.floor(u));
    var t = u - s;
    out.push(P.catmullRom(ctrl[Math.max(0,s-1)], ctrl[s],
                          ctrl[s+1], ctrl[Math.min(n-1,s+2)], t, tension));
  }
  return out;
};

/* ---- shape recognition (Draw Shape) --------------------------------------
   All three fitters work in the 2D basis of the drawing plane; the caller
   converts back to world. pts2 = [{x,y}]. Each returns a normalised
   deviation so the caller can pick the best fit by one threshold.          */

P.fitLine = function(pts2){
  var a = pts2[0], b = pts2[pts2.length-1];
  var dx = b.x-a.x, dy = b.y-a.y, len = Math.hypot(dx,dy);
  if(len < P.EPS) return {ok:false};
  var maxDev = 0;
  for(var i=0;i<pts2.length;i++){
    var d = Math.abs((pts2[i].x-a.x)*dy - (pts2[i].y-a.y)*dx) / len;
    if(d > maxDev) maxDev = d;
  }
  return {ok:true, a:a, b:b, len:len, dev:maxDev/len};
};

/* Algebraic (Kasa) circle fit — closed form, no iteration. */
P.fitCircle = function(pts2){
  var n = pts2.length, i;
  if(n < 8) return {ok:false};
  var sx=0, sy=0;
  for(i=0;i<n;i++){ sx+=pts2[i].x; sy+=pts2[i].y; }
  var mx=sx/n, my=sy/n;
  var suu=0,suv=0,svv=0,suuu=0,svvv=0,suvv=0,svuu=0;
  for(i=0;i<n;i++){
    var u=pts2[i].x-mx, v=pts2[i].y-my;
    suu+=u*u; svv+=v*v; suv+=u*v;
    suuu+=u*u*u; svvv+=v*v*v; suvv+=u*v*v; svuu+=v*u*u;
  }
  var det = 2*(suu*svv - suv*suv);
  if(Math.abs(det) < P.EPS) return {ok:false};
  var uc = ( svv*(suuu+suvv) - suv*(svvv+svuu) ) / det;
  var vc = ( suu*(svvv+svuu) - suv*(suuu+suvv) ) / det;
  var cx = uc+mx, cy = vc+my, r = 0;
  for(i=0;i<n;i++) r += Math.hypot(pts2[i].x-cx, pts2[i].y-cy);
  r /= n;
  if(r < P.EPS) return {ok:false};
  var dev = 0;
  for(i=0;i<n;i++) dev = Math.max(dev, Math.abs(Math.hypot(pts2[i].x-cx, pts2[i].y-cy) - r));
  return {ok:true, cx:cx, cy:cy, r:r, dev:dev/r};
};

/* ---- undo / redo ---------------------------------------------------------
   One flat stack of {label, undo, redo}. Feather's documented coverage is
   draw, erase, attribute change, group add/delete, copy, transform, selection,
   guide close and joystick transforms — so every mutating op here pushes.  */
P.History = {
  stack: [],
  idx: 0,                                  // number of applied commands
  listeners: [],
  cost: 0,                                 // retained points across the stack

  /* An undo step keeps whole stroke records alive, so depth alone is a poor
     bound — 200 steps of one dot costs nothing, 200 steps holding thousand-
     point strokes is tens of megabytes. Commands declare what they retain and
     the oldest are dropped once the budget is passed. */
  costOf: function(strokes){
    var n = 0;
    if(!strokes) return 0;
    for(var i=0;i<strokes.length;i++) n += strokes[i].pts ? strokes[i].pts.length : 0;
    return n;
  },

  push: function(cmd){
    for(var i=this.idx;i<this.stack.length;i++) this.cost -= (this.stack[i].cost||0);
    this.stack.length = this.idx;          // drop the redo tail
    this.stack.push(cmd);
    this.cost += (cmd.cost||0);
    while(this.stack.length > 1 &&
          (this.stack.length > P.TUNE.undoDepth || this.cost > P.TUNE.undoPointBudget)){
      this.cost -= (this.stack.shift().cost||0);
    }
    this.idx = this.stack.length;
    this.notify();
  },
  run: function(cmd){ cmd.redo(); this.push(cmd); },
  canUndo: function(){ return this.idx > 0; },
  canRedo: function(){ return this.idx < this.stack.length; },
  undo: function(){
    if(!this.canUndo()) return false;
    this.stack[--this.idx].undo();
    this.notify(); return true;
  },
  redo: function(){
    if(!this.canRedo()) return false;
    this.stack[this.idx++].redo();
    this.notify(); return true;
  },
  clear: function(){ this.stack.length = 0; this.idx = 0; this.cost = 0; this.notify(); },
  notify: function(){
    for(var i=0;i<this.listeners.length;i++) this.listeners[i](this);
  }
};

/* ---- misc ---------------------------------------------------------------- */
P.clamp = function(v,a,b){ return v<a?a:(v>b?b:v); };
P.easeInOut = function(t){ return t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; };
P.uid = (function(){ var i=0; return function(){ return ++i; }; })();

})(window.P);
