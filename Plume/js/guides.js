/* ==========================================================================
   PLUME / guides.js — the 3D guide: the mechanic the whole app hangs off.
   --------------------------------------------------------------------------
   FACT (SIGGRAPH '23, Kim/Hong/Yang): "When drawing the initial stroke, a
   surface as a 3D guide extrudes in the viewing direction... Subsequent
   strokes, drawn from different viewpoints, are projected onto the guide,
   resulting in curves with 3D coordinates."

   The guide is modelled as a SWEEP, not a static mesh, because that is what
   makes Bend expressible: bend "deforms the 3D guide surface to follow an
   additional stroke from another viewpoint while preserving the shape of the
   first stroke". So:

       surface(u,v) = path[v] + local[u].x*R_v + local[u].y*S_v + local[u].z*T_v

   where local[] is the first stroke expressed once, in the frame at the
   anchor, and (T,R,S)_v are rotation-minimising frames transported along the
   sweep path. Creation makes `path` a straight line along the view direction;
   Bend replaces `path` with a user-drawn curve. Nothing about the profile is
   touched by a bend, which is exactly the documented invariant.

   DEPTH IS A DOCUMENTED GAP. No source gives an extrusion magnitude. The
   choice here: extrude backwards (away from the camera, the literal "viewing
   direction") by a depth scaled to the stroke, plus a small forward margin so
   strokes drawn a little in front of the profile still land. That also puts
   the orange starting edge at one side of the surface, matching the support
   doc: "One side has an orange line, indicating the starting point".
   ========================================================================== */
(function(P){
'use strict';

var T = P.TUNE, EPS = P.EPS;

var root = new THREE.Group();
P.scene.add(root);

var G = P.Guides = {
  active    : null,     // at most one active guide (support docs, A.5)
  resources : [],       // saved guides, re-usable (Resource Tab)
  isolate   : true,     // FACT (A.9): guide doubles as an erase/select filter
  clampOffSurface : true // spec leaves off-edge behaviour undocumented
};

/* ==========================================================================
   1. Surface material — translucent, grid-lined, background-aware
   ========================================================================== */
var VERT = [
  'varying vec2 vUv2;',
  'varying vec3 vN;',
  'varying vec3 vW;',
  'varying vec3 vView;',
  'attribute vec2 uvw;',            // arc-length coords in world units
  'void main(){',
  '  vUv2 = uvw;',
  '  vN = normalize(normalMatrix * normal);',
  '  vec4 wp = modelMatrix * vec4(position,1.0);',
  '  vW = wp.xyz;',
  '  vec4 mv = viewMatrix * wp;',
  '  vView = -mv.xyz;',
  '  gl_Position = projectionMatrix * mv;',
  '}'
].join('\n');

var FRAG = [
  'uniform vec3  uFill;',
  'uniform vec3  uLine;',
  'uniform float uOpacity;',
  'uniform float uStep;',
  'uniform float uMode;',          // 0 = swept/lofted uv, 1 = primitive triplanar
  'uniform float uSelect;',
  'varying vec2 vUv2;',
  'varying vec3 vN;',
  'varying vec3 vW;',
  'varying vec3 vView;',
  'float gridFactor(vec2 c, float step){',
  '  vec2 g = c / step;',
  '  vec2 d = fwidth(g);',
  '  vec2 f = abs(fract(g - 0.5) - 0.5) / max(d, 1e-5);',
  '  return 1.0 - min(min(f.x, f.y), 1.0);',
  '}',
  'void main(){',
  '  vec3 n = normalize(vN);',
  '  if(!gl_FrontFacing) n = -n;',
  '  float line;',
  '  if(uMode < 0.5){',
  '    line = gridFactor(vUv2, uStep);',
  '  } else {',
  '    vec3 an = abs(normalize(vN));',
  '    float w = max(an.x + an.y + an.z, 1e-4);',
  '    line = ( gridFactor(vW.yz, uStep)*an.x',
  '           + gridFactor(vW.xz, uStep)*an.y',
  '           + gridFactor(vW.xy, uStep)*an.z ) / w;',
  '  }',
  '  float facing = abs(dot(n, normalize(vView)));',
  /* grazing angles get a lift so the surface reads as a volume, not a haze */
  '  float rim = pow(1.0 - facing, 2.0);',
  '  float a = uOpacity * (0.55 + 0.45*rim);',
  '  vec3 col = mix(uFill, uLine, line);',
  '  a = mix(a, min(uOpacity*1.9, 0.95), line*0.85);',
  '  col = mix(col, vec3(0.36,0.85,0.55), uSelect*0.6);',   // green = selected (A.5)
  '  if(a < 0.002) discard;',
  '  gl_FragColor = vec4(col, a);',
  '}'
].join('\n');

function makeSurfaceMaterial(mode){
  return new THREE.ShaderMaterial({
    uniforms: {
      uFill   : {value: new THREE.Color(0x8fb4ff)},
      uLine   : {value: new THREE.Color(0xcfe0ff)},
      uOpacity: {value: T.guideOpacityInit},
      uStep   : {value: T.guideGridStep},
      uMode   : {value: mode || 0},
      uSelect : {value: 0}
    },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    extensions: {derivatives:true}
  });
}

/* Guide colours track the background, per the v1.5 note that guide visuals
   "respond to background colors for better visibility". */
function guideColors(){
  var bg = P.ENV.bg;
  var lum = bg.r*0.299 + bg.g*0.587 + bg.b*0.114;
  return lum > 0.5
    ? { fill:new THREE.Color(0x2f5fbf), line:new THREE.Color(0x14336f) }
    : { fill:new THREE.Color(0x7fa8f5), line:new THREE.Color(0xd6e6ff) };
}

G.refreshColors = function(){
  var c = guideColors();
  var all = G.resources.slice();
  if(G.active) all.push(G.active);
  for(var i=0;i<all.length;i++){
    if(!all[i].mesh) continue;
    var u = all[i].mesh.material.uniforms;
    if(!u || !u.uFill) continue;           // imported images carry a texture
    u.uFill.value.copy(c.fill);
    u.uLine.value.copy(c.line);
  }
};

/* ==========================================================================
   2. Building a surface mesh from a row/column grid of points
   ========================================================================== */
function buildSurfaceGeometry(rows){
  var nv = rows.length, nu = rows[0].length;
  var count = nv*nu;
  var pos = new Float32Array(count*3),
      nor = new Float32Array(count*3),
      uvw = new Float32Array(count*2);

  /* arc-length parameterisation in world units, so the section lines keep a
     constant physical spacing however the surface is stretched */
  var uLen = new Array(nu), vLen = new Array(nv), i, j;
  var mid = rows[Math.floor(nv/2)];
  uLen[0] = 0;
  for(i=1;i<nu;i++) uLen[i] = uLen[i-1] + mid[i].distanceTo(mid[i-1]);
  vLen[0] = 0;
  var midU = Math.floor(nu/2);
  for(j=1;j<nv;j++) vLen[j] = vLen[j-1] + rows[j][midU].distanceTo(rows[j-1][midU]);

  var du = new THREE.Vector3(), dv = new THREE.Vector3(), nn = new THREE.Vector3();
  for(j=0;j<nv;j++){
    for(i=0;i<nu;i++){
      var o = j*nu + i, p = rows[j][i];
      pos[o*3] = p.x; pos[o*3+1] = p.y; pos[o*3+2] = p.z;
      du.subVectors(rows[j][Math.min(nu-1,i+1)], rows[j][Math.max(0,i-1)]);
      dv.subVectors(rows[Math.min(nv-1,j+1)][i], rows[Math.max(0,j-1)][i]);
      nn.crossVectors(du, dv);
      if(nn.lengthSq() < EPS) nn.set(0,0,1); else nn.normalize();
      nor[o*3] = nn.x; nor[o*3+1] = nn.y; nor[o*3+2] = nn.z;
      uvw[o*2] = uLen[i]; uvw[o*2+1] = vLen[j];
    }
  }

  var idx = [];
  for(j=0;j<nv-1;j++){
    for(i=0;i<nu-1;i++){
      var a = j*nu+i, b = a+1, c = (j+1)*nu+i, d = c+1;
      idx.push(a,c,b, b,c,d);
    }
  }

  var geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos,3));
  geom.setAttribute('normal',   new THREE.BufferAttribute(nor,3));
  geom.setAttribute('uvw',      new THREE.BufferAttribute(uvw,2));
  geom.setIndex(new THREE.BufferAttribute(
    count < 65536 ? new Uint16Array(idx) : new Uint32Array(idx), 1));
  geom.computeBoundingSphere();
  geom.userData.nu = nu; geom.userData.nv = nv;
  return geom;
}

