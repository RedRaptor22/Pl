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
  /* the guide occlusion cache is keyed to this viewpoint */
  if(P.invalidateMask) P.invalidateMask();
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
  shaded  : true,
  /* FACT: Feather shows lighting, shadows and effects accurately only in
     rendering mode. Drawing stays cheap; you ask for the picture. */
  render  : false,
  groundShadow : true
};
P.ENV = ENV;

/* ==========================================================================
   Lighting — one key light and a soft ambient floor
   --------------------------------------------------------------------------
   Feather's Lighting panel gives a direction you slide (up and down for
   altitude, sideways for azimuth), a colour, and an intensity. This is that,
   kept to a single key plus ambient because a sketchbook wants a predictable
   read rather than a studio rig.

   THE UNIFORMS ARE SHARED OBJECTS. Every stroke owns its own material, so
   pointing them all at the same uniform objects makes changing the light one
   assignment rather than a walk over every stroke in the sketch - which
   matters when the light is being dragged.

   The defaults reproduce the light that was hardcoded in the stroke shader
   before there was anything to adjust: direction (0.32, 0.62, 0.72) is
   altitude 38.2 degrees at azimuth 24, and an ambient of 0.66 with a
   half-lambert term is exactly the 0.66 + 0.34*(d*0.5+0.5) it used to be. So
   nothing already drawn changes until you move something. */
var LIGHT = P.LIGHT = {
  az       : 0.4185,          // radians, 0 = +Z, turning towards +X
  alt      : 0.6664,          // radians above the horizon
  color    : new THREE.Color(0xffffff),
  intensity: 1,
  ambient  : 0.66,            // how bright the unlit side stays
  toon     : false,
  toonSteps: 4
};

var LU = P.LIGHT_UNIFORMS = {
  uLightDir: { value: new THREE.Vector3(0.319, 0.618, 0.718) },
  uLightCol: { value: new THREE.Color(1,1,1) },
  uLightInt: { value: 1 },
  uAmbient : { value: 0.66 },
  uToon    : { value: 0 },
  uToonStep: { value: 4 }
};

P.lightDirection = function(out){
  var ca = Math.cos(LIGHT.alt);
  return (out || new THREE.Vector3()).set(
    ca * Math.sin(LIGHT.az), Math.sin(LIGHT.alt), ca * Math.cos(LIGHT.az)
  ).normalize();
};

P.applyLight = function(){
  P.lightDirection(LU.uLightDir.value);
  LU.uLightCol.value.copy(LIGHT.color);
  LU.uLightInt.value = LIGHT.intensity;
  LU.uAmbient.value  = P.clamp(LIGHT.ambient, 0, 1);
  LU.uToon.value     = LIGHT.toon ? 1 : 0;
  LU.uToonStep.value = Math.max(2, Math.round(LIGHT.toonSteps));
  if(P.onLightChange) P.onLightChange();
};

/* ==========================================================================
   Ground shadow — the sketch's silhouette, thrown down the light
   --------------------------------------------------------------------------
   Feather's Ground Shadow casts onto the ground, and that is all this does.

   NOT A SHADOW MAP. The usual depth-map comparison wants surfaces thick and
   flat enough to bias against, and almost everything Plume draws is a thin
   tube: the bias that stops the acne is the bias that lifts the shadow off
   the object it belongs to. What the ground actually needs is a simpler
   question - is anything between this patch of ground and the light - and the
   answer is the sketch's SILHOUETTE seen from the light. So the strokes are
   drawn flat into a small target from the light's direction, and the ground
   samples it. No depth compare, no bias, nothing to tune.

   It is redrawn only when something it depends on moves. Orbiting the camera
   does not change a shadow cast by a fixed light onto a fixed ground, so
   spinning the view costs nothing.
   ========================================================================== */
var SHADOW_SIZE = 1024;
var shadowTarget = null, shadowCam = null, shadowPlane = null;
var shadowFlat = new THREE.MeshBasicMaterial({ color:0x000000 });
var shadowDirty = true, shadowKey = '';

P.invalidateGroundShadow = function(){ shadowDirty = true; };
P.onLightChange = function(){ shadowDirty = true; };

var GROUND_VERT = [
  'varying vec4 vLightPos;',
  'uniform mat4 uLightVP;',
  'void main(){',
  '  vec4 wp = modelMatrix * vec4(position, 1.0);',
  '  vLightPos = uLightVP * wp;',
  '  gl_Position = projectionMatrix * viewMatrix * wp;',
  '}'
].join('\n');

