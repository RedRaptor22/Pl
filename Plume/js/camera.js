/* ==========================================================================
   PLUME / camera.js — renderer, scene, dual camera, navigation, environment.
   --------------------------------------------------------------------------
   Camera model is spherical about a pivot, plus a roll angle so two-finger
   twist can rotate the canvas. Both a perspective and an orthographic camera
   are kept alive and swapped on demand (three-finger double-tap); the ortho
   frustum is sized to match the perspective framing at the pivot distance, so
   the toggle does not appear to jump.

   FOV is expressed the way Feather expresses it: as a lens focal length in
   millimetres, 10-500mm (FACT), converted against a 24mm sensor height.
   ========================================================================== */
(function(P){
'use strict';

var T = P.TUNE;

/* ---- renderer / scene ---------------------------------------------------- */
var elStage = document.getElementById('stage');
P.elStage = elStage;

var renderer = new THREE.WebGLRenderer({
  canvas: elStage, antialias:true, alpha:false, preserveDrawingBuffer:true
});
P.renderer = renderer;

var scene = new THREE.Scene();
P.scene = scene;

/* ---- cameras ------------------------------------------------------------- */
var persp = new THREE.PerspectiveCamera(45, 1, 0.02, 8000);
var ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -4000, 8000);

var VIEW = {
  pivot : new THREE.Vector3(0,0,0),
  theta : Math.PI*0.25,        // azimuth
  phi   : Math.PI*0.42,        // polar, clamped away from the poles
  radius: T.radiusDefault,
  roll  : 0,
  pinned: false,               // true once press-and-hold pins the pivot
  focal : T.focalDefault,      // mm
  ortho : false
};
P.VIEW = VIEW;

P.cam = function(){ return VIEW.ortho ? ortho : persp; };

/* focal length (mm) -> vertical fov (deg), 35mm-format sensor height */
function fovFromFocal(mm){
  return 2 * Math.atan(T.sensorHeightMM / (2*mm)) * 180/Math.PI;
}
P.fovFromFocal = fovFromFocal;

/* The canvas rect — NOT window.innerWidth/innerHeight. Those two can disagree
   (browser zoom, visual-viewport scaling), and pointer events report client
   coordinates, which are in the rect's space. Everything that converts between
   pixels and world units goes through here so the two can never drift apart. */
function viewport(){
  var r = elStage.getBoundingClientRect();
  return {left:r.left, top:r.top, w:Math.max(1, r.width), h:Math.max(1, r.height)};
}
P.viewport = viewport;

/* world height covered by the viewport at the pivot's depth */
function viewHeight(){
  return 2 * Math.tan(fovFromFocal(VIEW.focal)*Math.PI/360) * VIEW.radius;
}
P.viewHeight = viewHeight;

/* pixels -> world units at the pivot's depth, so brush size stays perceptual */
P.pxToWorld = function(px){ return px * (viewHeight() / viewport().h); };
P.worldToPx = function(w){  return w  * (viewport().h / viewHeight()); };

/* Pixels -> world units AT A GIVEN POINT, rather than at the pivot. Under
   perspective a pixel covers more world the further away it is, so a drag that
   must follow the pen — Liquify — needs the scale where the point actually is.
   Orthographic has no such falloff and returns the pivot scale. */
var _pxFwd = new THREE.Vector3(), _pxOff = new THREE.Vector3();
P.pxToWorldAt = function(p){
  var h = viewport().h;
  if(VIEW.ortho) return viewHeight() / h;
  var cam = P.cam();
  cam.getWorldDirection(_pxFwd);
  _pxOff.set(p.x - cam.position.x, p.y - cam.position.y, p.z - cam.position.z);
  var d = Math.abs(_pxFwd.dot(_pxOff));          // depth along the view axis
  if(!(d > 1e-6)) d = VIEW.radius;
  return 2 * Math.tan(fovFromFocal(VIEW.focal)*Math.PI/360) * d / h;
};

/* world point -> client coordinates, directly comparable to clientX/clientY */
var _sp = new THREE.Vector3();
P.worldToScreen = function(p, out){
  _sp.copy(p).project(P.cam());
  var v = viewport();
  out = out || {};
  out.x = v.left + ( _sp.x*0.5 + 0.5) * v.w;
  out.y = v.top  + (-_sp.y*0.5 + 0.5) * v.h;
  out.z = _sp.z;                                  // NDC depth: outside [-1,1] = off-frustum
  return out;
};

var _e = new THREE.Vector3();

function applyCamera(){
  VIEW.phi    = P.clamp(VIEW.phi, 0.0025, Math.PI-0.0025);
  VIEW.radius = P.clamp(VIEW.radius, T.radiusMin, T.radiusMax);
  VIEW.focal  = P.clamp(VIEW.focal, T.focalMin, T.focalMax);

  var sp = Math.sin(VIEW.phi);
  _e.set(
    VIEW.pivot.x + VIEW.radius*sp*Math.sin(VIEW.theta),
    VIEW.pivot.y + VIEW.radius*Math.cos(VIEW.phi),
    VIEW.pivot.z + VIEW.radius*sp*Math.cos(VIEW.theta)
  );

  var fov = fovFromFocal(VIEW.focal);
  persp.fov = fov;
  persp.position.copy(_e);
  persp.up.set(0,1,0);
  persp.lookAt(VIEW.pivot);
  if(VIEW.roll) persp.rotateZ(VIEW.roll);
  persp.updateProjectionMatrix();
  persp.updateMatrixWorld();

  /* ortho mirrors the perspective pose exactly; only the projection differs */
  var h = viewHeight()/2, w = h * persp.aspect;
  ortho.left = -w; ortho.right = w; ortho.top = h; ortho.bottom = -h;
  ortho.position.copy(_e);
  ortho.quaternion.copy(persp.quaternion);
  ortho.updateProjectionMatrix();
  ortho.updateMatrixWorld();
}
P.applyCamera = applyCamera;

/* keep the camera physically still while the pivot moves underneath it */
P.syncViewToEye = function(eye){
  var d = eye.clone().sub(VIEW.pivot);
  VIEW.radius = Math.max(T.radiusMin, d.length());
  VIEW.phi    = Math.acos(P.clamp(d.y/VIEW.radius, -1, 1));
  VIEW.theta  = Math.atan2(d.x, d.z);
};

/* Size the buffer from the LAYOUT viewport, never from the canvas rect: the
   rect is downstream of the buffer for a replaced element, and reading it here
   would make the two feed each other. The stylesheet pins the canvas box to
   100%, so the rect matches this anyway — but only if we do not depend on it. */
P.resize = function(){
  var w = Math.max(1, document.documentElement.clientWidth);
  var h = Math.max(1, document.documentElement.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 2));
  renderer.setSize(w, h, false);
  persp.aspect = w/h;
  applyCamera();
};