/* ==========================================================================
   3. The guide object
   ========================================================================== */
function newGuide(kind){
  return {
    id: P.uid(), kind: kind,
    obj: new THREE.Group(),
    mesh: null, orange: null,
    sweep: null,
    opacity: T.guideOpacityInit,
    selected: false,
    name: kind === 'draw' ? 'Surface' : (kind === 'loft' ? 'Loft' : 'Shape')
  };
}

function attachMesh(guide, geom, mode){
  if(guide.mesh){
    guide.obj.remove(guide.mesh);
    guide.mesh.geometry.dispose();
    guide.mesh.material.dispose();
  }
  var mat = makeSurfaceMaterial(mode||0);
  var c = guideColors();
  mat.uniforms.uFill.value.copy(c.fill);
  mat.uniforms.uLine.value.copy(c.line);
  mat.uniforms.uOpacity.value = guide.opacity;
  guide.mesh = new THREE.Mesh(geom, mat);
  guide.mesh.renderOrder = 5;
  guide.mesh.userData.guide = guide;
  guide.obj.add(guide.mesh);
}

/* FACT (A.3): the orange line marks the guide's starting point and is the
   anchor bending works from. */
function attachOrange(guide, pts){
  if(guide.orange){
    guide.obj.remove(guide.orange);
    guide.orange.geometry.dispose();
    guide.orange.material.dispose();
    guide.orange = null;
  }
  if(!pts || pts.length < 2) return;
  var g = new THREE.BufferGeometry().setFromPoints(pts);
  guide.orange = new THREE.Line(g, new THREE.LineBasicMaterial({
    color:0xff8a3d, transparent:true, opacity:0.95, depthWrite:false
  }));
  guide.orange.renderOrder = 6;
  guide.obj.add(guide.orange);
}

/* ==========================================================================
   4. Sweep evaluation
   ========================================================================== */
/* WHICH WAY UP THE PROFILE SITS ON A NEW PATH.

   The transported frames need a seed at index 0, and the obvious seed —
   basisR, the profile's own right axis — fails in the most ordinary case
   there is. transportFrames projects the seed perpendicular to the first
   tangent, and when the path sets off ALONG basisR that projection is
   degenerate, so it falls back to an arbitrary world-axis perpendicular. That
   is precisely the common bend: draw a profile in the front view, orbit to the
   top, drag sideways. Measured on a hooked profile, two bend paths 2.3 degrees
   apart produced reference frames 178 degrees apart and surfaces 0.81 units
   apart — the profile flipped end for end. Symmetric profiles hid it; a curved
   stroke showed it every time, which is exactly how it was reported.

   So carry the whole anchor frame onto the new tangent by the shortest
   rotation instead. It reduces to basisR exactly when the path still runs
   along basisT (guide creation, unchanged), it is continuous everywhere the
   minimal rotation is, and it keeps the profile facing the way the user drew
   it. A path doubling straight back along the extrusion axis is the one
   antipodal case: rotate 180 degrees about basisR, which maps basisT to its
   opposite and leaves basisR itself alone. */
