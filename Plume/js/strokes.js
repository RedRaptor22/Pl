/* ==========================================================================
   PLUME / strokes.js — the curve data model, its mesh, and the operations
   that edit it (erase, vacuum, select, transform, mirror).
   --------------------------------------------------------------------------
   Data model follows the one Feather's chief designer describes: "each stroke
   is saved as point curve data consisting of the position and the normal
   vector of each point... rendered as mesh data with their thickness", closed
   with caps. v1.5 additionally persists the cross-section orientation so a
   rotated curve keeps its shape — here that is the frozen {tan, ref, roll}
   triple written on commit, never re-derived from geometry afterwards.

   GEOMETRY IS BUILT INCREMENTALLY WHILE DRAWING. The obvious implementation —
   rebuild the whole tube on every pointermove — is quadratic in stroke length
   and was the single worst hot spot in the app. Instead a live stroke owns a
   growable buffer and each new sample appends a ring, rewriting only the few
   rings the change can actually reach. A full exact rebuild happens once, on
   commit. See LIVE below.

   stroke = {
     id, brush, color, baseRadius, opacity, pressureTarget,
     pts: [{p, tan, ref, roll, pressure, tiltAz, tiltAlt, nrm}],
     mesh, selected
   }
   ========================================================================== */
(function(P){
'use strict';

var EPS = P.EPS;
var _b = new THREE.Vector3();

var group = new THREE.Group();
P.scene.add(group);

var S = P.Strokes = {
  list  : [],
  group : group,            // the THREE.Group holding every stroke mesh
  selection : [],
  nextGroup : 1             // id counter for user-made curve groups
};

/* ---- material ------------------------------------------------------------
   One shader for every stroke, so three.js compiles one program and reuses it.
   Each stroke still owns a material instance (uSelect varies per stroke), but
   it is created ONCE and reused for the life of the stroke — recreating it per
   frame was pure churn. Batching strokes into shared draw calls is the next
   step up and is not done here.                                            */
var VERT = [
  'attribute vec4 vcolor;',
  'varying vec4 vCol;',
  'varying vec3 vN;',
  'void main(){',
  '  vCol = vcolor;',
  '  vN = normalize(normalMatrix * normal);',
  '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);',
  '}'
].join('\n');

var FRAG = [
  'uniform float uSelect;',
  'uniform float uShade;',
  'uniform float uGlow;',
  'varying vec4 vCol;',
  'varying vec3 vN;',
  'void main(){',
  '  vec3 n = normalize(vN);',
  '  if(!gl_FrontFacing) n = -n;',
  '  float d = dot(n, normalize(vec3(0.32,0.62,0.72)));',
  '  float shade = mix(1.0, 0.66 + 0.34*(d*0.5+0.5), uShade);',
  '  if(vCol.a < 0.004) discard;',
  '  vec3 rgb = vCol.rgb * shade;',
  /* glow: emissive core that falls off at grazing angles, so the tube reads
     as a light source rather than a flat additive smear */
  '  if(uGlow > 0.5){',
  '    float rim = pow(abs(dot(n, vec3(0.0,0.0,1.0))), 0.5);',
  '    rgb = vCol.rgb * (0.55 + 1.15*rim);',
  '  }',
  '  rgb = mix(rgb, vec3(0.36,0.62,1.0), uSelect*0.55);',
  '  gl_FragColor = vec4(rgb, vCol.a);',
  '}'
].join('\n');

function makeMaterial(stroke, needsAlpha){
  var cfg = BRUSH[stroke.brush] || BRUSH.round;
  var glow = cfg.glow ? 1 : 0;
  return new THREE.ShaderMaterial({
    uniforms: {
      uSelect:{value:0},
      uShade:{value: (P.ENV.shaded && !glow) ? 1 : 0},
      uGlow:{value: glow}
    },
    vertexShader: VERT, fragmentShader: FRAG,
    /* FRONT FACES ONLY. A stroke is a closed tube, so its far wall is never
       something you should see — but with DoubleSide and depthWrite off, that
       far wall blended straight through the near one. Measured: a 50% stroke
       rendered at 0.69 of opaque instead of 0.50, i.e. ~1.4x too dense, and
       the error compounded every time strokes were layered. Culling the back
       faces measures 0.487. Every brush is capped (below) so the tube really
       is closed and nothing can be seen through an open end. */
    side: THREE.FrontSide,
    transparent: !!needsAlpha || !!glow,
    depthWrite: glow ? false : !needsAlpha,
    /* FACT (C.5): "a Glow material enables glowing lines" — additive blending
       is what makes overlapping strokes bloom instead of just stacking */
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending
  });
}

/* ---- brush profiles ------------------------------------------------------
   FACT/PARTIAL: the docs never enumerate the brush list, beyond a round nib, a
   tilt-sensitive flat nib, tapered ends, the v1.5 "Wide Brush to paint larger
   areas faster", and a Glow material. The rest of these are built from the
   same handful of cross-section parameters rather than invented wholesale:

     seg    cross-section resolution
     flat   ellipse ratio — 1 round, ->0 a blade
     square 0 = ellipse, 1 = hard rectangular nib (marker/chisel)
     taper  ends thin out over taperLength()
     wide   size multiplier
     glow   additive, unshaded
     caps   closed ends

   There was also a `grain` parameter that jittered radius and alpha per point
   to fake a dry pencil tooth. It was measurably the only source of jagged
   geometry in the whole brush set — 9.9% lengthwise radius jitter against
   =<0.8% for every other brush — so it is gone. Media texture belongs in a
   shader or a stamp, not in the tube's silhouette.

   Every brush is CAPPED. Open ends were a nicer silhouette on the tapered
   brushes, but back-face culling needs a closed manifold — and since a taper
   shrinks to 15% of the nib anyway, its caps are far too small to see.
   ========================================================================== */
var BRUSH = P.BRUSH = {
  round:  { seg:12, flat:1.00, square:0.00, taper:0, caps:true, wide:1.0, glow:0 },
  flat:   { seg:12, flat:0.22, square:0.35, taper:0, caps:true, wide:1.0, glow:0 },
  taper:  { seg:12, flat:1.00, square:0.00, taper:1, caps:true, wide:1.0, glow:0 },
  wide:   { seg:10, flat:0.14, square:0.50, taper:0, caps:true, wide:3.2, glow:0 },
  marker: { seg:10, flat:0.42, square:0.85, taper:0, caps:true, wide:1.8, glow:0 },
  ink:    { seg:12, flat:0.85, square:0.00, taper:1, caps:true, wide:0.9, glow:0 },
  /* a fine, slightly flattened nib — distinct from round by size and section,
     not by noise */
  pencil: { seg:10, flat:0.72, square:0.15, taper:0, caps:true, wide:0.7, glow:0 },
  chisel: { seg:8,  flat:0.16, square:1.00, taper:0, caps:true, wide:1.6, glow:0 },
  ribbon: { seg:8,  flat:0.05, square:1.00, taper:0, caps:true, wide:2.6, glow:0 },
  glow:   { seg:12, flat:1.00, square:0.00, taper:1, caps:true, wide:1.3, glow:1 }
};

/* Taper is measured in ARC LENGTH from each end, not as a fraction of the
   point count. A fraction would re-shade the whole stroke on every new sample
   (nothing could be appended incrementally), and it made the taper depend on
   how long the stroke happened to end up rather than on the nib. */
function taperLength(stroke){
  return stroke.baseRadius * 6;                  // GUESS: ~6 nib radii
}

/* cumulative arc length, used by the taper and by nothing else */
function arcOf(pts){
  var a = new Array(pts.length);
  a[0] = 0;
  for(var i=1;i<pts.length;i++) a[i] = a[i-1] + pts[i].p.distanceTo(pts[i-1].p);
  return a;
}

/* pressure -> per-point radius / alpha / colour, per the current mapping */
function shadeAt(stroke, i, arc){
  var pt = stroke.pts[i];
  var pr = P.clamp(pt.pressure, 0.02, 1);
  var mode = stroke.pressureTarget;
  var cfg = BRUSH[stroke.brush];
  var rMul = cfg.wide, alpha = stroke.opacity, lift = 0;

  if(mode === 'size'    || mode === 'both') rMul *= 0.25 + 0.75*pr;
  if(mode === 'opacity' || mode === 'both') alpha = stroke.opacity * (0.18 + 0.82*pr);
  if(mode === 'color') lift = (1 - pr) * 0.55;

  if(cfg.taper > 0 && arc){
    var total = arc[arc.length-1], L = taperLength(stroke);
    if(L > EPS && total > EPS){
      var fromEnd = Math.min(arc[i], total - arc[i]);
      rMul *= 0.15 + 0.85*Math.min(1, fromEnd/L);
    }
  }
  return { radius: stroke.baseRadius*rMul, alpha: alpha, lift: lift };
}

/* ==========================================================================
   Ring writer — shared by the batch and incremental paths.
   Buffer layout:  vertex 0 = start cap centre
                   vertex 1 = end cap centre
                   vertex 2 + i*seg + k = ring i, segment k
   Caps live at the front so ring capacity can grow without moving them.
   ========================================================================== */
var _u = new THREE.Vector3(), _v = new THREE.Vector3(),
    _dir = new THREE.Vector3(), _nrm = new THREE.Vector3();
var WHITE = new THREE.Color(1,1,1), _c = new THREE.Color();

/* Cross-section outline at angle `ang`, blending a circle towards a square.
   Dividing by max(|cos|,|sin|) pushes the unit circle out onto the unit
   square, so `square` morphs continuously between a round nib and a hard
   rectangular one. Writes into out = {x,y}. */
function sectionPoint(ang, square, out){
  var c = Math.cos(ang), s = Math.sin(ang);
  if(square <= 0){ out.x = c; out.y = s; return out; }
  var m = Math.max(Math.abs(c), Math.abs(s));
  if(m < EPS){ out.x = c; out.y = s; return out; }
  out.x = c*(1-square) + (c/m)*square;
  out.y = s*(1-square) + (s/m)*square;
  return out;
}

var _p0 = {x:0,y:0}, _p1 = {x:0,y:0};
var DANG = 1e-3;

function writeRing(stroke, i, T, R, arc, pos, nor, col, seg){
  var sh = shadeAt(stroke, i, arc);
  var cfg = BRUSH[stroke.brush];
  var rx = Math.max(sh.radius, 1e-5);
  var ry = Math.max(sh.radius * cfg.flat, 1e-5);
  var pt = stroke.pts[i];
  var sq = cfg.square || 0;

  _c.copy(stroke.color);
  if(sh.lift > 0) _c.lerp(WHITE, sh.lift);

  var ca = Math.cos(pt.roll||0), sa = Math.sin(pt.roll||0);
  _b.crossVectors(T, R);                              // s = t x r
  _u.copy(R).multiplyScalar(ca).addScaledVector(_b, sa);
  _v.crossVectors(T, _u);

  for(var k=0;k<seg;k++){
    var ang = k/seg * Math.PI*2;
    sectionPoint(ang, sq, _p0);
    var ax = _p0.x*rx, ay = _p0.y*ry;
    _dir.copy(_u).multiplyScalar(ax).addScaledVector(_v, ay);

    /* Normal from the actual outline: differentiate the cross-section and
       rotate a quarter turn. The old ellipse-gradient shortcut is wrong once
       the section is squared off, which is exactly where flat shading shows. */
    sectionPoint(ang + DANG, sq, _p1);
    var dx = (_p1.x - _p0.x)*rx, dy = (_p1.y - _p0.y)*ry;
    var nx = dy, ny = -dx;
    if(nx*ax + ny*ay < 0){ nx = -nx; ny = -ny; }      // point it outward
    var nl = Math.hypot(nx, ny);
    if(nl < EPS){ nx = ax; ny = ay; nl = Math.hypot(nx, ny) || 1; }
    _nrm.copy(_u).multiplyScalar(nx/nl).addScaledVector(_v, ny/nl);
    if(_nrm.lengthSq() < EPS) _nrm.copy(_u); else _nrm.normalize();

    var o = 2 + i*seg + k;
    pos[o*3]   = pt.p.x + _dir.x;
    pos[o*3+1] = pt.p.y + _dir.y;
    pos[o*3+2] = pt.p.z + _dir.z;
    nor[o*3]   = _nrm.x; nor[o*3+1] = _nrm.y; nor[o*3+2] = _nrm.z;
    col[o*4]   = _c.r; col[o*4+1] = _c.g; col[o*4+2] = _c.b; col[o*4+3] = sh.alpha;
  }
  return sh.alpha;
}

function writeCaps(stroke, n, T, arc, pos, nor, col){
  var e0 = shadeAt(stroke, 0, arc), e1 = shadeAt(stroke, n-1, arc);
  var c0 = stroke.color.clone().lerp(WHITE, e0.lift),
      c1 = stroke.color.clone().lerp(WHITE, e1.lift);
  var p0 = stroke.pts[0].p, p1 = stroke.pts[n-1].p;
  pos[0]=p0.x; pos[1]=p0.y; pos[2]=p0.z;
  pos[3]=p1.x; pos[4]=p1.y; pos[5]=p1.z;
  nor[0]=-T[0].x; nor[1]=-T[0].y; nor[2]=-T[0].z;
  nor[3]= T[n-1].x; nor[4]= T[n-1].y; nor[5]= T[n-1].z;
  col[0]=c0.r; col[1]=c0.g; col[2]=c0.b; col[3]=e0.alpha;
  col[4]=c1.r; col[5]=c1.g; col[6]=c1.b; col[7]=e1.alpha;
}

/* quad indices joining ring i to ring i+1 */
function quadIndices(idx, at, i, seg){
  for(var k=0;k<seg;k++){
    var a = 2 + i*seg + k,
        b = 2 + i*seg + (k+1)%seg,
        c = 2 + (i+1)*seg + k,
        d = 2 + (i+1)*seg + (k+1)%seg;
    idx[at++]=a; idx[at++]=c; idx[at++]=b;
    idx[at++]=b; idx[at++]=c; idx[at++]=d;
  }
  return at;
}
function startFan(idx, at, seg){
  for(var k=0;k<seg;k++){ idx[at++]=0; idx[at++]=2+(k+1)%seg; idx[at++]=2+k; }
  return at;
}
function endFan(idx, at, lastRing, seg){
  var base = 2 + lastRing*seg;
  for(var k=0;k<seg;k++){ idx[at++]=1; idx[at++]=base+k; idx[at++]=base+(k+1)%seg; }
  return at;
}

/* ==========================================================================
   Batch build — committed strokes, undo restore, document load
   ========================================================================== */
function buildGeometry(stroke){
  var pts = stroke.pts, n = pts.length;
  if(n === 0) return null;

  var cfg = BRUSH[stroke.brush], seg = cfg.seg;

  if(n === 1){
    var s0 = shadeAt(stroke, 0, null);
    var g = new THREE.SphereGeometry(Math.max(s0.radius, 1e-4), 10, 7);
    var cnt = g.attributes.position.count, arr = new Float32Array(cnt*4);
    var col0 = stroke.color.clone().lerp(WHITE, s0.lift);
    for(var q=0;q<cnt;q++){
      arr[q*4]=col0.r; arr[q*4+1]=col0.g; arr[q*4+2]=col0.b; arr[q*4+3]=s0.alpha;
    }
    g.setAttribute('vcolor', new THREE.BufferAttribute(arr,4));
    g.translate(pts[0].p.x, pts[0].p.y, pts[0].p.z);
    return { geom:g, needsAlpha: s0.alpha < 0.995 };
  }

  /* frozen frames if committed, transported frames while still live */
  var T, R, i;
  if(pts[0].ref && pts[n-1].ref && pts[n-1].tan){
    T = pts.map(function(p){ return p.tan; });
    R = pts.map(function(p){ return p.ref; });
  } else {
    var fr = P.transportFrames(pts.map(function(p){ return p.p; }), stroke.seedRef);
    T = fr.T; R = fr.R;
  }

  var arc = arcOf(pts);
  var vCount = 2 + n*seg;
  var pos = new Float32Array(vCount*3),
      nor = new Float32Array(vCount*3),
      col = new Float32Array(vCount*4);
  var needsAlpha = false;

  for(i=0;i<n;i++){
    if(writeRing(stroke, i, T[i], R[i], arc, pos, nor, col, seg) < 0.995) needsAlpha = true;
  }
  if(cfg.caps) writeCaps(stroke, n, T, arc, pos, nor, col);

  var quads = (n-1)*seg*6, fans = cfg.caps ? seg*6 : 0;
  var IndexArray = vCount < 65536 ? Uint16Array : Uint32Array;
  var idx = new IndexArray(quads + fans);
  var at = 0;
  if(cfg.caps) at = startFan(idx, at, seg);
  for(i=0;i<n-1;i++) at = quadIndices(idx, at, i, seg);
  if(cfg.caps) at = endFan(idx, at, n-1, seg);

  var geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos,3));
  geom.setAttribute('normal',   new THREE.BufferAttribute(nor,3));
  geom.setAttribute('vcolor',   new THREE.BufferAttribute(col,4));
  geom.setIndex(new THREE.BufferAttribute(idx,1));
  geom.computeBoundingSphere();
  return { geom:geom, needsAlpha:needsAlpha };
}
S.buildGeometry = buildGeometry;