var GROUND_FRAG = [
  'precision highp float;',
  'varying vec4 vLightPos;',
  'uniform sampler2D uMask;',
  'uniform vec3  uColor;',
  'uniform float uStrength;',
  'uniform float uSoft;',
  'void main(){',
  '  vec3 lp = vLightPos.xyz / vLightPos.w;',
  '  vec2 uv = lp.xy * 0.5 + 0.5;',
  '  if(uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;',
  /* a few taps, so the edge is soft rather than a stencil cut */
  '  float o = uSoft;',
  '  float a = texture2D(uMask, uv).a * 0.4;',
  '  a += texture2D(uMask, uv + vec2( o, 0.0)).a * 0.15;',
  '  a += texture2D(uMask, uv + vec2(-o, 0.0)).a * 0.15;',
  '  a += texture2D(uMask, uv + vec2(0.0,  o)).a * 0.15;',
  '  a += texture2D(uMask, uv + vec2(0.0, -o)).a * 0.15;',
  '  if(a < 0.004) discard;',
  '  gl_FragColor = vec4(uColor, a * uStrength);',
  '}'
].join('\n');

function ensureShadow(){
  if(shadowTarget) return;
  shadowTarget = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, depthBuffer: true
  });
  shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({
      uniforms: {
        uLightVP  : { value: new THREE.Matrix4() },
        uMask     : { value: shadowTarget.texture },
        uColor    : { value: new THREE.Color(0x000000) },
        uStrength : { value: 0.30 },
        uSoft     : { value: 1.5 / SHADOW_SIZE }
      },
      vertexShader: GROUND_VERT, fragmentShader: GROUND_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    })
  );
  shadowPlane.rotation.x = -Math.PI/2;             // lie it on y = 0
  shadowPlane.renderOrder = 1;                     // over the grid, under the ink
  shadowPlane.visible = false;
  scene.add(shadowPlane);
}

/* what the shadow depends on: the light, and where the sketch is */
function shadowSignature(box){
  return [LIGHT.az.toFixed(4), LIGHT.alt.toFixed(4),
          box.min.x.toFixed(3), box.min.y.toFixed(3), box.min.z.toFixed(3),
          box.max.x.toFixed(3), box.max.y.toFixed(3), box.max.z.toFixed(3)].join(',');
}

P.updateGroundShadow = function(){
  var on = ENV.render && ENV.groundShadow && P.Strokes && P.Strokes.list.length;
  ensureShadow();
  /* below the horizon there is nothing sensible to cast */
  if(on && LIGHT.alt < 0.05) on = false;
  if(!on){ shadowPlane.visible = false; return; }

  var box = P.Strokes.bounds();
  if(box.isEmpty()){ shadowPlane.visible = false; return; }
  box.expandByScalar(0.02);

  var key = shadowSignature(box);
  if(!shadowDirty && key === shadowKey){ shadowPlane.visible = true; return; }
  shadowDirty = false; shadowKey = key;

  var centre = box.getCenter(new THREE.Vector3());
  var radius = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 0.05);
  var dir = P.lightDirection(new THREE.Vector3());

  /* the ground the shadow can land on reaches out by however far the light
     leans: a low sun throws a long one */
  var reach = radius + Math.abs(centre.y) / Math.max(Math.tan(LIGHT.alt), 0.05);
  var half = Math.min(radius + reach, radius * 40 + 1);

  shadowCam.left = -half; shadowCam.right = half;
  shadowCam.top  =  half; shadowCam.bottom = -half;
  shadowCam.near = 0.01;  shadowCam.far = half*4 + radius*4 + 2;
  shadowCam.position.copy(centre).addScaledVector(dir, half*2 + radius);
  shadowCam.lookAt(centre);
  shadowCam.updateMatrixWorld();
  shadowCam.updateProjectionMatrix();

  /* STROKES ONLY, and said as a whitelist rather than a list of things to
     hide. Naming the exceptions is how the first attempt turned the ground
     into one grey slab: an override material makes EVERYTHING opaque, so the
     pivot marker - a one-metre sphere kept at zero opacity - became a solid
     black ball filling the light's whole view. Anything added to the scene
     later would have found the same trap. Guides are scaffolding and should
     not throw shade either. */
  var prevOverride = scene.overrideMaterial;
  var strokeRoot = P.Strokes.group;
  var kids = scene.children, wasVisible = new Array(kids.length), ki;
  for(ki=0; ki<kids.length; ki++){
    wasVisible[ki] = kids[ki].visible;
    kids[ki].visible = (kids[ki] === strokeRoot);
  }
  scene.overrideMaterial = shadowFlat;

  var prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(shadowTarget);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, false);
  renderer.render(scene, shadowCam);
  renderer.setRenderTarget(prevTarget);
  renderer.setClearColor(ENV.bg, 1);

  scene.overrideMaterial = prevOverride;
  for(ki=0; ki<kids.length; ki++) kids[ki].visible = wasVisible[ki];

  var u = shadowPlane.material.uniforms;
  u.uLightVP.value.multiplyMatrices(
    shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
  u.uColor.value.copy(ENV.bg).lerp(new THREE.Color(0x000000), 0.85);
  shadowPlane.position.set(centre.x, 0, centre.z);
  shadowPlane.scale.set(half*2, half*2, 1);
  shadowPlane.visible = true;
};

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