var _sq = new THREE.Quaternion(), _seedV = new THREE.Vector3();

function sweepSeed(sweep, T0){
  if(sweep.basisT.dot(T0) < -0.999999) return _seedV.copy(sweep.basisR);
  _sq.setFromUnitVectors(sweep.basisT, T0);
  return _seedV.copy(sweep.basisR).applyQuaternion(_sq);
}

function evalSweep(sweep){
  var path = sweep.path, local = sweep.local;
  var T0 = P.computeTangents(path)[0];
  var fr = P.transportFrames(path, sweepSeed(sweep, T0));
  sweep.frames = fr;

  /* local[] was written in the anchor frame; because the frames are
     transported from index 0 with the anchor frame carried onto the path, the
     frame at the anchor row is (basisT, basisR, basisT x basisR) rotated onto
     the path — so the profile can be laid down row by row with no
     re-derivation. */
  var rows = [], j, i;
  var s = new THREE.Vector3();
  for(j=0;j<path.length;j++){
    var Tv = fr.T[j], Rv = fr.R[j];
    s.crossVectors(Tv, Rv);
    var row = [];
    for(i=0;i<local.length;i++){
      var l = local[i];
      row.push(new THREE.Vector3(
        path[j].x + Rv.x*l.x + s.x*l.y + Tv.x*l.z,
        path[j].y + Rv.y*l.x + s.y*l.y + Tv.y*l.z,
        path[j].z + Rv.z*l.x + s.z*l.y + Tv.z*l.z
      ));
    }
    rows.push(row);
  }
  return rows;
}

function rebuildSweep(guide){
  var rows = evalSweep(guide.sweep);
  attachMesh(guide, buildSurfaceGeometry(rows), 0);
  attachOrange(guide, rows[guide.sweep.anchorIndex]);
}
G.rebuildSweep = rebuildSweep;

/* ==========================================================================
   5. Creation from the first stroke  (A.1)
   ========================================================================== */
G.createFromStroke = function(worldPts, viewDir, camRight, camUp){
  var profile = P.resample(worldPts, Math.min(T.guideProfileSeg,
                             Math.max(8, worldPts.length*2)));
  if(profile.length < 2) return null;

  var t0 = viewDir.clone().normalize();
  var r0 = camRight.clone().normalize();
  var s0 = new THREE.Vector3().crossVectors(t0, r0).normalize();

  /* anchor = profile centroid; local coords are relative to it */
  var anchor = new THREE.Vector3();
  for(var i=0;i<profile.length;i++) anchor.add(profile[i]);
  anchor.multiplyScalar(1/profile.length);

  var local = [], d = new THREE.Vector3(), extent = 0;
  for(i=0;i<profile.length;i++){
    d.subVectors(profile[i], anchor);
    local.push({x:d.dot(r0), y:d.dot(s0), z:d.dot(t0)});
    extent = Math.max(extent, d.length());
  }

  /* GUESS — extrusion depth. Scaled off the stroke, floored against the
     current orbit radius so a small stroke in a big scene still gives a guide
     you can orbit around and draw on. */
  var depth = P.clamp(Math.max(extent*2*T.guideDepthFactor,
                               P.VIEW.radius*T.guideDepthOfView),
                      T.guideDepthMin, T.guideDepthMax);
  var front = depth * T.guideDepthFront;

  var nSeg = T.guidePathSeg;
  var anchorIndex = Math.round(nSeg * (front/(front+depth)));
  var path = [];
  for(var j=0;j<=nSeg;j++){
    var tt = -front + (front+depth) * (j/nSeg);
    path.push(anchor.clone().addScaledVector(t0, tt));
  }
  /* snap the anchor row exactly onto the stroke so the orange line sits on it */
  path[anchorIndex].copy(anchor);

  return G.fromSweepData({
    local: local, anchor: anchor, anchorIndex: anchorIndex,
    path: path, basisR: r0, basisT: t0, depth: depth
  });
};

/* Build a swept guide straight from sweep data. Creation and document restore
   both land here, so a reloaded guide is bit-identical to a drawn one and can
   be bent again exactly the same way. */
G.fromSweepData = function(sweep){
  var guide = newGuide('draw');
  guide.sweep = {
    local: sweep.local,
    anchor: sweep.anchor.clone(),
    anchorIndex: sweep.anchorIndex,
    path: sweep.path,
    basisR: sweep.basisR.clone(),
    basisT: sweep.basisT.clone(),
    depth: sweep.depth
  };
  rebuildSweep(guide);
  return guide;
};

/* ==========================================================================
   6. Bend  (A.6)
   --------------------------------------------------------------------------
   The drawn stroke becomes the new sweep path. Two things make it behave like
   the documented cylinder -> doughnut example:
     - the path is translated so it starts at the anchor (the orange line, the
       documented starting point of the bend), and
     - its initial tangent is rotated onto the guide's original extrusion
       direction, so the profile is still oriented across the sweep. Without
       that, a top-view circle would shear the profile instead of revolving it.
   INFERENCE: the tangent alignment is not stated in any source; it is the
   reading that reproduces the documented worked example.
   ========================================================================== */