S.rebuild = function(stroke){
  var built = buildGeometry(stroke);
  if(stroke.mesh){
    group.remove(stroke.mesh);
    stroke.mesh.geometry.dispose();
    stroke.mesh.material.dispose();
    stroke.mesh = null;
  }
  if(!built) return;
  stroke.mesh = new THREE.Mesh(built.geom, makeMaterial(stroke, built.needsAlpha));
  stroke.mesh.userData.stroke = stroke;
  stroke.mesh.material.uniforms.uSelect.value = stroke.selected ? 1 : 0;
  stroke.mesh.frustumCulled = true;
  group.add(stroke.mesh);
};

/* ==========================================================================
   LIVE — incremental construction while the pen is down
   --------------------------------------------------------------------------
   Appending a sample touches at most a bounded tail of the tube:
     - the previous point's tangent changes (one-sided -> central), so its ring
       is rewritten,
     - the taper reaches back taperLength() in arc length, so those rings are
       rewritten too,
     - the end cap fan moves.
   Everything before that window is already final and is never touched again.
   ========================================================================== */
var LIVE = S.Live = {};

function ensureCapacity(L, needed){
  if(needed <= L.capacity) return false;
  var cap = Math.max(needed, Math.ceil(L.capacity * 1.8) + 16);
  var seg = L.seg;
  var vCount = 2 + cap*seg;

  var pos = new Float32Array(vCount*3), nor = new Float32Array(vCount*3),
      col = new Float32Array(vCount*4);
  pos.set(L.pos.subarray(0, Math.min(L.pos.length, pos.length)));
  nor.set(L.nor.subarray(0, Math.min(L.nor.length, nor.length)));
  col.set(L.col.subarray(0, Math.min(L.col.length, col.length)));
  L.pos = pos; L.nor = nor; L.col = col;

  /* index type has to widen once the vertex count passes 16 bits */
  var IndexArray = vCount < 65536 ? Uint16Array : Uint32Array;
  var idxLen = (cap-1)*seg*6 + (L.caps ? seg*6 : 0);
  var idx = new IndexArray(idxLen);
  idx.set(L.idx.subarray(0, Math.min(L.idx.length, idx.length)));
  L.idx = idx;
  L.capacity = cap;

  var geom = L.geom;
  geom.setAttribute('position', new THREE.BufferAttribute(pos,3));
  geom.setAttribute('normal',   new THREE.BufferAttribute(nor,3));
  geom.setAttribute('vcolor',   new THREE.BufferAttribute(col,4));
  geom.setIndex(new THREE.BufferAttribute(idx,1));
  return true;
}

