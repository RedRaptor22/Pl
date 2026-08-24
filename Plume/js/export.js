/* ==========================================================================
   PLUME / export.js — geometry out: OBJ (+MTL) and STL.
   --------------------------------------------------------------------------
   The mirror of import.js, and written the same way: the formats are small
   enough that hand-writing them beats shipping two more loader files into an
   offline app.

   FACT (units, support docs / Environment Tab): 1 world unit = 1000 mm.
   INFERENCE: exported files are written in MILLIMETRES. OBJ and STL are both
   nominally unitless, but every consumer that does assume a unit assumes mm
   (slicers universally, most CAD importers by default), and a sketch drawn
   with a 14 mm brush should arrive in Blender as 14 mm rather than 0.014 of
   something. `opts.scale` overrides it.

   Y-UP is kept for both formats. OBJ is conventionally Y-up, STL from CAD is
   conventionally Z-up, and there is no way to satisfy both; keeping one
   orientation means what you see in Plume is what you get everywhere, and
   `opts.zUp` is there for printing.

   WINDING IS NORMALISED HERE, not trusted. STL has no index buffer and no way
   to say "the normal disagrees with the winding" that any slicer respects, so
   a mesh wound the wrong way is a solid that prints inside out.

   A CLOSED mesh settles it exactly: its signed volume is positive if and only
   if it is wound outward, and that needs no normals at all. Every stroke is a
   closed tube, so every stroke uses it. Guide surfaces are open sheets with no
   volume to speak of, and fall back to comparing the winding against the
   shading normals, area-weighted over the whole surface.

   The volume test earns its place beyond exactness: a paint brush hands the
   shader the SURFACE normal for every vertex rather than its own facet
   normals, so on those strokes the normal vote is comparing the geometry
   against something that is deliberately not the geometry.

   Per-triangle flipping was tried first and is wrong: on the blade-shaped nibs
   (chisel, ribbon) the cross-section collapses to slivers whose shading normals
   are unreliable, so a handful of triangles flipped against their neighbours
   and the solid stopped being consistently oriented — measured as 3 to 30
   boundary edges per curve on a surface that has none. Orientation is a
   property of a surface, not of a face.

   Colour: OBJ carries it in a sidecar .mtl (one material per distinct
   colour+opacity), and optionally as per-vertex rgb on the `v` lines, which
   is the only way the pressure->colour and pressure->opacity mappings survive
   the trip. STL carries no colour at all — that is the format, not an
   omission.
   ========================================================================== */