G.bend = function(guide, worldPath){
  if(!guide || !guide.sweep || worldPath.length < 2) return false;
  var sw = guide.sweep;
  var path = P.resample(worldPath, T.guidePathSeg+1);

  /* Translate so the sweep starts at the orange line, and otherwise use the
     stroke EXACTLY as drawn.

     An earlier version also rotated the path so its start tangent matched the
     guide's original extrusion direction. That was an inference, and a wrong
     one: when the drawn direction ran roughly opposite that axis the minimal
     rotation was ~180 degrees, so the surface swept away from the stroke the
     user had just made. It is not needed for the documented cylinder ->
     doughnut case either — the profile is carried perpendicular to the path by
     the transported frames regardless of which way the path leaves the anchor,
     and leaving the path alone keeps the result in the plane it was drawn in
     instead of tilting it out. */
  var shift = sw.anchor.clone().sub(path[0]);
  for(var i=0;i<path.length;i++) path[i].add(shift);

  sw.path = path;
  sw.anchorIndex = 0;                 // bending starts from the orange line
  rebuildSweep(guide);
  return true;
};

/* ==========================================================================
   6b. Bending a guide that has no sweep — lofts, primitives, imported models
   --------------------------------------------------------------------------
   A swept guide bends by replacing its path. A loft or a cube has no profile
   and path to replace, so those guides bend as a curve DEFORM instead: one
   axis of the mesh is re-parameterised onto the drawn stroke, and each vertex
   is carried along in the transported frame at its own position. Same
   gesture, same "follow the line I drew" result, on any geometry.

   WHICH axis, and which way along it, is decided by the STROKE — not by the
   mesh alone. Picking the longest axis and always running it low-to-high is
   what made this bend backwards: a sphere or a cube has no meaningful longest
   axis, so the deform ran along local +X whatever the user drew, and any
   stroke heading the other way produced a guide sweeping away from the pen.
   Measured against the drawn direction, before: cube 91 degrees off, tube 86,
   pyramid 88, sphere a full 180. After: 0 for all four.

   So: among the axes long enough to be worth routing, take the one closest to
   the direction actually drawn, and orient it to point the same way. A rod
   still bends along its length (its other axes are too short to qualify); a
   cube bends whichever way the stroke goes.

   The undeformed vertices are kept, so repeated bends re-deform the original
   rather than compounding into mush — which matches how a swept bend replaces
   its path rather than bending the bent thing again.
   ========================================================================== */
function originalPositions(guide){
  var geom = guide.mesh.geometry;
  if(!guide.originalPos){
    guide.originalPos = new Float32Array(geom.attributes.position.array);
  }
  return guide.originalPos;
}

G.unbendMesh = function(guide){
  if(!guide || !guide.mesh || !guide.originalPos) return;
  var attr = guide.mesh.geometry.attributes.position;
  attr.array.set(guide.originalPos);
  attr.needsUpdate = true;
  guide.mesh.geometry.computeVertexNormals();
  guide.mesh.geometry.computeBoundingSphere();
  guide.mesh.geometry.computeBoundingBox();
  guide.bendPath = null;
};

G.bendMesh = function(guide, worldPath){
  if(!guide || !guide.mesh || !worldPath || worldPath.length < 2) return false;
  var geom = guide.mesh.geometry;
  var orig = originalPositions(guide);
  var attr = geom.attributes.position;

  /* work entirely in the guide's own space */
  guide.obj.updateMatrixWorld(true);
  var toLocal = new THREE.Matrix4().copy(guide.obj.matrixWorld).invert();
  var local = worldPath.map(function(p){ return p.clone().applyMatrix4(toLocal); });
  local = P.resample(local, T.guidePathSeg + 1);

  var lo = new THREE.Vector3( Infinity,  Infinity,  Infinity);
  var hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  var i;
  for(i=0;i<orig.length;i+=3){
    lo.x = Math.min(lo.x, orig[i]);   hi.x = Math.max(hi.x, orig[i]);
    lo.y = Math.min(lo.y, orig[i+1]); hi.y = Math.max(hi.y, orig[i+1]);
    lo.z = Math.min(lo.z, orig[i+2]); hi.z = Math.max(hi.z, orig[i+2]);
  }
  var ext = [hi.x-lo.x, hi.y-lo.y, hi.z-lo.z];
  var longest = Math.max(ext[0], ext[1], ext[2]);
  if(longest < EPS) return false;

  /* the direction the stroke actually goes, in the guide's own space. A closed
     loop has no chord, so fall back to the sample furthest from the start —
     for a circle that is the diameter, which is the axis a doughnut turns on */
  var drawn = local[local.length-1].clone().sub(local[0]);
  if(drawn.lengthSq() < EPS*EPS){
    var far = 0, fd = -1;
    for(i=1;i<local.length;i++){
      var d2 = local[i].distanceToSquared(local[0]);
      if(d2 > fd){ fd = d2; far = i; }
    }
    drawn.copy(local[far]).sub(local[0]);
  }
  if(drawn.lengthSq() < EPS*EPS) drawn.set(1,0,0);
  drawn.normalize();

  /* Among the axes within 25% of the longest — i.e. the ones a bend could
     sensibly run along — take the one the stroke agrees with most. That keeps
     a rod bending along its length while letting a cube or a sphere bend
     whichever way the pen went. */
  var axis = -1, best = -1;
  var comp = [Math.abs(drawn.x), Math.abs(drawn.y), Math.abs(drawn.z)];
  for(i=0;i<3;i++){
    if(ext[i] < longest*0.75) continue;
    if(comp[i] > best){ best = comp[i]; axis = i; }
  }
  if(axis < 0) axis = ext[0] >= ext[1] ? (ext[0] >= ext[2] ? 0 : 2) : (ext[1] >= ext[2] ? 1 : 2);
  var span = ext[axis];
  if(span < EPS) return false;

  /* ...and run it the way the stroke runs, so the far end follows the pen
     instead of retreating from it */
  var forward = drawn.getComponent(axis) >= 0;
  var pa = (axis+1)%3, pb = (axis+2)%3;
  var loArr = [lo.x, lo.y, lo.z], hiArr = [hi.x, hi.y, hi.z];
  var mid = [ (loArr[0]+hiArr[0])/2, (loArr[1]+hiArr[1])/2, (loArr[2]+hiArr[2])/2 ];
  var startVal = forward ? loArr[axis] : hiArr[axis];

  /* THE STROKE IS WHERE THE GUIDE GOES. The path used to be translated onto
     the mesh's own starting face, which is an invisible landmark on the far
     side from the pen — so a cube bent by a stroke drawn to its right jumped
     left and shrank onto the stroke's length, measured as a 1.6-unit leap for
     a 0.55-unit stroke. A swept guide can translate to its anchor because the
     orange line is visible and the user aims at it; a deform has no such mark,
     so the honest answer is to leave the path exactly where it was drawn and
     lay the mesh along it. */

  /* seed the frame with the first perpendicular axis, so an unbent straight
     path reproduces the mesh exactly */
  var seed = new THREE.Vector3();
  seed.setComponent(pa, 1);
  var fr = P.transportFrames(local, seed);

  var arc = P.arcLengths(local), total = arc[arc.length-1];
  if(total < EPS) return false;

  var s = new THREE.Vector3(), out = new THREE.Vector3();
  var arr = attr.array;
  for(i=0;i<orig.length;i+=3){
    var t = (orig[i+axis] - startVal) / (forward ? span : -span);   // 0..1 from the start end
    var target = t * total;
    /* locate the path sample for this arc position */
    var j = 0;
    while(j < arc.length-2 && arc[j+1] < target) j++;
    var segLen = arc[j+1] - arc[j];
    var f = segLen < EPS ? 0 : (target - arc[j]) / segLen;

    var Ta = fr.T[j], Ra = fr.R[j];
    var Tb = fr.T[j+1], Rb = fr.R[j+1];
    /* lerp position and frame between the two samples */
    out.copy(local[j]).lerp(local[j+1], f);
    s.copy(Ra).lerp(Rb, f);
    var tt = _dir.copy(Ta).lerp(Tb, f);
    if(tt.lengthSq() < EPS) tt.copy(Ta);
    tt.normalize();
    s.addScaledVector(tt, -s.dot(tt));
    if(s.lengthSq() < EPS) P.perpTo(tt, s); else s.normalize();
    var sv = _org.crossVectors(tt, s);

    var u = orig[i+pa] - mid[pa];
    var w = orig[i+pb] - mid[pb];
    arr[i]   = out.x + s.x*u + sv.x*w;
    arr[i+1] = out.y + s.y*u + sv.y*w;
    arr[i+2] = out.z + s.z*u + sv.z*w;
  }
  attr.needsUpdate = true;
  geom.computeVertexNormals();
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  delete geom.userData._adj;               // adjacency is unchanged, bounds are not
  guide.bendPath = worldPath.map(function(p){ return p.clone(); });
  return true;
};