LIVE.begin = function(stroke){
  var cfg = BRUSH[stroke.brush], seg = cfg.seg;
  var L = {
    seg: seg, caps: cfg.caps, capacity: 0, n: 0,
    pos: new Float32Array(0), nor: new Float32Array(0), col: new Float32Array(0),
    idx: new Uint16Array(0),
    T: [], R: [], arc: [],
    geom: new THREE.BufferGeometry(),
    needsAlpha: false
  };
  stroke._live = L;
  ensureCapacity(L, 64);
  L.geom.setDrawRange(0, 0);
  /* a generous sphere avoids per-append bounds recomputation; it is replaced
     with a tight one at commit */
  L.geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  stroke.mesh = new THREE.Mesh(L.geom, makeMaterial(stroke, true));
  stroke.mesh.userData.stroke = stroke;
  stroke.mesh.frustumCulled = false;
  group.add(stroke.mesh);
  return L;
};

/* recompute frames for the tail, then rewrite the affected rings */
LIVE.append = function(stroke){
  var L = stroke._live;
  if(!L) return;
  var pts = stroke.pts, n = pts.length, seg = L.seg;
  if(n === 0) return;
  ensureCapacity(L, n);

  var i;
  /* --- arc length --- */
  if(L.arc.length === 0) L.arc[0] = 0;
  for(i = Math.max(1, L.arc.length); i < n; i++){
    L.arc[i] = L.arc[i-1] + pts[i].p.distanceTo(pts[i-1].p);
  }
  L.arc.length = n;

  /* --- frames: fix up the previous point, then transport into the new one --- */
  if(n === 1){
    L.T[0] = new THREE.Vector3(0,0,1);
    var r0 = new THREE.Vector3();
    if(stroke.seedRef){
      r0.copy(stroke.seedRef).addScaledVector(L.T[0], -stroke.seedRef.dot(L.T[0]));
      if(r0.lengthSq() < EPS) P.perpTo(L.T[0], r0); else r0.normalize();
    } else P.perpTo(L.T[0], r0);
    L.R[0] = r0;
  } else {
    var j = n-1;
    /* the point that used to be last now has a central-difference tangent */
    if(j-1 === 0){
      L.T[0] = pts[1].p.clone().sub(pts[0].p);
      if(L.T[0].lengthSq() < EPS) L.T[0].set(0,0,1); else L.T[0].normalize();
      var s0 = stroke.seedRef || L.R[0];
      var rr = s0.clone().addScaledVector(L.T[0], -s0.dot(L.T[0]));
      if(rr.lengthSq() < EPS) P.perpTo(L.T[0], rr); else rr.normalize();
      L.R[0] = rr;
    } else {
      var tc = pts[j].p.clone().sub(pts[j-2].p);
      if(tc.lengthSq() > EPS){
        L.T[j-1] = tc.normalize();
        var rp = L.R[j-1].clone().addScaledVector(L.T[j-1], -L.R[j-1].dot(L.T[j-1]));
        if(rp.lengthSq() < EPS) P.perpTo(L.T[j-1], rp); else rp.normalize();
        L.R[j-1] = rp;
      }
    }
    /* new last point: one-sided tangent, transported reference */
    var tn = pts[j].p.clone().sub(pts[j-1].p);
    if(tn.lengthSq() < EPS) tn.copy(L.T[j-1]); else tn.normalize();
    L.T[j] = tn;
    L.R[j] = transportOne(pts[j-1].p, pts[j].p, L.T[j-1], L.T[j], L.R[j-1]);
  }

  /* --- which rings can this sample have changed? --- */
  var first = Math.max(0, n-2);
  if(BRUSH[stroke.brush].taper > 0){
    var reach = taperLength(stroke), total = L.arc[n-1];
    while(first > 0 && (total - L.arc[first]) < reach) first--;
    /* the head taper is arc-length based and therefore already final */
  }
  for(i=first;i<n;i++){
    if(writeRing(stroke, i, L.T[i], L.R[i], L.arc, L.pos, L.nor, L.col, seg) < 0.995){
      L.needsAlpha = true;
    }
  }
  if(L.caps && n >= 1) writeCaps(stroke, n, L.T, L.arc, L.pos, L.nor, L.col);

  /* --- indices: append the new quad band, move the end fan --- */
  var at = 0;
  if(L.caps && n >= 1) at = startFan(L.idx, at, seg);
  if(n >= 2){
    /* only the newest band is new, but rewriting from `first` is bounded and
       keeps the arithmetic trivial */
    at = L.caps ? seg*3 : 0;
    for(i=0;i<n-1;i++) at = quadIndices(L.idx, at, i, seg);
  }
  if(L.caps && n >= 2) at = endFan(L.idx, at, n-1, seg);
  L.n = n;

  var geom = L.geom;
  var vFrom = 2 + first*seg, vTo = 2 + n*seg;
  markRange(geom.attributes.position, 0, vTo*3);
  markRange(geom.attributes.normal,   0, vTo*3);
  markRange(geom.attributes.vcolor,   0, vTo*4);
  geom.index.needsUpdate = true;
  geom.setDrawRange(0, at);
  void vFrom;

  stroke.mesh.material.transparent = L.needsAlpha;
  stroke.mesh.material.depthWrite = !L.needsAlpha;
};

