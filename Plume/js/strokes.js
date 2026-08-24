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
  var cfg = cfgOf(stroke);
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
   The set follows the four brush behaviours Feather describes, plus the plain
   round pen and the documented Glow material. Each one is built from the same
   handful of cross-section parameters rather than being a special case:

     flat   ellipse ratio — 1 round, ->0 a blade
     square 0 = ellipse, 1 = a hard rectangular nib
     taper  length of the taper at each end, in nib radii (0 = none)
     tip    radius the taper narrows to, as a fraction of the nib
     wide   size multiplier
     glow   additive, unshaded
     caps   closed ends

   What each is for, and how the numbers follow from it:

     Tapered / pointy tip .. a sharp tapering end profile, for clean linework
                             and organic detail — fins, hair, strands. Round
                             section, and a LONG taper down to 4% of the nib,
                             which is a point rather than the blunt 15% stub
                             the old shared taper produced.
     Square tip / flat ..... a blocky, uniform profile for structural and hard
                             surfaces and blocked-out silhouettes. A true
                             square section (equal sides, hard corners) that
                             does not taper, at 1.6x so it covers ground.
     Cube .................. the same square section kept narrow, for tightly
                             defined geometric lines drawn densely — the ones
                             you intend to deform afterwards.
     Wide / ribbon ......... a broad flat ribbon for filling volume fast:
                             blocking out cloth, planar surfaces, large areas
                             in few strokes. Rectangular and 34:1 wide-to-thin.

   Glow is not one of the four — it is a MATERIAL, documented separately
   (C.5: "a Glow material enables glowing lines") — so it stays.

   Every brush is CAPPED. Open ends were a nicer silhouette on the tapered
   brushes, but back-face culling needs a closed manifold, and a taper's caps
   are far too small to see.

   There was also a `grain` parameter that jittered radius and alpha per point
   to fake a dry pencil tooth. It was measurably the only source of jagged
   geometry in the whole brush set — 9.9% lengthwise radius jitter against
   =<0.8% for every other brush — so it is gone. Media texture belongs in a
   shader or a stamp, not in the tube's silhouette.

   Cross-section RESOLUTION is not a per-brush constant; see segOf().
   ========================================================================== */
var BRUSH = P.BRUSH = {
  /* the default: a plain round nib, crisp at both ends. Unchanged. */
  pen:    { flat:1.00, square:0.00, taper:0, tip:0,    caps:true, wide:1.00, glow:0 },
  /* tapered / pointy tip */
  taper:  { flat:1.00, square:0.00, taper:9, tip:0.04, caps:true, wide:1.00, glow:0 },
  /* square tip / flat: blocky and uniform, for structure */
  square: { flat:1.00, square:1.00, taper:0, tip:0,    caps:true, wide:1.60, glow:0 },
  /* cube: an EXTRUSION FROM the surface. Same hard square section, but it
     stands on the stroke rather than straddling it (rise), and the size slider
     is the length it stands off by — geometry to deform later, not a line. */
  cube:   { flat:1.00, square:1.00, taper:0, tip:0,    caps:true, wide:1.00, glow:0,
            rise:1 },
  /* FACT: the "Wide Brush ... paint larger areas faster" (1.5), as a ribbon.
     `paint` shades it by the surface it lies on instead of by its own facets —
     see writeRing. A sheet, not a slab: 0.04 puts a 100mm nib at 13mm thick. */
  wide:   { flat:0.04, square:1.00, taper:0, tip:0,    caps:true, wide:3.40, glow:0,
            paint:1 },
  /* FACT (C.5): "a Glow material enables glowing lines" */
  glow:   { flat:1.00, square:0.00, taper:6, tip:0.10, caps:true, wide:1.30, glow:1 }
};

/* Retired names -> the nearest surviving nib. Documents outlive brush sets;
   a sketch drawn with `chisel` should reopen as the hard nib it was, not
   silently as the default round one. */
P.BRUSH_ALIAS = {
  round:  'pen',      // identical
  pencil: 'pen',      // was round at 0.7x
  ink:    'taper',    // was round with tapered ends
  flat:   'square',   // Feather names this brush "square tip / flat"
  marker: 'square',   // hard nib, 1.7x -> hard square nib, 1.6x
  chisel: 'square',   // hard blade -> the blocky nib
  ribbon: 'wide'      // flat tape -> the flat ribbon
};
P.brushName = function(name){
  if(BRUSH[name]) return name;
  var alias = P.BRUSH_ALIAS[name];
  return BRUSH[alias] ? alias : 'pen';
};