/* ==========================================================================
   7. Loft  (A.7)
   --------------------------------------------------------------------------
   FACT: connect two or more already-drawn curves in sequence, with a tension
   slider (up = smoother, down = sharper).
   ========================================================================== */
/* Works from raw point arrays rather than strokes, so a saved document can
   rebuild a loft without needing its source curves to still exist. */
G.loftFromCurves = function(rawCurves, tension){
  if(!rawCurves || rawCurves.length < 2) return null;
  var nu = T.guideProfileSeg;
  var curves = [], i, j;

  for(i=0;i<rawCurves.length;i++){
    var c = P.resample(rawCurves[i], nu);
    /* flip a curve whose direction opposes its predecessor, else the loft
       twists through 180 degrees between sections */
    if(curves.length){
      var prev = curves[curves.length-1];
      var straight = prev[0].distanceTo(c[0]) + prev[nu-1].distanceTo(c[nu-1]);
      var flipped  = prev[0].distanceTo(c[nu-1]) + prev[nu-1].distanceTo(c[0]);
      if(flipped < straight) c.reverse();
    }
    curves.push(c);
  }

  /* GUESS: 24 interpolated rows between the outer sections reads smooth
     without making the mesh heavy. */
  var nv = Math.max(2, (curves.length-1) * 24 + 1);
  var cols = [];
  for(i=0;i<nu;i++){
    var ctrl = [];
    for(j=0;j<curves.length;j++) ctrl.push(curves[j][i]);
    cols.push(P.sampleChain(ctrl, nv, tension));
  }
  var rows = [];
  for(j=0;j<nv;j++){
    var row = [];
    for(i=0;i<nu;i++) row.push(cols[i][j]);
    rows.push(row);
  }

  var guide = newGuide('loft');
  attachMesh(guide, buildSurfaceGeometry(rows), 0);
  attachOrange(guide, rows[0]);        // the first selected curve is the start
  /* keep the inputs so the guide can be re-lofted or saved */
  guide.loftCurves = curves.map(function(c){
    return c.map(function(p){ return p.clone(); });
  });
  guide.loftTension = tension;
  return guide;
};

G.loft = function(strokes, tension){
  if(!strokes || strokes.length < 2) return null;
  var raw = strokes.map(function(st){
    return st.pts.map(function(pt){ return pt.p.clone(); });
  });
  var guide = G.loftFromCurves(raw, tension);
  if(guide) guide.loftSources = strokes.slice();
  return guide;
};

/* ==========================================================================
   8. Primitives  (A.8) — FACT: Cube, Pyramid, Sphere, Tube, always at (0,0,0),
   with a segment-count slider that turns a Tube into a cylinder or cone.
   ========================================================================== */
G.PRIMITIVES = ['cube','pyramid','sphere','tube'];