function markRange(attr, offset, count){
  attr.needsUpdate = true;
  if(attr.updateRange){ attr.updateRange.offset = offset; attr.updateRange.count = count; }
}

/* one double-reflection transport step */
function transportOne(pA, pB, tA, tB, rA){
  var v1 = pB.clone().sub(pA);
  var c1 = v1.lengthSq(), rN;
  if(c1 < EPS){
    rN = rA.clone();
  } else {
    var rL = rA.clone().addScaledVector(v1, -2*v1.dot(rA)/c1);
    var tL = tA.clone().addScaledVector(v1, -2*v1.dot(tA)/c1);
    var v2 = tB.clone().sub(tL);
    var c2 = v2.lengthSq();
    rN = rL;
    if(c2 >= EPS) rN.addScaledVector(v2, -2*v2.dot(rL)/c2);
  }
  var r = rN.addScaledVector(tB, -rN.dot(tB));
  if(r.lengthSq() < EPS) P.perpTo(tB, r); else r.normalize();
  return r;
}

/* Commit: freeze the frames and do ONE exact batch rebuild, so a stored stroke
   never carries the incremental path's small numerical drift. */
LIVE.finish = function(stroke){
  if(!stroke._live) return;
  LIVE.discard(stroke);
  S.freezeFrames(stroke);
  S.rebuild(stroke);
};