/* ==========================================================================
   Environment — grid, global axis, fog, background.
   One grid unit = 1000 mm (FACT). Grid and background colours are coupled the
   way Feather couples them ("both grid and guide visuals respond to the
   background colour"; "fog colour follows the background colour").
   ========================================================================== */
var ENV = {
  bg      : new THREE.Color('#eceaf3'),   // light by default, like Feather
  grid    : true,
  axis    : false,             // FACT: Global Axis is off by default
  fog     : false,
  shaded  : true
};
P.ENV = ENV;

var gridHelper = null;
function buildGrid(){
  if(gridHelper){ scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); }
  var lum = ENV.bg.r*0.299 + ENV.bg.g*0.587 + ENV.bg.b*0.114;
  var major = ENV.bg.clone().lerp(new THREE.Color(lum > 0.5 ? 0x000000 : 0xffffff), 0.30);
  var minor = ENV.bg.clone().lerp(new THREE.Color(lum > 0.5 ? 0x000000 : 0xffffff), 0.14);
  gridHelper = new THREE.GridHelper(40, 40, major, minor);   // 40 units = 40 m
  gridHelper.material.transparent = true;
  gridHelper.material.opacity = 0.85;
  gridHelper.visible = ENV.grid;
  scene.add(gridHelper);
}

/* RGB global axis (FACT: red/green/blue XYZ, toggled from the Environment tab) */
var axisGroup = new THREE.Group();
(function buildAxis(){
  var L = 20, cols = [0xff4d5e, 0x6bdc6b, 0x5b9dff];
  var dirs = [new THREE.Vector3(1,0,0), new THREE.Vector3(0,1,0), new THREE.Vector3(0,0,1)];
  for(var i=0;i<3;i++){
    var g = new THREE.BufferGeometry().setFromPoints([
      dirs[i].clone().multiplyScalar(-L), dirs[i].clone().multiplyScalar(L)
    ]);
    axisGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({
      color:cols[i], transparent:true, opacity:0.55, depthWrite:false
    })));
  }
})();
axisGroup.visible = ENV.axis;
scene.add(axisGroup);