G.primitive = function(kind, segments, taper){
  var seg = Math.max(3, Math.round(segments || 24));
  var tp  = (taper === undefined) ? 1 : taper;   // 1 = cylinder, 0 = cone
  var geom;
  switch(kind){
    case 'cube':    geom = new THREE.BoxGeometry(2,2,2, 1,1,1); break;
    case 'pyramid': geom = new THREE.ConeGeometry(1.5, 2.4, 4, 1); break;
    case 'sphere':  geom = new THREE.SphereGeometry(1.4, seg, Math.max(3, seg>>1)); break;
    default:        geom = new THREE.CylinderGeometry(1.2*tp, 1.2, 2.6, seg, 1); break;
  }
  /* the surface shader reads uvw in swept mode only, but the attribute has to
     exist for the program to link — triplanar mode ignores its values */
  var n = geom.attributes.position.count;
  geom.setAttribute('uvw', new THREE.BufferAttribute(new Float32Array(n*2), 2));

  var guide = newGuide('primitive');
  guide.primKind = kind; guide.primSeg = seg; guide.primTaper = tp;
  attachMesh(guide, geom, 1);
  guide.obj.position.set(0,0,0);               // FACT: always created at origin
  return guide;
};

/* ==========================================================================
   8b. Imported guides  (C.1)
   --------------------------------------------------------------------------
   FACT: images act as flat guides, models as curved ones. An image also
   refuses strokes outside its edges ("you cannot draw outside its
   boundaries"), which is the one place the clamp-to-nearest fallback is
   explicitly wrong — so image guides carry noClamp.
   ========================================================================== */
G.fromImage = function(dataURL, pxW, pxH, name){
  var guide = newGuide('image');
  guide.name = name || 'Image';
  guide.imageURL = dataURL;
  guide.imageAspect = (pxW && pxH) ? pxW/pxH : 1;
  guide.noClamp = true;                    // documented: no drawing off the edge

  var aspect = guide.imageAspect;
  var h = 2.2, w = h * aspect;             // GUESS: ~2.2 units tall by default
  var geom = new THREE.PlaneGeometry(w, h, 1, 1);
  geom.setAttribute('uvw', new THREE.BufferAttribute(
    new Float32Array(geom.attributes.position.count*2), 2));

  var tex = new THREE.TextureLoader().load(dataURL, function(){
    if(P.onSceneChange) P.onSceneChange();
  });
  tex.minFilter = THREE.LinearFilter;      // no mipmaps: it is a reference, not a surface
  tex.generateMipmaps = false;

  if(guide.mesh){
    guide.obj.remove(guide.mesh);
    guide.mesh.geometry.dispose();
    guide.mesh.material.dispose();
  }
  guide.mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 1,
    side: THREE.DoubleSide, depthWrite: false, toneMapped: false
  }));
  guide.mesh.renderOrder = 4;              // behind the section-lined guides
  guide.mesh.userData.guide = guide;
  guide.obj.add(guide.mesh);

  /* stand it up facing the camera, at the pivot */
  guide.obj.position.copy(P.VIEW.pivot);
  guide.obj.quaternion.copy(P.cam().quaternion);
  guide.obj.updateMatrixWorld(true);

  attachOrange(guide, [
    new THREE.Vector3(-w/2, -h/2, 0), new THREE.Vector3(w/2, -h/2, 0)
  ]);
  /* an image starts fully visible — it is reference art, not a scaffold */
  guide.opacity = 1;
  return guide;
};

G.fromModel = function(geom, name){
  var guide = newGuide('model');
  guide.name = name || 'Model';
  attachMesh(guide, geom, 1);              // triplanar section lines
  guide.obj.position.set(0,0,0);
  return guide;
};

/* ==========================================================================
   9. Activation / saving / closing
   ========================================================================== */
/* Only one guide is ACTIVE — that is the documented model, and it is what
   projection and masking read. But a saved guide may stay in the scene as
   visible reference, which is the whole point of keeping it: you often want
   the last surface on screen while drawing on the next one. Inactive guides
   are dimmed so it is never ambiguous which one the pen will hit. */
function applyDisplayOpacity(g){
  if(!g || !g.mesh) return;
  var live = (g === G.active);
  var o = g.opacity * (live ? 1 : 0.45);
  var m = g.mesh.material;
  if(m.uniforms && m.uniforms.uOpacity) m.uniforms.uOpacity.value = o;
  else m.opacity = o;
  if(g.orange) g.orange.material.opacity = live ? 0.95 : 0.25;
}
function refreshDisplay(){
  applyDisplayOpacity(G.active);
  for(var i=0;i<G.resources.length;i++) applyDisplayOpacity(G.resources[i]);
}
G.refreshDisplay = refreshDisplay;

function keepInScene(g){
  return !!g && (g === G.active || (G.resources.indexOf(g) >= 0 && g.visible));
}

G.setActive = function(guide){
  var prev = G.active;
  G.active = guide || null;
  /* the outgoing guide only leaves the scene if nothing else is holding it */
  if(prev && prev !== G.active && !keepInScene(prev) && prev.obj.parent){
    root.remove(prev.obj);
  }
  if(guide && guide.obj.parent !== root) root.add(guide.obj);
  refreshDisplay();
  if(P.onGuideChange) P.onGuideChange();
};

/* show or hide a saved guide without making it active */
G.setResourceVisible = function(g, on){
  if(!g) return;
  g.visible = !!on;
  if(on && g.obj.parent !== root) root.add(g.obj);
  else if(!on && g !== G.active && g.obj.parent) root.remove(g.obj);
  refreshDisplay();
  if(P.onGuideChange) P.onGuideChange();
};

G.close = function(){
  var g = G.active;
  if(!g) return null;
  G.active = null;
  if(!keepInScene(g)) root.remove(g.obj);
  refreshDisplay();
  if(P.onGuideChange) P.onGuideChange();
  return g;
};