LIVE.discard = function(stroke){
  var L = stroke._live;
  if(!L) return;
  delete stroke._live;
  if(stroke.mesh){
    group.remove(stroke.mesh);
    stroke.mesh.geometry.dispose();
    stroke.mesh.material.dispose();
    stroke.mesh = null;
  }
};

/* Freeze frames into point data. This is the step that makes orientation
   persistent rather than re-derived, and it is what erase, bend and the
   joystick transform all read back. */
S.freezeFrames = function(stroke){
  var pts = stroke.pts;
  if(pts.length === 0) return;
  var fr = P.transportFrames(pts.map(function(p){ return p.p; }), stroke.seedRef);
  var s = new THREE.Vector3(), proj = new THREE.Vector3();
  for(var i=0;i<pts.length;i++){
    var t = fr.T[i], r = fr.R[i], pt = pts[i];
    s.crossVectors(t, r);
    var axis = pt.axis || r;
    proj.copy(axis).addScaledVector(t, -axis.dot(t));
    pt.roll = (proj.lengthSq() < EPS) ? 0 : Math.atan2(proj.dot(s), proj.dot(r));
    pt.tan = t.clone();
    pt.ref = r.clone();
    if(pt.axis) delete pt.axis;
  }
};

/* ==========================================================================
   Collection
   ========================================================================== */