P.applyEnv = function(){
  renderer.setClearColor(ENV.bg, 1);
  /* the chrome follows the canvas, the way Feather's does — a light scene gets
     the white UI, a dark scene gets the inverted one */
  if(P.UI && P.UI.syncTheme) P.UI.syncTheme();
  buildGrid();
  gridHelper.visible = ENV.grid;
  axisGroup.visible  = ENV.axis;
  /* Sketches that stray far outside the grid should fade, per the docs note
     that the grid's focal reference is 100 m. */
  scene.fog = ENV.fog ? new THREE.Fog(ENV.bg.getHex(), 30, 110) : null;
  if(P.Guides) P.Guides.refreshColors();
};

/* ==========================================================================
   Orbit-point marker + press-and-hold pivot behaviour
   ========================================================================== */
var pivotDot = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({color:0x5b9dff, transparent:true, opacity:0, depthTest:false})
);
pivotDot.renderOrder = 901;
scene.add(pivotDot);

var pivotPulse = 0;
P.pulsePivot = function(){ pivotPulse = 1; };
P.updatePivotMarker = function(){
  if(pivotPulse > 0){
    pivotPulse = Math.max(0, pivotPulse - 0.018);
    var r = P.pxToWorld(9) * (1 + (1-pivotPulse)*1.5);
    pivotDot.position.copy(VIEW.pivot);
    pivotDot.scale.setScalar(r);
    pivotDot.material.opacity = pivotPulse * 0.6;
  } else if(VIEW.pinned){
    /* a pinned pivot stays visible, faintly — it changes what orbiting does */
    pivotDot.position.copy(VIEW.pivot);
    pivotDot.scale.setScalar(P.pxToWorld(4.5));
    pivotDot.material.opacity = 0.35;
  } else if(pivotDot.material.opacity !== 0){
    pivotDot.material.opacity = 0;
  }
};

/* ==========================================================================
   View animation — double-tap snapping and the persp/ortho transition
   ========================================================================== */
var anim = null;

P.animateView = function(target, ms){
  var from = {theta:VIEW.theta, phi:VIEW.phi, roll:VIEW.roll,
              radius:VIEW.radius, pivot:VIEW.pivot.clone()};
  /* take the short way round in azimuth */
  var dTheta = target.theta - from.theta;
  while(dTheta >  Math.PI) dTheta -= Math.PI*2;
  while(dTheta < -Math.PI) dTheta += Math.PI*2;
  var dRoll = (target.roll !== undefined ? target.roll : 0) - from.roll;
  while(dRoll >  Math.PI) dRoll -= Math.PI*2;
  while(dRoll < -Math.PI) dRoll += Math.PI*2;

  anim = {
    t0: performance.now(),
    ms: ms || T.viewSnapMs,
    from: from, dTheta: dTheta, dRoll: dRoll,
    phi: target.phi !== undefined ? target.phi : from.phi,
    radius: target.radius !== undefined ? target.radius : from.radius,
    pivot: target.pivot ? target.pivot.clone() : from.pivot
  };
};
P.viewAnimating = function(){ return !!anim; };
P.cancelViewAnim = function(){ anim = null; };

P.tickView = function(now){
  if(!anim) return false;
  var k = P.clamp((now - anim.t0)/anim.ms, 0, 1), e = P.easeInOut(k);
  VIEW.theta  = anim.from.theta  + anim.dTheta*e;
  VIEW.phi    = anim.from.phi    + (anim.phi - anim.from.phi)*e;
  VIEW.roll   = anim.from.roll   + anim.dRoll*e;
  VIEW.radius = anim.from.radius + (anim.radius - anim.from.radius)*e;
  VIEW.pivot.lerpVectors(anim.from.pivot, anim.pivot, e);
  if(k >= 1) anim = null;
  applyCamera();
  return true;
};

/* The six standard views, as (theta, phi) pairs. */
var ORTHO_VIEWS = [
  {name:'Front',  theta:0,            phi:Math.PI/2},
  {name:'Back',   theta:Math.PI,      phi:Math.PI/2},
  {name:'Right',  theta:Math.PI/2,    phi:Math.PI/2},
  {name:'Left',   theta:-Math.PI/2,   phi:Math.PI/2},
  {name:'Top',    theta:0,            phi:0.0025},
  {name:'Bottom', theta:0,            phi:Math.PI-0.0025}
];
P.ORTHO_VIEWS = ORTHO_VIEWS;