(function(P){
'use strict';

var S = P.Strokes, G = P.Guides;
var EX = P.Export = {};

var MM_PER_UNIT = 1/P.MM;                 // 1000
var AREA_EPS = 1e-18;                     // mm^2; below this a triangle is a line

/* ---- number formatting ----------------------------------------------------
   4 decimals of a millimetre is 100 nanometres — far below the quantisation
   the document format itself uses — and trimming the zeros roughly halves an
   ASCII export. */
function fmt(n, prec){
  if(!isFinite(n)) n = 0;
  var s = n.toFixed(prec === undefined ? 4 : prec);
  if(s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return (s === '-0' || s === '') ? '0' : s;
}
function fmtN(n){ return fmt(n, 5); }     // normals are unit vectors

function safeName(s, fallback){
  s = String(s === undefined || s === null ? '' : s)
        .trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || fallback;
}

/* ==========================================================================
   Collect — every visible mesh flattened into world-space triangle soup
   ========================================================================== */
var _m3 = new THREE.Matrix3(), _v = new THREE.Vector3();

function partFromMesh(mesh, opt){
  var geom = mesh.geometry;
  var posAttr = geom.attributes.position;
  if(!posAttr || !posAttr.count) return null;

  var norAttr = geom.attributes.normal;
  if(!norAttr){ geom.computeVertexNormals(); norAttr = geom.attributes.normal; }

  var n = posAttr.count;
  var pos = new Float32Array(n*3), nor = new Float32Array(n*3);
  var mat = mesh.matrixWorld;
  _m3.getNormalMatrix(mat);

  var k = opt.scale, i;
  for(i=0;i<n;i++){
    _v.set(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i)).applyMatrix4(mat);
    var x = _v.x*k, y = _v.y*k, z = _v.z*k;
    if(opt.zUp){ pos[i*3]=x; pos[i*3+1]=-z; pos[i*3+2]=y; }
    else       { pos[i*3]=x; pos[i*3+1]= y; pos[i*3+2]=z; }

    _v.set(norAttr.getX(i), norAttr.getY(i), norAttr.getZ(i)).applyMatrix3(_m3);
    if(_v.lengthSq() < P.EPS) _v.set(0,0,1); else _v.normalize();
    if(opt.zUp){ nor[i*3]=_v.x; nor[i*3+1]=-_v.z; nor[i*3+2]=_v.y; }
    else       { nor[i*3]=_v.x; nor[i*3+1]= _v.y; nor[i*3+2]=_v.z; }
  }

  /* source triangles: indexed if the geometry is, else sequential */
  var index = geom.index, triCount = (index ? index.count : n) / 3 | 0;
  var tris = new Uint32Array(triCount*3);
  var at = 0, agree = 0, volume = 0;
  for(i=0;i<triCount;i++){
    var a = index ? index.getX(i*3)   : i*3,
        b = index ? index.getX(i*3+1) : i*3+1,
        c = index ? index.getX(i*3+2) : i*3+2;

    var ax=pos[a*3], ay=pos[a*3+1], az=pos[a*3+2];
    var ux=pos[b*3]-ax, uy=pos[b*3+1]-ay, uz=pos[b*3+2]-az;
    var wx=pos[c*3]-ax, wy=pos[c*3+1]-ay, wz=pos[c*3+2]-az;
    var gx = uy*wz - uz*wy, gy = uz*wx - ux*wz, gz = ux*wy - uy*wx;
    if(gx*gx + gy*gy + gz*gz < AREA_EPS) continue;      // degenerate: drop it

    /* |g| is twice the triangle's area, so summing the raw dot product weights
       the vote by area and lets the slivers count for as little as they are */
    agree += gx*(nor[a*3]  +nor[b*3]  +nor[c*3])
           + gy*(nor[a*3+1]+nor[b*3+1]+nor[c*3+1])
           + gz*(nor[a*3+2]+nor[b*3+2]+nor[c*3+2]);

    /* and the exact answer for anything closed */
    volume += (pos[a*3]  *(pos[b*3+1]*pos[c*3+2] - pos[b*3+2]*pos[c*3+1]) +
               pos[a*3+1]*(pos[b*3+2]*pos[c*3]   - pos[b*3]  *pos[c*3+2]) +
               pos[a*3+2]*(pos[b*3]  *pos[c*3+1] - pos[b*3+1]*pos[c*3]));

    tris[at++]=a; tris[at++]=b; tris[at++]=c;
  }
  if(!at) return null;

  var inward = opt.closed ? (volume < 0) : (agree < 0);
  if(inward){                                    // wound inwards: flip it whole
    for(i=0;i<at;i+=3){ var t = tris[i+1]; tris[i+1] = tris[i+2]; tris[i+2] = t; }
  }

  var part = {
    name: opt.name, pos: pos, nor: nor,
    tris: at === tris.length ? tris : tris.subarray(0, at),
    color: opt.color, opacity: opt.opacity
  };
  /* the per-vertex rgba the shader draws with — this is where pressure lives */
  if(geom.attributes.vcolor) part.vcolor = geom.attributes.vcolor;
  return part;
}

/* opts: {strokes, selectionOnly, guides, scale, zUp} */
EX.collect = function(opts){
  opts = opts || {};
  var scale = opts.scale === undefined ? MM_PER_UNIT : opts.scale;
  var zUp = !!opts.zUp;
  /* By default a hidden group is not exported — it is not part of what you
     are looking at. An explicit `strokes` list is taken as given. */
  var list = opts.strokes ||
             (opts.selectionOnly ? S.selection : S.list).filter(function(st){
               return !S.visible || S.visible(st);
             });

  P.scene.updateMatrixWorld(true);

  var parts = [], i, part;
  for(i=0;i<list.length;i++){
    var st = list[i];
    var mesh = st.mesh;
    var temp = null;
    if(!mesh){                                    // never drawn: build it now
      var built = S.buildGeometry(st);
      if(!built) continue;
      temp = built.geom;
      mesh = new THREE.Mesh(temp);
      mesh.updateMatrixWorld(true);
    }
    part = partFromMesh(mesh, {
      name: safeName(st.name, 'curve_' + (i+1)),
      scale: scale, zUp: zUp,
      color: '#' + st.color.getHexString(),
      opacity: st.opacity === undefined ? 1 : st.opacity,
      closed: true                                // every stroke is a capped tube
    });
    if(temp) temp.dispose();
    if(part){ part.stroke = st; parts.push(part); }
  }

  if(opts.guides){
    var guides = G.resources.slice();
    if(G.active && guides.indexOf(G.active) < 0) guides.unshift(G.active);
    for(i=0;i<guides.length;i++){
      var g = guides[i];
      if(!g.mesh) continue;
      part = partFromMesh(g.mesh, {
        name: safeName('guide_' + (g.name || g.kind), 'guide_' + (i+1)),
        scale: scale, zUp: zUp,
        color: '#b9bccb',                         // guides have no user colour
        opacity: 1
      });
      if(part){ part.guide = g; delete part.vcolor; parts.push(part); }
    }
  }
  return parts;
};

EX.stats = function(parts){
  var v = 0, t = 0;
  for(var i=0;i<parts.length;i++){
    v += parts[i].pos.length/3;
    t += parts[i].tris.length/3;
  }
  return { parts: parts.length, vertices: v, triangles: t };
};

/* ==========================================================================
   OBJ (+ MTL)
   ========================================================================== */
function materialKey(part){
  var hex = part.color.replace('#','').toLowerCase();
  var a = Math.round(P.clamp(part.opacity, 0, 1) * 100);
  return 'plume_' + hex + (a < 100 ? '_a' + a : '');
}

/* -> {obj:String, mtl:String, name:String} */
EX.objSource = function(parts, opts){
  opts = opts || {};
  var name = safeName(opts.name, 'plume');
  var withMtl = opts.mtl !== false;
  var withVC = !!opts.vertexColors;

  var out = [
    '# Plume — 3D sketch export',
    '# ' + new Date().toISOString(),
    '# units: millimetres (1 Plume grid unit = 1000 mm)',
    '# ' + parts.length + ' object(s)'
  ];
  if(withMtl) out.push('mtllib ' + name + '.mtl');

  var mats = {}, base = 1, i, j;
  for(i=0;i<parts.length;i++){
    var part = parts[i], pos = part.pos, nor = part.nor, vc = withVC && part.vcolor;
    var count = pos.length/3;
    var key = materialKey(part);
    mats[key] = part;

    out.push('o ' + part.name);
    for(j=0;j<count;j++){
      var line = 'v ' + fmt(pos[j*3]) + ' ' + fmt(pos[j*3+1]) + ' ' + fmt(pos[j*3+2]);
      /* the widely-read extension: three more floats on the v line are rgb.
         Off by default — strict readers only expect an optional 4th weight. */
      if(vc) line += ' ' + fmt(vc.getX(j), 4) + ' ' + fmt(vc.getY(j), 4) +
                     ' ' + fmt(vc.getZ(j), 4);
      out.push(line);
    }
    for(j=0;j<count;j++){
      out.push('vn ' + fmtN(nor[j*3]) + ' ' + fmtN(nor[j*3+1]) + ' ' + fmtN(nor[j*3+2]));
    }
    if(withMtl) out.push('usemtl ' + key);
    var tris = part.tris;
    for(j=0;j<tris.length;j+=3){
      var a = base + tris[j], b = base + tris[j+1], c = base + tris[j+2];
      /* v//vn — no texture coordinates to reference */
      out.push('f ' + a + '//' + a + ' ' + b + '//' + b + ' ' + c + '//' + c);
    }
    base += count;
  }

  var mtl = null;
  if(withMtl){
    var ml = ['# Plume — materials', '# ' + new Date().toISOString()];
    for(var k in mats){
      if(!mats.hasOwnProperty(k)) continue;
      var col = new THREE.Color(mats[k].color);
      var d = P.clamp(mats[k].opacity, 0, 1);
      ml.push('', 'newmtl ' + k,
        'Kd ' + fmtN(col.r) + ' ' + fmtN(col.g) + ' ' + fmtN(col.b),
        'Ka 0 0 0',
        'Ks 0.04 0.04 0.04',
        'Ns 24',
        'd ' + fmtN(d),
        'illum 2');
    }
    mtl = ml.join('\n') + '\n';
  }
  return { obj: out.join('\n') + '\n', mtl: mtl, name: name };
};

/* ==========================================================================
   STL — binary by default, ASCII on request. Neither carries colour.
   ========================================================================== */
function facetNormal(pos, a, b, c, o){
  var ax=pos[a*3], ay=pos[a*3+1], az=pos[a*3+2];
  var ux=pos[b*3]-ax, uy=pos[b*3+1]-ay, uz=pos[b*3+2]-az;
  var wx=pos[c*3]-ax, wy=pos[c*3+1]-ay, wz=pos[c*3+2]-az;
  var nx = uy*wz - uz*wy, ny = uz*wx - ux*wz, nz = ux*wy - uy*wx;
  var L = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  o[0] = nx/L; o[1] = ny/L; o[2] = nz/L;
  return o;
}

EX.stlBuffer = function(parts){
  var n = EX.stats(parts).triangles;
  var buf = new ArrayBuffer(84 + n*50);
  var dv = new DataView(buf);

  /* 80-byte header. It must NOT begin with "solid", or a sniffing reader will
     take the file for ASCII — including ours (see Import.looksBinarySTL). */
  var head = 'Plume sketch export - millimetres - ' + n + ' triangles';
  for(var h=0;h<80;h++){
    var code = h < head.length ? head.charCodeAt(h) : 32;
    dv.setUint8(h, code < 32 || code > 126 ? 32 : code);
  }
  dv.setUint32(80, n, true);

  var o = 84, nrm = [0,0,0];
  for(var i=0;i<parts.length;i++){
    var pos = parts[i].pos, tris = parts[i].tris;
    for(var j=0;j<tris.length;j+=3){
      var a = tris[j], b = tris[j+1], c = tris[j+2];
      facetNormal(pos, a, b, c, nrm);
      dv.setFloat32(o, nrm[0], true); dv.setFloat32(o+4, nrm[1], true);
      dv.setFloat32(o+8, nrm[2], true); o += 12;
      var v = [a,b,c];
      for(var t=0;t<3;t++){
        var q = v[t]*3;
        dv.setFloat32(o, pos[q], true); dv.setFloat32(o+4, pos[q+1], true);
        dv.setFloat32(o+8, pos[q+2], true); o += 12;
      }
      dv.setUint16(o, 0, true); o += 2;           // attribute byte count
    }
  }
  return buf;
};

EX.stlSource = function(parts, opts){
  var name = safeName((opts||{}).name, 'plume');
  var out = ['solid ' + name], nrm = [0,0,0];
  for(var i=0;i<parts.length;i++){
    var pos = parts[i].pos, tris = parts[i].tris;
    for(var j=0;j<tris.length;j+=3){
      var a = tris[j], b = tris[j+1], c = tris[j+2];
      facetNormal(pos, a, b, c, nrm);
      out.push('facet normal ' + fmtN(nrm[0]) + ' ' + fmtN(nrm[1]) + ' ' + fmtN(nrm[2]));
      out.push('  outer loop');
      var v = [a,b,c];
      for(var t=0;t<3;t++){
        var q = v[t]*3;
        out.push('    vertex ' + fmt(pos[q]) + ' ' + fmt(pos[q+1]) + ' ' + fmt(pos[q+2]));
      }
      out.push('  endloop');
      out.push('endfacet');
    }
  }
  out.push('endsolid ' + name);
  return out.join('\n') + '\n';
};

/* ==========================================================================
   Saving
   ========================================================================== */
EX.saveURL = function(url, filename, revoke){
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if(revoke) setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
};

EX.saveBlob = function(blob, filename){
  EX.saveURL(URL.createObjectURL(blob), filename, true);
};

/* Writes the file(s) and returns the stats, or null when there is nothing to
   write — the caller decides what to say about it. */
EX.download = function(format, opts){
  opts = opts || {};
  var parts = EX.collect(opts);
  var st = EX.stats(parts);
  if(!st.triangles) return null;

  var name = safeName(opts.name, 'plume-' + Date.now());
  if(format === 'stl'){
    if(opts.ascii){
      EX.saveBlob(new Blob([EX.stlSource(parts, {name:name})], {type:'model/stl'}),
                  name + '.stl');
    } else {
      EX.saveBlob(new Blob([EX.stlBuffer(parts)], {type:'model/stl'}), name + '.stl');
    }
  } else {
    var src = EX.objSource(parts, {name:name, mtl:opts.mtl !== false,
                                   vertexColors:!!opts.vertexColors});
    EX.saveBlob(new Blob([src.obj], {type:'model/obj'}), name + '.obj');
    /* the material sidecar is a second download; browsers allow it inside the
       same user gesture, and an OBJ whose mtllib is missing still loads */
    if(src.mtl) EX.saveBlob(new Blob([src.mtl], {type:'text/plain'}), name + '.mtl');
  }
  return st;
};

})(window.P);