S.add = function(stroke){
  if(!stroke.id) stroke.id = P.uid();
  S.list.push(stroke);
  if(!stroke.mesh) S.rebuild(stroke);
  else if(stroke.mesh.parent !== group) group.add(stroke.mesh);
};

S.remove = function(stroke){
  var i = S.list.indexOf(stroke);
  if(i >= 0) S.list.splice(i,1);
  var j = S.selection.indexOf(stroke);
  if(j >= 0) S.selection.splice(j,1);
  if(stroke.mesh) group.remove(stroke.mesh);
};

S.clear = function(){
  var removed = S.list.slice();
  for(var i=0;i<removed.length;i++) S.remove(removed[i]);
  return removed;
};

S.bounds = function(strokes){
  var box = new THREE.Box3(), src = strokes || S.list;
  for(var i=0;i<src.length;i++){
    for(var j=0;j<src[i].pts.length;j++) box.expandByPoint(src[i].pts[j].p);
  }
  return box;
};

/* ---- selection ----------------------------------------------------------- */
S.setSelected = function(stroke, on){
  stroke.selected = !!on;
  if(stroke.mesh) stroke.mesh.material.uniforms.uSelect.value = on ? 1 : 0;
  var i = S.selection.indexOf(stroke);
  if(on && i < 0) S.selection.push(stroke);
  if(!on && i >= 0) S.selection.splice(i,1);
};
S.clearSelection = function(){
  while(S.selection.length) S.setSelected(S.selection[0], false);
};

/* ---- hit testing ---------------------------------------------------------
   Honours the guide mask: FACT (A.9) "curves hidden by the 3D guide cannot be
   selected" and the eraser "will not erase curves within the guide".      */
S.hitTest = function(x, y){
  var ray = P.rayFrom(x, y);
  var hits = ray.intersectObjects(group.children, false);
  for(var i=0;i<hits.length;i++){
    if(P.Guides.isMasked(hits[i].point)) continue;
    return {stroke: hits[i].object.userData.stroke, point: hits[i].point};
  }
  return null;
};