/* FACT (A.5): close + slide up saves the guide to the Resource Tab for reuse;
   "After saving, you can create additional 3D Guides." */
G.save = function(guide){
  var g = guide || G.active;
  if(!g) return null;
  if(G.resources.indexOf(g) < 0) G.resources.push(g);
  /* a saved guide stays on screen as reference — hide it from the Stage panel
     if it is in the way */
  g.visible = true;
  if(g === G.active) G.active = null;
  if(g.obj.parent !== root) root.add(g.obj);
  refreshDisplay();
  if(P.onGuideChange) P.onGuideChange();
  return g;
};

G.dispose = function(g){
  if(!g) return;
  if(g.obj.parent) g.obj.parent.remove(g.obj);
  if(g.mesh){ g.mesh.geometry.dispose(); g.mesh.material.dispose(); }
  if(g.orange){ g.orange.geometry.dispose(); g.orange.material.dispose(); }
};

/* FACT (A.2/A.10): opacity is adjustable down to 0% but never fully opaque —
   except for an imported image, which is reference art rather than a
   scaffold, so it is allowed to be solid. */
G.setOpacity = function(guide, v){
  var g = guide || G.active;
  if(!g || !g.mesh) return;
  var max = (g.kind === 'image') ? 1 : T.guideOpacityMax;
  g.opacity = P.clamp(v, 0, max);
  applyDisplayOpacity(g);                  // dims automatically when inactive
};

G.setSelected = function(guide, on){
  if(!guide) return;
  guide.selected = !!on;
  if(!guide.mesh) return;
  var m = guide.mesh.material;
  if(m.uniforms && m.uniforms.uSelect) m.uniforms.uSelect.value = on ? 1 : 0;
  else m.color.set(on ? 0x9fe8c0 : 0xffffff);
};

/* Bake the object transform into the sweep so bends stay consistent after the
   joystick has moved the guide around. */
G.bakeTransform = function(guide){
  if(!guide || !guide.sweep) return;
  guide.obj.updateMatrixWorld(true);
  var m = guide.obj.matrix;
  if(m.equals(new THREE.Matrix4())) return;
  var rot = new THREE.Matrix3().setFromMatrix4(m);
  var sw = guide.sweep;
  for(var i=0;i<sw.path.length;i++) sw.path[i].applyMatrix4(m);
  sw.anchor.applyMatrix4(m);
  sw.basisR.applyMatrix3(rot).normalize();
  sw.basisT.applyMatrix3(rot).normalize();
  var sc = new THREE.Vector3();
  m.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
  var k = (sc.x + sc.y + sc.z)/3;
  for(i=0;i<sw.local.length;i++){
    sw.local[i].x *= k; sw.local[i].y *= k; sw.local[i].z *= k;
  }
  guide.obj.position.set(0,0,0);
  guide.obj.quaternion.identity();
  guide.obj.scale.set(1,1,1);
  guide.obj.updateMatrixWorld(true);
  rebuildSweep(guide);
};

/* ==========================================================================
   10. Projection of subsequent strokes  (A.4)
   --------------------------------------------------------------------------
   View-direction raycast onto the guide. INFERENCE: the sources say strokes
   are "projected onto the guide" without naming raycast-vs-nearest-point;
   raycast is the reading that matches "projected... from different
   viewpoints". Off the edge, the default clamps to the nearest point on the
   surface (spec recommendation #2), since Feather's off-edge behaviour is
   undocumented — imported images, which act as flat guides, simply refuse
   strokes outside their bounds.
   ========================================================================== */
var _ray = new THREE.Raycaster();

G.hasActive = function(){ return !!(G.active && G.active.mesh); };

G.project = function(x, y){
  if(!G.hasActive()) return null;
  var r = P.rayFrom(x, y);
  var hits = r.intersectObject(G.active.mesh, false);
  if(hits.length){
    return { point: hits[0].point.clone(),
             normal: hits[0].face
                ? hits[0].face.normal.clone().applyMatrix3(
                    new THREE.Matrix3().getNormalMatrix(G.active.mesh.matrixWorld)).normalize()
                : new THREE.Vector3(0,0,1),
             onSurface: true };
  }
  /* FACT (A.4): an imported image refuses strokes past its edge rather than
     clamping them back onto itself. */
  if(G.active.noClamp || !G.clampOffSurface) return null;
  return nearestOnGuide(r.ray);
};

/* ---- closest point on a triangle to a point (Ericson, Real-Time Collision
   Detection §5.1.5). Exact, branch-per-Voronoi-region, no iteration. ---- */
var _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _ap = new THREE.Vector3(),
    _bp = new THREE.Vector3(), _cp = new THREE.Vector3(), _bc = new THREE.Vector3();

function closestPtTriangle(p, a, b, c, out){
  _ab.subVectors(b, a); _ac.subVectors(c, a); _ap.subVectors(p, a);
  var d1 = _ab.dot(_ap), d2 = _ac.dot(_ap);
  if(d1 <= 0 && d2 <= 0) return out.copy(a);

  _bp.subVectors(p, b);
  var d3 = _ab.dot(_bp), d4 = _ac.dot(_bp);
  if(d3 >= 0 && d4 <= d3) return out.copy(b);

  var vc = d1*d4 - d3*d2;
  if(vc <= 0 && d1 >= 0 && d3 <= 0){
    return out.copy(a).addScaledVector(_ab, d1/(d1-d3));
  }
  _cp.subVectors(p, c);
  var d5 = _ab.dot(_cp), d6 = _ac.dot(_cp);
  if(d6 >= 0 && d5 <= d6) return out.copy(c);

  var vb = d5*d2 - d1*d6;
  if(vb <= 0 && d2 >= 0 && d6 <= 0){
    return out.copy(a).addScaledVector(_ac, d2/(d2-d6));
  }
  var va = d3*d6 - d5*d4;
  if(va <= 0 && (d4-d3) >= 0 && (d5-d6) >= 0){
    _bc.subVectors(c, b);
    return out.copy(b).addScaledVector(_bc, (d4-d3)/((d4-d3)+(d5-d6)));
  }
  var denom = 1/(va+vb+vc);
  return out.copy(a).addScaledVector(_ab, vb*denom).addScaledVector(_ac, vc*denom);
}