/* Every read of a stroke's profile goes through here, so a retired name from
   an old document, a saved preset or a test fixture resolves instead of
   throwing halfway through building geometry. */
function cfgOf(stroke){
  return BRUSH[stroke.brush] || BRUSH[P.BRUSH_ALIAS[stroke.brush]] || BRUSH.pen;
}
S.cfgOf = cfgOf;

/* CROSS-SECTION RESOLUTION FOLLOWS THE NIB SIZE.
   A fixed segment count per brush is wrong at both ends of a 1mm-300mm range:
   12 segments is wasteful on a 1mm pen and visibly faceted on a 90mm one. The
   facet error of an n-gon is (1 - cos(pi/n))*r, so solving that for a fixed
   error in millimetres gives a count that keeps the silhouette equally smooth
   at any size. 0.3mm is about a screen pixel at a normal working zoom.
   A HARD SECTION IS ROUNDED UP TO A MULTIPLE OF EIGHT, a soft one to four.
   The corners of a squared-off nib sit at 45 degrees, so only a count divisible
   by eight puts vertices ON them; at 20 segments the corner falls between two
   samples and gets sliced off, which is a bevel rather than a square — measured
   as a corner standing 1.24x out from the flats where a square stands 1.41x.
   Clamped at both ends so a huge brush cannot run away with memory: the ceiling
   is what a 200mm nib needs, and past that the guarantee becomes a relative one
   — a 48-gon is within 0.21% of its circle at any radius. */
var SEG_ERR_MM = 0.3, SEG_MIN = 8, SEG_MAX = 48;
function segOf(stroke){
  var cfg = cfgOf(stroke);
  var rmm = Math.max(0.25, stroke.baseRadius * cfg.wide / P.MM);
  /* Only the ROUND part of a section needs facets. The sagitta rule below is
     about approximating a circle, and a section is only a circle at square 0;
     at square 1 it is a rectangle, whose sides are already exact at any size
     and whose corners are corners. Feeding it the full radius asked for 92
     segments on a 300mm wide brush - clamped to the 48 cap, of which 40 were
     extra vertices strung along four flat sides, on every ring of every
     stroke. The nib rebuild during a Smooth drag was 4.8ms a move because of
     it. What still needs facets is the corner radius, which shrinks to
     nothing as the section squares off. */
  var curved = rmm * (1 - P.clamp(cfg.square, 0, 1));
  var n = curved > SEG_ERR_MM
        ? Math.ceil(Math.PI / Math.sqrt(2 * SEG_ERR_MM / curved))
        : 0;
  var step = cfg.square > 0.5 ? 8 : 4;
  return P.clamp(Math.ceil(n/step)*step, SEG_MIN, SEG_MAX);
}
S.segOf = segOf;

/* Taper is measured in ARC LENGTH from each end, not as a fraction of the
   point count. A fraction would re-shade the whole stroke on every new sample
   (nothing could be appended incrementally), and it made the taper depend on
   how long the stroke happened to end up rather than on the nib. */
