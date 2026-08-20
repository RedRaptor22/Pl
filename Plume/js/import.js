/* ==========================================================================
   PLUME / import.js — reference images and 3D models, both as guides.
   --------------------------------------------------------------------------
   FACT (C.1): "You can also draw directly on imported images (flat guide) or
   imported 3D models (curved guide)", and for images "you cannot draw outside
   its boundaries."

   Both drop into the existing pipeline unchanged: G.project() raycasts
   whatever mesh the active guide owns, so an image plane and a loaded model
   already behave like a surface you can draw on, mask with, and orbit around.
   Only two things are special-cased — an image needs a textured material
   rather than the section-line shader, and an image refuses off-surface
   strokes instead of clamping them, per the doc above.

   The parsers are written out rather than vendored. OBJ and STL are small
   formats, and adding two more loader files to a packaged offline app to read
   them is a poor trade.
   ========================================================================== */
(function(P){
'use strict';

var G = P.Guides;
var IM = P.Import = {};

/* ==========================================================================
   OBJ — vertices, optional normals, faces (n-gons fanned into triangles)
   ========================================================================== */
IM.parseOBJ = function(text){
  var v = [], vn = [], pos = [], nor = [];
  var lines = text.split(/\r?\n/);

  function emit(ref){
    /* face refs are v, v/vt, v//vn or v/vt/vn, and may be negative */
    var parts = ref.split('/');
    var vi = parseInt(parts[0], 10);
    if(isNaN(vi)) return false;
    vi = vi < 0 ? v.length/3 + vi : vi - 1;
    if(vi < 0 || vi*3+2 >= v.length) return false;
    pos.push(v[vi*3], v[vi*3+1], v[vi*3+2]);

    var ni = parts.length > 2 ? parseInt(parts[2], 10) : NaN;
    if(!isNaN(ni)){
      ni = ni < 0 ? vn.length/3 + ni : ni - 1;
      if(ni >= 0 && ni*3+2 < vn.length){ nor.push(vn[ni*3], vn[ni*3+1], vn[ni*3+2]); return true; }
    }
    nor.push(0,0,0);                       // filled in by computeVertexNormals
    return true;
  }

  for(var i=0;i<lines.length;i++){
    var ln = lines[i].trim();
    if(!ln || ln.charAt(0) === '#') continue;
    var t = ln.split(/\s+/);
    if(t[0] === 'v'){
      v.push(parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3]));
    } else if(t[0] === 'vn'){
      vn.push(parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3]));
    } else if(t[0] === 'f'){
      for(var k=2;k+1<t.length;k++){       // triangle fan over the polygon
        emit(t[1]); emit(t[k]); emit(t[k+1]);
      }
    }
  }
  if(!pos.length) return null;
  return buildGeometry(pos, nor);
};

/* ==========================================================================
   STL — binary or ASCII, sniffed rather than trusted by extension
   ========================================================================== */
function looksBinarySTL(buf){
  if(buf.byteLength < 84) return false;
  var dv = new DataView(buf);
  var tris = dv.getUint32(80, true);
  /* a binary STL is exactly 84 + 50 bytes per triangle */
  if(84 + tris*50 === buf.byteLength) return true;
  /* otherwise fall back to sniffing the header for "solid" */
  var head = '';
  for(var i=0;i<5 && i<buf.byteLength;i++) head += String.fromCharCode(dv.getUint8(i));
  return head.toLowerCase() !== 'solid';
}

IM.parseSTL = function(buf){
  if(looksBinarySTL(buf)) return parseBinarySTL(buf);
  var text = '';
  var bytes = new Uint8Array(buf);
  for(var i=0;i<bytes.length;i++) text += String.fromCharCode(bytes[i]);
  return parseAsciiSTL(text);
};

function parseBinarySTL(buf){
  var dv = new DataView(buf);
  var tris = dv.getUint32(80, true);
  if(!tris || 84 + tris*50 !== buf.byteLength) return null;
  var pos = new Float32Array(tris*9), nor = new Float32Array(tris*9);
  var o = 84;
  for(var t=0;t<tris;t++){
    var nx = dv.getFloat32(o, true), ny = dv.getFloat32(o+4, true), nz = dv.getFloat32(o+8, true);
    o += 12;
    for(var c=0;c<3;c++){
      var b = t*9 + c*3;
      pos[b]   = dv.getFloat32(o, true);
      pos[b+1] = dv.getFloat32(o+4, true);
      pos[b+2] = dv.getFloat32(o+8, true);
      nor[b] = nx; nor[b+1] = ny; nor[b+2] = nz;
      o += 12;
    }
    o += 2;                                 // attribute byte count
  }
  return buildGeometry(pos, nor);
}