function eyeDirFor(theta, phi){
  var sp = Math.sin(phi);
  return new THREE.Vector3(sp*Math.sin(theta), Math.cos(phi), sp*Math.cos(theta));
}

/* FACT (B.1): one-finger double-tap snaps to the nearest of the six views. */
P.snapNearestOrtho = function(){
  var cur = eyeDirFor(VIEW.theta, VIEW.phi), best = null, bestDot = -2;
  for(var i=0;i<ORTHO_VIEWS.length;i++){
    var d = eyeDirFor(ORTHO_VIEWS[i].theta, ORTHO_VIEWS[i].phi).dot(cur);
    if(d > bestDot){ bestDot = d; best = ORTHO_VIEWS[i]; }
  }
  /* keep the current azimuth for top/bottom so the snap does not spin */
  var theta = (best.name === 'Top' || best.name === 'Bottom') ? VIEW.theta : best.theta;
  P.animateView({theta:theta, phi:best.phi, roll:0});
  return best.name;
};

/* FACT (B.1): three-finger double-tap toggles perspective <-> orthographic. */
P.toggleProjection = function(){
  VIEW.ortho = !VIEW.ortho;
  applyCamera();
  return VIEW.ortho ? 'Orthographic' : 'Perspective';
};

/* FACT (B.3): with the pivot unpinned, press-and-hold on empty space resets
   the view. There is no documented "frame all" button, so reset means: back to
   the world origin at a framing that contains the sketch. */
P.resetView = function(){
  var box = P.Strokes ? P.Strokes.bounds() : null;
  var target = {theta:Math.PI*0.25, phi:Math.PI*0.42, roll:0, radius:T.radiusDefault,
                pivot:new THREE.Vector3(0,0,0)};
  if(box && !box.isEmpty()){
    var c = box.getCenter(new THREE.Vector3());
    var r = box.getBoundingSphere(new THREE.Sphere()).radius;
    target.pivot = c;
    target.radius = P.clamp(r / Math.tan(fovFromFocal(VIEW.focal)*Math.PI/360) * 1.15, 1, 200);
  }
  VIEW.pinned = false;
  P.animateView(target);
};

/* FACT (B.8): selecting a curve aligns the view centre to that curve. */
P.focusOn = function(box){
  if(!box || box.isEmpty()) return;
  var c = box.getCenter(new THREE.Vector3());
  P.animateView({theta:VIEW.theta, phi:VIEW.phi, roll:VIEW.roll, pivot:c});
  VIEW.pinned = true;
};

/* ==========================================================================
   Rotation inertia (legacy release note: "momentum to camera rotation")
   ========================================================================== */
var spin = {th:0, ph:0};
P.addSpin = function(dth, dph){ spin.th = dth; spin.ph = dph; };
P.killSpin = function(){ spin.th = 0; spin.ph = 0; };
P.tickSpin = function(){
  if(Math.abs(spin.th) < 1e-5 && Math.abs(spin.ph) < 1e-5) return false;
  VIEW.theta += spin.th;
  VIEW.phi   += spin.ph;
  spin.th *= 0.92; spin.ph *= 0.92;      // GUESS: decay tuned by feel
  applyCamera();
  return true;
};

/* ---- pointer -> world ---------------------------------------------------- */
var raycaster = new THREE.Raycaster();
var ndc = new THREE.Vector2();
P.raycaster = raycaster;

P.toNDC = function(x, y){
  var r = elStage.getBoundingClientRect();
  ndc.set(((x - r.left)/r.width)*2 - 1, -(((y - r.top)/r.height)*2 - 1));
  return ndc;
};
P.rayFrom = function(x, y){
  raycaster.setFromCamera(P.toNDC(x,y), P.cam());
  return raycaster;
};

/* the sketching plane used when no guide is active: faces the camera, through
   the pivot. Frozen at stroke start — the camera cannot move mid-pen-stroke. */
var drawPlane = new THREE.Plane();
P.drawPlane = drawPlane;
P.refreshDrawPlane = function(at){
  var n = P.cam().getWorldDirection(new THREE.Vector3());
  drawPlane.setFromNormalAndCoplanarPoint(n, at || VIEW.pivot);
};
P.planePoint = function(x, y, out){
  var r = P.rayFrom(x,y);
  return r.ray.intersectPlane(drawPlane, out) ? out : null;
};

P.camBasis = function(right, up, fwd){
  P.cam().matrixWorld.extractBasis(right, up, fwd);
};

})(window.P);