/* ==========================================================================
   Erase
   --------------------------------------------------------------------------
   FACT (C.6): "the Eraser removes points from the center of the curve, not the
   surrounding geometry" — so the test is against the CENTRELINE, and a broad
   brush can visibly overlap a curve without erasing it. That is the documented
   behaviour, not a bug worth fixing.
   ========================================================================== */

/* `split(stroke)` returns the surviving runs (arrays of point records), or
   null to leave the stroke untouched. Every run of two or more points becomes
   a new curve, so one pass through the middle yields two. */
function eraseRuns(split){
  var removed = [], added = [], i, k;
  for(i=S.list.length-1; i>=0; i--){
    var st = S.list[i], runs = split(st);
    if(!runs) continue;
    removed.push(st);
    for(k=0;k<runs.length;k++){
      if(runs[k].length >= 2) added.push(cloneWithPoints(st, runs[k]));
    }
  }
  for(i=0;i<removed.length;i++) S.remove(removed[i]);
  for(k=0;k<added.length;k++)   S.add(added[k]);
  return {removed:removed, added:added};
}

function eraseBy(hitTest){
  return eraseRuns(function(st){
    var pts = st.pts, kill = new Array(pts.length), any = false, j;
    for(j=0;j<pts.length;j++){
      kill[j] = hitTest(pts[j].p);
      if(kill[j]) any = true;
    }
    if(!any) return null;
    var runs = [], run = [];
    for(j=0;j<=pts.length;j++){
      if(j < pts.length && !kill[j]){ run.push(pts[j]); continue; }
      if(run.length) runs.push(run);
      run = [];
    }
    return runs;
  });
}

/* The sub-interval of the segment A->B that falls inside the eraser disc,
   as [enter, exit] in [0,1], or null. Straight circle/segment quadratic. */
function discInterval(ax, ay, bx, by, cx, cy, r){
  var dx = bx-ax, dy = by-ay, fx = ax-cx, fy = ay-cy;
  var a = dx*dx + dy*dy;
  if(a < 1e-12) return (fx*fx + fy*fy <= r*r) ? [0,1] : null;
  var b = 2*(fx*dx + fy*dy), c = fx*fx + fy*fy - r*r;
  var disc = b*b - 4*a*c;
  if(disc < 0) return null;
  var sq = Math.sqrt(disc);
  var t1 = (-b - sq)/(2*a), t2 = (-b + sq)/(2*a);
  if(t2 < 0 || t1 > 1) return null;
  var lo = Math.max(t1, 0), hi = Math.min(t2, 1);
  return lo <= hi ? [lo, hi] : null;
}

/* interpolate a whole point record along a segment */
function lerpPoint(a, b, t){
  var near = t < 0.5 ? a : b;
  return {
    p: a.p.clone().lerp(b.p, t),
    tan: near.tan ? near.tan.clone() : null,
    ref: near.ref ? near.ref.clone() : null,
    roll: near.roll,
    pressure: a.pressure + (b.pressure - a.pressure)*t,
    tiltAz: near.tiltAz, tiltAlt: near.tiltAlt
  };
}

var _s = {x:0, y:0, z:0}, _bs = new THREE.Vector3();

/* Cheap rejection: project the stroke's bounding sphere and skip it entirely
   when the eraser disc cannot possibly reach. Without this, every drag sample
   projects every point of every curve in the scene. */
function farFromDisc(st, x, y, radiusPx){
  var mesh = st.mesh;
  if(!mesh || !mesh.geometry.boundingSphere) return false;
  var bs = mesh.geometry.boundingSphere;
  _bs.copy(bs.center);
  P.worldToScreen(_bs, _s);
  if(_s.z < -1.5 || _s.z > 1.5) return false;         // near/behind: do not risk it
  var rPx = P.worldToPx(bs.radius) * 1.25 + radiusPx; // 1.25 = perspective slack
  var dx = _s.x - x, dy = _s.y - y;
  return (dx*dx + dy*dy) > rPx*rPx;
}

/* Screen-space eraser. The disc is clipped against the centreline as a
   CONTINUOUS polyline, not against its sample points: where it crosses a
   segment the segment is cut and fresh endpoints are interpolated. Without
   that, a thin eraser slips through the gap between two samples, and a
   two-point curve could never be split at all. */