function parseAsciiSTL(text){
  var pos = [], nor = [];
  var re = /facet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)([\s\S]*?)endfacet/g;
  var vre = /vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g;
  var m;
  while((m = re.exec(text)) !== null){
    var nx = parseFloat(m[1]), ny = parseFloat(m[2]), nz = parseFloat(m[3]);
    var body = m[4], vm, count = 0;
    vre.lastIndex = 0;
    while((vm = vre.exec(body)) !== null && count < 3){
      pos.push(parseFloat(vm[1]), parseFloat(vm[2]), parseFloat(vm[3]));
      nor.push(nx, ny, nz);
      count++;
    }
  }
  if(!pos.length) return null;
  return buildGeometry(pos, nor);
}

/* ==========================================================================
   Shared geometry finishing
   ========================================================================== */
function buildGeometry(pos, nor){
  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(
    pos instanceof Float32Array ? pos : new Float32Array(pos), 3));

  var flat = true;
  for(var i=0;i<nor.length;i+=3){
    if(nor[i] || nor[i+1] || nor[i+2]){ flat = false; break; }
  }
  if(flat){
    g.computeVertexNormals();
  } else {
    g.setAttribute('normal', new THREE.BufferAttribute(
      nor instanceof Float32Array ? nor : new Float32Array(nor), 3));
  }
  /* the guide shader reads uvw in swept mode; models use triplanar, but the
     attribute still has to exist for the program to link */
  var n = g.attributes.position.count;
  g.setAttribute('uvw', new THREE.BufferAttribute(new Float32Array(n*2), 2));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/* Fit an imported model into a sensible sketching size and sit it on the
   grid. Real-world files arrive in millimetres, inches or arbitrary units, so
   normalising is kinder than trusting the file. */
IM.fitGeometry = function(geom, targetSize){
  geom.computeBoundingBox();
  var box = geom.boundingBox;
  var size = box.getSize(new THREE.Vector3());
  var centre = box.getCenter(new THREE.Vector3());
  var biggest = Math.max(size.x, size.y, size.z) || 1;
  var k = (targetSize || 2) / biggest;

  geom.translate(-centre.x, -centre.y, -centre.z);
  geom.scale(k, k, k);
  geom.translate(0, size.y*k/2, 0);        // rest it on the ground plane
  geom.computeBoundingSphere();
  geom.computeBoundingBox();
  return geom;
};

/* ==========================================================================
   Public entry points
   ========================================================================== */
IM.MODEL_EXT = /\.(obj|stl)$/i;
IM.IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

IM.loadModel = function(file){
  return new Promise(function(resolve, reject){
    var fr = new FileReader();
    fr.onerror = function(){ reject(new Error('Could not read that file')); };
    fr.onload = function(){
      var geom = null;
      try {
        if(/\.obj$/i.test(file.name)){
          var txt = '';
          var b = new Uint8Array(fr.result);
          for(var i=0;i<b.length;i++) txt += String.fromCharCode(b[i]);
          geom = IM.parseOBJ(txt);
        } else {
          geom = IM.parseSTL(fr.result);
        }
      } catch(err){ reject(new Error('Could not parse that model')); return; }
      if(!geom){ reject(new Error('No geometry found in that file')); return; }
      IM.fitGeometry(geom, 2.2);
      resolve(G.fromModel(geom, file.name.replace(IM.MODEL_EXT, '')));
    };
    fr.readAsArrayBuffer(file);
  });
};

IM.loadImage = function(file){
  return new Promise(function(resolve, reject){
    var fr = new FileReader();
    fr.onerror = function(){ reject(new Error('Could not read that file')); };
    fr.onload = function(){
      var img = new Image();
      img.onerror = function(){ reject(new Error('That is not an image Plume can read')); };
      img.onload = function(){
        resolve(G.fromImage(fr.result, img.width, img.height,
                            file.name.replace(IM.IMAGE_EXT, '')));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
};

/* Route by extension, so one file picker can take either. */
IM.load = function(file){
  if(IM.IMAGE_EXT.test(file.name)) return IM.loadImage(file);
  if(IM.MODEL_EXT.test(file.name)) return IM.loadModel(file);
  return Promise.reject(new Error('Import an image, or an .obj / .stl model'));
};

})(window.P);