/* vertex -> incident triangles, built once and cached on the geometry */
function adjacencyOf(geom){
  if(geom.userData._adj) return geom.userData._adj;
  var idx = geom.index, n = geom.attributes.position.count;
  var adj = new Array(n), i, t;
  for(i=0;i<n;i++) adj[i] = null;
  function add(v, tri){
    if(adj[v] === null) adj[v] = [tri];
    else if(adj[v].length < 12) adj[v].push(tri);   // cap: a fan is enough
  }
  if(idx){
    for(i=0, t=0; i<idx.count; i+=3, t++){
      add(idx.getX(i), t); add(idx.getX(i+1), t); add(idx.getX(i+2), t);
    }
  } else {
    for(i=0, t=0; i<n; i+=3, t++){ add(i, t); add(i+1, t); add(i+2, t); }
  }
  geom.userData._adj = adj;
  return adj;
}

/* Nearest point on the guide SURFACE to a ray — the clamp-to-silhouette
   fallback. Two stages: a brute-force sweep for the nearest vertex (~6k tests
   on a 96x65 grid, cheap), then a few refinement steps against the triangles
   incident to it. Snapping to the vertex alone quantised the clamp to the
   grid — visibly stair-stepped when a stroke ran off the edge. */
var _tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

function nearestOnGuide(ray){
  var mesh = G.active.mesh, geom = mesh.geometry;
  var pos = geom.attributes.position, nor = geom.attributes.normal;
  mesh.updateMatrixWorld();
  var m = mesh.matrixWorld;

  var p = new THREE.Vector3(), best = -1, bestD = Infinity, i;
  for(i=0;i<pos.count;i++){
    p.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
    var d = ray.distanceSqToPoint(p);
    if(d < bestD){ bestD = d; best = i; }
  }
  if(best < 0) return null;

  var vert = new THREE.Vector3(pos.getX(best), pos.getY(best), pos.getZ(best))
               .applyMatrix4(m);
  var result = vert.clone();

  var adj = adjacencyOf(geom);
  var tris = adj[best];
  if(tris && tris.length){
    var idx = geom.index;
    var target = new THREE.Vector3(), cand = new THREE.Vector3();
    ray.closestPointToPoint(vert, target);           // seed
    /* alternate: closest surface point to the ray point, then closest ray
       point to that. Converges in a couple of passes. */
    for(var pass=0; pass<3; pass++){
      var localBest = null, localD = Infinity;
      for(var k=0;k<tris.length;k++){
        var t3 = tris[k]*3;
        for(var c=0;c<3;c++){
          var vi = idx ? idx.getX(t3+c) : (t3+c);
          _tri[c].set(pos.getX(vi), pos.getY(vi), pos.getZ(vi)).applyMatrix4(m);
        }
        closestPtTriangle(target, _tri[0], _tri[1], _tri[2], cand);
        var dd = cand.distanceToSquared(target);
        if(dd < localD){ localD = dd; localBest = cand.clone(); }
      }
      if(!localBest) break;
      result.copy(localBest);
      ray.closestPointToPoint(result, target);
    }
  }

  var n = new THREE.Vector3(nor.getX(best), nor.getY(best), nor.getZ(best))
            .applyMatrix3(new THREE.Matrix3().getNormalMatrix(m)).normalize();
  return { point:result, normal:n, onSurface:false };
}

/* ==========================================================================
   11. Guide as occlusion / isolation mask  (A.9)
   --------------------------------------------------------------------------
   FACT: "Prevented curves behind planes from being erased or selected";
   "3D guide can now be used as a filter." So: a point that the guide hides
   from the current viewpoint is protected.
   ========================================================================== */
var _dir = new THREE.Vector3(), _org = new THREE.Vector3();

G.isMasked = function(worldPoint){
  if(!G.isolate || !G.hasActive()) return false;
  var cam = P.cam(), dist;
  if(P.VIEW.ortho){
    cam.getWorldDirection(_dir);
    _org.copy(worldPoint).addScaledVector(_dir, -1000);
    dist = 1000;
  } else {
    _org.copy(cam.position);
    _dir.subVectors(worldPoint, _org);
    dist = _dir.length();
    if(dist < EPS) return false;
    _dir.multiplyScalar(1/dist);
  }
  _ray.set(_org, _dir);
  _ray.near = 0;
  _ray.far  = dist - 1e-3;
  var hits = _ray.intersectObject(G.active.mesh, false);
  return hits.length > 0;
};

/* ==========================================================================
   12. Ray-pick a guide (Select tool long-press, A.5)
   ========================================================================== */
G.pick = function(x, y){
  if(!G.hasActive()) return null;
  var r = P.rayFrom(x,y);
  var hits = r.intersectObject(G.active.mesh, false);
  return hits.length ? G.active : null;
};

/* world-space centre of a guide, for framing and for the bend draw plane */
G.centreOf = function(g){
  if(!g || !g.mesh) return P.VIEW.pivot.clone();
  var b = new THREE.Box3().setFromObject(g.obj);
  return b.isEmpty() ? P.VIEW.pivot.clone() : b.getCenter(new THREE.Vector3());
};

G.root = root;

})(window.P);