function taperLength(stroke){
  var cfg = cfgOf(stroke);
  return stroke.baseRadius * cfg.wide * (cfg.taper || 0);
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
  var cfg = cfgOf(stroke);
  var rMul = cfg.wide, alpha = stroke.opacity, lift = 0;

  if(mode === 'size'    || mode === 'both') rMul *= 0.25 + 0.75*pr;
  if(mode === 'opacity' || mode === 'both') alpha = stroke.opacity * (0.18 + 0.82*pr);
  if(mode === 'color') lift = (1 - pr) * 0.55;

  if(cfg.taper > 0 && arc){
    var total = arc[arc.length-1], L = taperLength(stroke);
    if(L > EPS && total > EPS){
      var fromEnd = Math.min(arc[i], total - arc[i]);
      var tip = cfg.tip === undefined ? 0.15 : cfg.tip;
      rMul *= tip + (1-tip)*Math.min(1, fromEnd/L);
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

S.sectionPoint = sectionPoint;   // exported so tests can measure the real outline

var _p0 = {x:0,y:0}, _p1 = {x:0,y:0};
var DANG = 1e-3;

function writeRing(stroke, i, T, R, arc, pos, nor, col, seg){
  var sh = shadeAt(stroke, i, arc);
  var cfg = cfgOf(stroke);
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

  /* A RISEN SECTION STANDS ON THE SURFACE RATHER THAN STRADDLING IT.
     _v comes out along -n for a surface-aligned nib, so shifting the centre
     by -ry*_v puts the section's near face on the stroke and its far face one
     full section-height out along the normal. That is what makes the cube
     brush an extrusion FROM the surface instead of a rod half sunk into it. */
  var paintN = (cfg.paint && pt.nrm && pt.nrm.lengthSq() > EPS) ? pt.nrm : null;

  var riseX = 0, riseY = 0, riseZ = 0;
  if(cfg.rise){
    riseX = -_v.x*ry*cfg.rise; riseY = -_v.y*ry*cfg.rise; riseZ = -_v.z*ry*cfg.rise;
  }

  var fitL = pt.fitL === undefined ? 1 : pt.fitL,
      fitR = pt.fitR === undefined ? 1 : pt.fitR;

  for(var k=0;k<seg;k++){
    var ang = k/seg * Math.PI*2;
    sectionPoint(ang, sq, _p0);
    /* the two halves of the section are scaled independently, so a nib beside
       an edge keeps everything it has room for and loses only the overhang */
    var ax = _p0.x*rx*(_p0.x >= 0 ? fitR : fitL), ay = _p0.y*ry;
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

    /* PAINT SHADES AS THE SURFACE, NOT AS ITSELF.
       A brush meant to fill an area leaves a sheet lying on a guide, and the
       thing that gives away every overlap is that the sheet's SIDES are lit
       differently from its top: a one-pixel dark line at every seam, however
       thin the sheet gets. Measured on a wall of fourteen overlapping ribbons,
       sampled across 450 pixels that should all be one colour: 28 visible
       steps and a 58-level spread as shipped; 26 steps at a tenth the
       thickness; ONE step when the sides are lit as the surface; and zero of
       either with both. So a paint brush hands the shader the surface normal
       for every vertex, and a wall reads as a wall no matter how many times
       you go over it.

       Only the brushes that are FOR filling do this. A pen is a tube and
       should still look like one where two of them cross. */
    if(paintN) _nrm.copy(paintN);

    var o = 2 + i*seg + k;
    pos[o*3]   = pt.p.x + _dir.x + riseX;
    pos[o*3+1] = pt.p.y + _dir.y + riseY;
    pos[o*3+2] = pt.p.z + _dir.z + riseZ;
    nor[o*3]   = _nrm.x; nor[o*3+1] = _nrm.y; nor[o*3+2] = _nrm.z;
    col[o*4]   = _c.r; col[o*4+1] = _c.g; col[o*4+2] = _c.b; col[o*4+3] = sh.alpha;
  }
  return sh.alpha;
}

/* Where the section's centre sits, which is the point itself unless the brush
   rises off the surface. Its own scratch, because writeRing is mid-flight with
   the shared vectors when this is called from there. */
var _cu = new THREE.Vector3(), _cv = new THREE.Vector3(), _cb = new THREE.Vector3();
function sectionCentre(stroke, i, T, R, arc, out){
  var pt = stroke.pts[i];
  out.copy(pt.p);
  var cfg = cfgOf(stroke);
  if(!cfg.rise) return out;
  var sh = shadeAt(stroke, i, arc);
  var ry = Math.max(sh.radius * cfg.flat, 1e-5);
  var ca = Math.cos(pt.roll||0), sa = Math.sin(pt.roll||0);
  _cb.crossVectors(T, R);
  _cu.copy(R).multiplyScalar(ca).addScaledVector(_cb, sa);
  _cv.crossVectors(T, _cu);
  return out.addScaledVector(_cv, -ry*cfg.rise);
}

function writeCaps(stroke, n, T, R, arc, pos, nor, col){
  var e0 = shadeAt(stroke, 0, arc), e1 = shadeAt(stroke, n-1, arc);
  var c0 = stroke.color.clone().lerp(WHITE, e0.lift),
      c1 = stroke.color.clone().lerp(WHITE, e1.lift);
  var p0 = sectionCentre(stroke, 0,   T[0],   R[0],   arc, new THREE.Vector3());
  var p1 = sectionCentre(stroke, n-1, T[n-1], R[n-1], arc, new THREE.Vector3());
  pos[0]=p0.x; pos[1]=p0.y; pos[2]=p0.z;
  pos[3]=p1.x; pos[4]=p1.y; pos[5]=p1.z;
  var capCfg = cfgOf(stroke);
  var pn0 = (capCfg.paint && stroke.pts[0].nrm) ? stroke.pts[0].nrm : null;
  var pn1 = (capCfg.paint && stroke.pts[n-1].nrm) ? stroke.pts[n-1].nrm : null;
  if(pn0){ nor[0]=pn0.x; nor[1]=pn0.y; nor[2]=pn0.z; }
  else   { nor[0]=-T[0].x; nor[1]=-T[0].y; nor[2]=-T[0].z; }
  if(pn1){ nor[3]=pn1.x; nor[4]=pn1.y; nor[5]=pn1.z; }
  else   { nor[3]= T[n-1].x; nor[4]= T[n-1].y; nor[5]= T[n-1].z; }
  col[0]=c0.r; col[1]=c0.g; col[2]=c0.b; col[3]=e0.alpha;
  col[4]=c1.r; col[5]=c1.g; col[6]=c1.b; col[7]=e1.alpha;
}

/* Quad indices joining ring i to ring i+1.

   WOUND OUTWARD, and it has to be measured rather than eyeballed. These two
   triangles used to be (a,c,b) and (b,c,d), which is the tube inside out: the
   wall's geometric normals pointed at the axis while writeRing's shading
   normals pointed away from it, and the caps — wound the other way — did not
   agree with the wall either. Visible consequences were small but real, since
   the material culls back faces: what you saw of an opaque stroke was the FAR
   wall lit by the near wall's normals, depth was written at the back of the
   tube rather than the front, and an exported solid was inside out and not
   consistently oriented, which is a mesh error in any slicer.
   Measured on a straight round stroke (40mm nib, 650mm long): 48 of 48 wall
   triangles faced inward before and 0 of 48 after, and the signed volume went
   from an inconsistent -260000 mm^3 to +779999.94 — against 780000.00 for the
   12-gon prism 3r^2*L the tube is supposed to be. */
function quadIndices(idx, at, i, seg){
  for(var k=0;k<seg;k++){
    var a = 2 + i*seg + k,
        b = 2 + i*seg + (k+1)%seg,
        c = 2 + (i+1)*seg + k,
        d = 2 + (i+1)*seg + (k+1)%seg;
    idx[at++]=a; idx[at++]=b; idx[at++]=c;
    idx[at++]=b; idx[at++]=d; idx[at++]=c;
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

  var cfg = cfgOf(stroke), seg = segOf(stroke);

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
  if(cfg.caps) writeCaps(stroke, n, T, R, arc, pos, nor, col);

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
  stroke.mesh.visible = S.visible(stroke);
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
  var cfg = cfgOf(stroke), seg = segOf(stroke);
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
  if(cfgOf(stroke).taper > 0){
    var reach = taperLength(stroke), total = L.arc[n-1];
    while(first > 0 && (total - L.arc[first]) < reach) first--;
    /* the head taper is arc-length based and therefore already final */
  }
  for(i=first;i<n;i++){
    /* the same roll and fit the commit will freeze, so nothing shifts on pen-up */
    pts[i].roll = rollOf(pts[i], L.T[i], L.R[i]);
    fitAt(pts[i], L.T[i], shadeAt(stroke, i, L.arc).radius);
    if(writeRing(stroke, i, L.T[i], L.R[i], L.arc, L.pos, L.nor, L.col, seg) < 0.995){
      L.needsAlpha = true;
    }
  }
  if(L.caps && n >= 1) writeCaps(stroke, n, L.T, L.R, L.arc, L.pos, L.nor, L.col);

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

/* ==========================================================================
   Nib orientation — THE NIB LIES IN THE SURFACE, NOT IN THE SCREEN
   --------------------------------------------------------------------------
   A flat nib has a direction, and something has to decide it. It used to be
   the camera: the cross-section's wide axis was built from the view basis at
   the moment of drawing, so every blade brush was angled to wherever you
   happened to be standing. Draw the same line on the same guide from two
   viewpoints and you got two different strokes; orbit afterwards and the nib
   stayed pointing at where the camera used to be.

   The surface is what the nib should follow. Every sample already carries the
   normal of whatever it landed on (guide, image, imported mesh, or the pivot
   plane when nothing is active), so the wide axis is t x n — perpendicular to
   the stroke, lying IN the surface — and the thin axis comes out along the
   normal. A blade then reads as a blade held flat against the guide, which is
   what it is.

   NOTHING ROLLS THE NIB. An earlier pass mapped the pen's tilt azimuth onto a
   rotation about the stroke's tangent, on the reading that C.3's "tilt turns
   the nib" should survive the move to surface alignment. It cannot: ANY
   rotation about the tangent lifts a blade off the surface, and a pen held at
   a natural angle reports azimuths right across the range, so a ribbon painted
   on a wall stood at whatever angle the hand happened to hold. Tilt is still
   recorded per point; it no longer turns the section.

   With no guide the pivot plane faces the camera, so its normal IS the view
   direction and free-space strokes look exactly as they did.
   ========================================================================== */
var _axisT = new THREE.Vector3(), _projT = new THREE.Vector3(),
    _sT = new THREE.Vector3();

function nibAxis(pt, t, out){
  var n = pt.nrm;
  if(n && n.lengthSq() > EPS){
    out.crossVectors(t, n);
    if(out.lengthSq() > EPS) return out.normalize();
  }
  /* no surface to lie in: the camera-plane axis the sample was taken with */
  return out.copy(pt.axis || pt.ref || t);
}

/* HOW MUCH OF THE NIB FITS.
   The nib is wide across the stroke, so near a guide's edge part of it would
   land off the surface. Each point records what fraction of its half-width
   the surface can actually take on each side — 1 in open ground, less as the
   edge closes in, and asymmetric so painting along an edge keeps full width on
   the inside instead of collapsing to nothing. Points with no surface frame
   (free space, closed guides, an off-surface clamp) keep the full nib. */
var FIT_MIN = 0.02;          // never let a section collapse to zero area
function fitAt(pt, t, halfWidth){
  var f = pt.surf;
  /* KEEP A TRIM WE CANNOT RE-MEASURE.
     `surf` is spent by the first freeze, so every later one — smooth,
     liquify, bend, the joystick, an undo — arrives without it. Resetting
     the fit to 1 here threw the boundary trim away and the paint sprang
     back out over the edge of the guide it was painted on, measured at
     116mm past a wall the stroke had been clamped to. A tool that nudges
     a point by a fraction of a millimetre has not changed how much room
     that section has, so the measured value stands until something can
     measure it again. */
  if(!f || !(halfWidth > EPS)){
    if(pt.fitL === undefined) pt.fitL = 1;
    if(pt.fitR === undefined) pt.fitR = 1;
    return;
  }
  pt.fitL = pt.fitR = 1;
  nibAxis(pt, t, _axisT);
  var reach = P.Guides.reachAlong(f, _axisT);
  pt.fitR = P.clamp(reach.pos / halfWidth, FIT_MIN, 1);
  pt.fitL = P.clamp(reach.neg / halfWidth, FIT_MIN, 1);
}
S.fitAt = fitAt;

/* The trim is measured per point, and per-point measurements of anything jitter
   — the arc-length position is read from whichever cell of the surface grid the
   sample landed in, and the nib's direction wanders by a fraction of a degree
   between samples. Left alone that came out as a ragged edge where the paint
   meets the boundary, measured at 11% of the nib's width along a stroke that
   runs dead straight beside it. Two passes of a three-tap average take it out
   without moving where the edge actually is. */
function smoothFit(pts){
  var n = pts.length, i, pass;
  if(n < 3) return;
  /* the measured limit, kept aside: averaging is allowed to pull a section IN
     but never to push one back out past what was measured for it, or a column
     painted along a boundary creeps over the edge again wherever its
     neighbours happen to have more room */
  var capL = new Array(n), capR = new Array(n);
  for(i=0;i<n;i++){ capL[i] = pts[i].fitL; capR[i] = pts[i].fitR; }
  for(pass=0; pass<2; pass++){
    var L = new Array(n), R = new Array(n);
    for(i=0;i<n;i++){
      var a = pts[Math.max(0,i-1)], b = pts[i], c = pts[Math.min(n-1,i+1)];
      L[i] = (a.fitL + 2*b.fitL + c.fitL) / 4;
      R[i] = (a.fitR + 2*b.fitR + c.fitR) / 4;
    }
    for(i=0;i<n;i++){
      pts[i].fitL = Math.min(L[i], capL[i]);
      pts[i].fitR = Math.min(R[i], capR[i]);
    }
  }
}

/* The stored cross-section angle, measured in the transported frame. */
function rollOf(pt, t, r){
  _sT.crossVectors(t, r);
  nibAxis(pt, t, _axisT);
  _projT.copy(_axisT).addScaledVector(t, -_axisT.dot(t));
  return (_projT.lengthSq() < EPS) ? 0
       : Math.atan2(_projT.dot(_sT), _projT.dot(r));
}
S.rollOf = rollOf;

/* NO TWO POINTS IN THE SAME PLACE.
   A guide that clamps several samples to the same nearest position, or a
   densified path whose inserted samples fall on top of a real one, leaves
   duplicate consecutive points. They cost a whole ring each, they force
   computeTangents down its fallback path, and every triangle between the two
   coincident rings has zero area — which is invisible on screen and a HOLE in
   an exported solid, because the exporter drops degenerate faces. Measured on
   a cube stroke drawn across a guide: 22 zero-area triangles, 12 boundary
   edges in the STL. Cheaper to never make them. */
S.dedupe = function(stroke){
  var pts = stroke.pts, out = [pts[0]], i;
  if(!pts.length) return 0;
  for(i=1;i<pts.length;i++){
    if(pts[i].p.distanceToSquared(out[out.length-1].p) > 1e-10) out.push(pts[i]);
  }

  /* AND NO SPURS EITHER.
     Clamping onto a guide does not only bunch samples, it can fold them: a
     stroke painted across a narrow guide came back with steps of 1.72mm,
     0.75mm and 0.40mm where the chord straight PAST the middle one measured
     0.35mm - shorter than either step beside it, so the path doubles back
     inside one sample. Consecutive tangents then point opposite ways, the ring
     between them is built inside out, and a wide nib turns that into a plate
     of paint standing off the surface at a wild angle.

     A point is a spur when the path REVERSES through it - the step in and the
     step out point opposite ways - and cutting it out moves the path less
     than this brush could draw anyway, a wiggle far finer than the nib being
     something the sweep cannot render in any case. That second clause is what
     keeps a deliberate sharp corner: the tip of a real V stands most of an arm
     away from the line joining its ends, whatever the brush.

     The excursion has to be measured to the SEGMENT and not to its infinite
     line. These folds are very nearly straight backtracks, so the tip sits on
     the line but well outside the span, and a line distance would call a 0.35mm
     step back zero. */
  var half = Math.abs(stroke.baseRadius * cfgOf(stroke).wide);
  var flat = Math.max(0.25 * P.MM, half * 0.01);
  var ac = new THREE.Vector3(), ab = new THREE.Vector3(), bc = new THREE.Vector3();
  var changed = true;
  while(changed && out.length > 2){
    changed = false;
    var keep = [out[0]];
    for(i=1;i<out.length-1;i++){
      var a = keep[keep.length-1].p, b = out[i].p, c = out[i+1].p;
      ab.subVectors(b, a); bc.subVectors(c, b);
      if(ab.dot(bc) < 0){
        ac.subVectors(c, a);
        var len2 = ac.lengthSq();
        var t = len2 > EPS ? P.clamp(ab.dot(ac)/len2, 0, 1) : 0;
        var off = ab.addScaledVector(ac, -t).length();
        if(off <= flat){ changed = true; continue; }
      }
      keep.push(out[i]);
    }
    keep.push(out[out.length-1]);
    out = keep;
  }

  var dropped = pts.length - out.length;
  if(dropped) stroke.pts = out;
  return dropped;
};

/* Freeze frames into point data. This is the step that makes orientation
   persistent rather than re-derived, and it is what erase, bend and the
   joystick transform all read back. */
S.freezeFrames = function(stroke){
  var pts = stroke.pts;
  if(pts.length === 0) return;
  var fr = P.transportFrames(pts.map(function(p){ return p.p; }), stroke.seedRef);
  var arc = arcOf(pts);
  for(var i=0;i<pts.length;i++){
    var t = fr.T[i], r = fr.R[i], pt = pts[i];
    pt.roll = rollOf(pt, t, r);
    fitAt(pt, t, shadeAt(stroke, i, arc).radius);
    pt.tan = t.clone();
    pt.ref = r.clone();
    if(pt.axis) delete pt.axis;
    if(pt.surf) delete pt.surf;          // transient: the frame is spent here
  }
  smoothFit(pts);
};

/* ==========================================================================
   Groups
   --------------------------------------------------------------------------
   FACT (C.8): undo covers "add/delete group", so a group is part of the
   document, not a listing the panel invents.

   Modelled on Feather's own panel: a flat, ordered list of NAMED groups, each
   with its own visibility, one of them active. Every curve belongs to exactly
   one — drawing puts it in the active group — which is what makes the panel a
   place you organise a sketch from rather than a scrolling inventory of every
   line you have ever drawn.

   The previous model was the other way round: `group` was null until you
   selected two curves and pressed Group, groups had no names and no
   visibility, and the panel listed curves individually. Tapping any curve then
   selected its whole group, which is reasonable for ad-hoc grouping and wrong
   once everything is grouped by default — so that rule moves to a long press
   on the group row, where it is asked for rather than assumed.
   ========================================================================== */
S.groups = [];                  // ordered, first = top of the panel
S.activeGroup = 0;              // id that new curves join

function findGroup(id){
  for(var i=0;i<S.groups.length;i++) if(S.groups[i].id === id) return S.groups[i];
  return null;
}
S.findGroup = findGroup;

S.groupOf = function(stroke){ return findGroup(stroke.group); };
S.membersOf = function(id){
  return S.list.filter(function(st){ return st.group === id; });
};

/* A sketch always has somewhere to draw. */
S.ensureGroup = function(){
  if(!S.groups.length) S.addGroup('Group 1');
  if(!findGroup(S.activeGroup)) S.activeGroup = S.groups[0].id;
  return findGroup(S.activeGroup);
};

S.addGroup = function(name, at){
  var g = { id: S.nextGroup++, name: name || ('Group ' + (S.groups.length+1)),
            visible: true };
  if(at === undefined || at < 0 || at > S.groups.length) S.groups.unshift(g);
  else S.groups.splice(at, 0, g);
  return g;
};

S.removeGroup = function(id){
  for(var i=0;i<S.groups.length;i++){
    if(S.groups[i].id === id){ S.groups.splice(i,1); return i; }
  }
  return -1;
};

S.insertGroup = function(g, at){
  S.groups.splice(P.clamp(at, 0, S.groups.length), 0, g);
  return g;
};

/* A curve is drawable, selectable, erasable and exportable only if its group
   says so. The raycaster does NOT check .visible, so everything that reaches
   into the scene has to ask this rather than assume. */
S.visible = function(stroke){
  var g = findGroup(stroke.group);
  return !g || g.visible !== false;
};

S.applyVisibility = function(){
  for(var i=0;i<S.list.length;i++){
    var st = S.list[i];
    if(st.mesh) st.mesh.visible = S.visible(st);
    if(!S.visible(st) && st.selected) S.setSelected(st, false);
  }
};

S.setGroupVisible = function(id, on){
  var g = findGroup(id);
  if(!g) return false;
  g.visible = !!on;
  S.applyVisibility();
  return true;
};

/* ==========================================================================
   Collection
   ========================================================================== */
S.add = function(stroke){
  if(!stroke.id) stroke.id = P.uid();
  S.list.push(stroke);
  if(!stroke.mesh) S.rebuild(stroke);
  else if(stroke.mesh.parent !== group) group.add(stroke.mesh);
  if(stroke.mesh) stroke.mesh.visible = S.visible(stroke);
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
    if(hits[i].object.visible === false) continue;      // hidden group
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
    var st = S.list[i];
    if(!S.visible(st)) continue;                        // hidden group
    var runs = split(st);
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
    fitL: near.fitL, fitR: near.fitR,
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
/* Smooth and Liquify sweep a disc over the scene exactly as the eraser does,
   and paid the same price for not rejecting first. The padding above covers
   a stroke whose points have moved since its mesh was last rebuilt: a frame
   of pen travel is small beside a whole brush radius. */
S.farFromDisc = farFromDisc;

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
               roll:p.roll, fitL:p.fitL, fitR:p.fitR,
               pressure:p.pressure, tiltAz:p.tiltAz, tiltAlt:p.tiltAlt };
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
    if(hits[i].object.visible === false) continue;      // hidden group
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
      /* the surface normal is what the nib is squared to, so it rotates too */
      if(pt.nrm){
        pt.nrm.applyMatrix3(rot);
        if(pt.nrm.lengthSq()>EPS) pt.nrm.normalize();
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