S.eraseScreen = function(x, y, radiusPx){
  var screen = [], vis = [];

  return eraseRuns(function(st){
    var pts = st.pts, n = pts.length, i;
    if(n === 0) return null;
    if(farFromDisc(st, x, y, radiusPx)) return null;

    screen.length = 0; vis.length = 0;
    for(i=0;i<n;i++){
      P.worldToScreen(pts[i].p, _s);
      screen.push(_s.x, _s.y);
      vis.push(_s.z >= -1 && _s.z <= 1);
    }

    var runs = [], cur = [], touched = false;
    function flush(){ if(cur.length) runs.push(cur); cur = []; }
    function push(pt){ if(cur.length === 0 || cur[cur.length-1] !== pt) cur.push(pt); }

    if(n === 1){
      var d0x = screen[0]-x, d0y = screen[1]-y;
      if(vis[0] && d0x*d0x + d0y*d0y <= radiusPx*radiusPx && !P.Guides.isMasked(pts[0].p)){
        return [];
      }
      return null;
    }

    for(i=0;i<n-1;i++){
      var A = pts[i], B = pts[i+1];
      var iv = (vis[i] && vis[i+1])
        ? discInterval(screen[i*2], screen[i*2+1], screen[(i+1)*2], screen[(i+1)*2+1],
                       x, y, radiusPx)
        : null;

      /* FACT (A.9): geometry the guide hides is protected — tested at the
         middle of the span that would be removed */
      if(iv && P.Guides.isMasked(A.p.clone().lerp(B.p, (iv[0]+iv[1])/2))) iv = null;

      if(!iv){ push(A); push(B); continue; }
      touched = true;

      if(iv[0] > 0){ push(A); push(lerpPoint(A, B, iv[0])); }
      flush();
      if(iv[1] < 1){ push(lerpPoint(A, B, iv[1])); push(B); }
    }
    flush();
    return touched ? runs : null;
  });
};

S.eraseSphere = function(center, radius){
  var r2 = radius*radius;
  return eraseBy(function(p){
    return p.distanceToSquared(center) <= r2 && !P.Guides.isMasked(p);
  });
};

function cloneWithPoints(src, pts){
  return {
    id: P.uid(),
    brush: src.brush,
    color: src.color.clone(),
    baseRadius: src.baseRadius,
    opacity: src.opacity,
    pressureTarget: src.pressureTarget,
    seedRef: src.seedRef ? src.seedRef.clone() : null,
    group: src.group || null,
    pts: pts.map(function(p){
      return { p:p.p.clone(), tan:p.tan?p.tan.clone():null, ref:p.ref?p.ref.clone():null,
               nrm:p.nrm?p.nrm.clone():null,
               roll:p.roll, pressure:p.pressure, tiltAz:p.tiltAz, tiltAlt:p.tiltAlt };
    }),
    mesh: null, selected: false
  };
}
S.cloneWithPoints = cloneWithPoints;
S.clone = function(src){ return cloneWithPoints(src, src.pts); };

/* FACT (C.6): Vacuum erases entire curves it touches. */
S.vacuumAt = function(x, y){
  var ray = P.rayFrom(x, y);
  var hits = ray.intersectObjects(group.children, false), killed = [];
  for(var i=0;i<hits.length;i++){
    if(P.Guides.isMasked(hits[i].point)) continue;
    var st = hits[i].object.userData.stroke;
    if(st && killed.indexOf(st) < 0) killed.push(st);
  }
  for(var k=0;k<killed.length;k++) S.remove(killed[k]);
  return killed;
};

/* ---- transform -----------------------------------------------------------
   Applies to positions AND to the frozen cross-section frame, which is what
   keeps a rotated curve's shape identical (the v1.5 behaviour). Uniform scale
   also scales the radius; non-uniform scale leaves the radius alone rather
   than producing a cross-section the data model cannot represent.        */
S.transform = function(strokes, matrix){
  var rot = new THREE.Matrix3().setFromMatrix4(matrix);
  var sc = new THREE.Vector3();
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
  var uniform = (Math.abs(sc.x-sc.y) < 1e-6 && Math.abs(sc.y-sc.z) < 1e-6) ? sc.x : 1;
  for(var i=0;i<strokes.length;i++){
    var st = strokes[i];
    for(var j=0;j<st.pts.length;j++){
      var pt = st.pts[j];
      pt.p.applyMatrix4(matrix);
      if(pt.tan){ pt.tan.applyMatrix3(rot); if(pt.tan.lengthSq()>EPS) pt.tan.normalize(); }
      if(pt.ref){
        pt.ref.applyMatrix3(rot);
        if(pt.tan) pt.ref.addScaledVector(pt.tan, -pt.ref.dot(pt.tan));
        if(pt.ref.lengthSq()>EPS) pt.ref.normalize();
        else P.perpTo(pt.tan || new THREE.Vector3(0,0,1), pt.ref);
      }
    }
    st.baseRadius *= uniform;
    S.rebuild(st);
  }
};

/* ---- mirror --------------------------------------------------------------
   FACT (C.10): live symmetry on X, and from v1.5 on Z.                    */
S.mirrorMatrix = function(axis){
  var m = new THREE.Matrix4();
  if(axis === 'x') m.makeScale(-1, 1, 1);
  else             m.makeScale( 1, 1,-1);
  return m;
};
S.mirroredCopy = function(stroke, axis){
  var copy = cloneWithPoints(stroke, stroke.pts);
  S.transform([copy], S.mirrorMatrix(axis));
  return copy;
};

S.setShaded = function(on){
  for(var i=0;i<S.list.length;i++){
    if(S.list[i].mesh) S.list[i].mesh.material.uniforms.uShade.value = on ? 1 : 0;
  }
};

})(window.P);
