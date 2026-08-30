/* ==========================================================================
   PLUME / fx.js — the post pass: pixelation, depth of field, grain
   --------------------------------------------------------------------------
   FACT: Feather carries grain (a noise icon you slide for level), depth of
   field (an aperture icon you slide for F-stop) and pixelation, and shows them
   accurately only in rendering mode. This is that, and it runs only in render
   mode for the same reason: a full-screen pass every frame is a cost you
   should be asked for rather than charged.

   HAND-ROLLED, NOT EffectComposer. The repo has no bundler and vendors one
   three.min.js, and EffectComposer lives in the examples tree with a chain of
   its own imports. What a composer actually is - render the scene to a target,
   then draw one quad with a shader that reads it - is about forty lines, and
   forty lines beats a build step.

   ONE PASS, NOT A CHAIN. Each effect is a few lines in the same fragment
   shader, so the image is read once and written once however many are on. A
   chain would ping-pong a full-screen buffer per effect for no gain at these
   resolutions.
   ========================================================================== */
(function(P){
'use strict';

var FX = P.FX = {
  dofOn   : false,
  fstop   : 5.6,        // low f = shallow focus = more blur, as on a camera
  grainOn : false,
  grain   : 35,         // 0..100
  pixelOn : false,
  pixel   : 4           // block size, in screen pixels
};

P.fxActive = function(){
  return !!(P.ENV.render && (FX.dofOn || FX.grainOn || FX.pixelOn));
};

var target = null, depthTarget = null, quadScene = null, quadCam = null, quad = null;
var sizeW = 0, sizeH = 0;

/* DEPTH AS A PACKED RGBA PASS, not a depth attachment.
   A DepthTexture is one render cheaper and it is what I reached for first; it
   came back reading 1.0 everywhere. It is also the wrong precision for this
   scene whichever way that went: the camera runs near 0.02 to far 8000, a
   range of 400,000 to 1, and a 16-bit non-linear depth buffer spends almost
   all of its resolution in the first few centimetres. Packing depth across
   four 8-bit channels gives 32 bits, works the same on WebGL1 and 2, and is
   what three's own depth-of-field examples do. It costs one more pass over the
   scene, which is a fair price in a mode you have to ask for - and it is only
   paid when depth of field is actually on. */
var depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

var VERT = [
  'varying vec2 vUv;',
  'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
].join('\n');

var FRAG = [
  'precision highp float;',
  'varying vec2 vUv;',
  'uniform sampler2D uColor;',
  'uniform sampler2D uDepth;',
  /* three's own packing constants: depth arrives as an RGBA texture, not as a
     depth attachment - see the note by depthMat below */
  'const vec3 PackFactors = vec3(16777216.0, 65536.0, 256.0);',
  'const vec4 UnpackFactors = (255.0/256.0) / vec4(PackFactors, 1.0);',
  'float unpackDepth(vec4 v){ return dot(v, UnpackFactors); }',
  'uniform vec2  uTexel;',
  'uniform float uNear;',
  'uniform float uFar;',
  'uniform float uOrtho;',
  'uniform float uFocus;',
  'uniform float uRange;',
  'uniform float uDof;',
  'uniform float uGrain;',
  'uniform float uPixel;',
  'uniform vec2  uGrid;',
  'uniform float uSeed;',

  /* the depth buffer is non-linear under a perspective camera, so a distance
     comparison has to undo the projection first */
  'float viewDepth(vec2 uv){',
  '  float d = unpackDepth(texture2D(uDepth, uv));',
  '  if(uOrtho > 0.5) return mix(uNear, uFar, d);',
  '  float ndc = d * 2.0 - 1.0;',
  '  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));',
  '}',

  'float hash(vec2 p){',
  '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
  '}',

  /* twelve taps on a spiral: enough to read as defocus rather than as a box,
     cheap enough to stay one pass */
  'const int TAPS = 12;',

  'void main(){',
  '  vec2 uv = vUv;',
  /* PIXELATION FIRST, so everything after it is sampled on the block grid and
     the picture reads as one resolution rather than as a sharp image with
     blocky edges pasted over it. */
  '  if(uPixel > 0.5) uv = (floor(uv * uGrid) + 0.5) / uGrid;',

  '  vec3 col = texture2D(uColor, uv).rgb;',

  '  if(uDof > 0.5){',
  '    float dist = viewDepth(uv);',
  '    float coc = clamp(abs(dist - uFocus) / max(uRange, 1e-4), 0.0, 1.0);',
  '    float r = coc * 9.0;',
  '    if(r > 0.6){',
  '      vec3 sum = col; float wsum = 1.0;',
  '      for(int i=0;i<TAPS;i++){',
  '        float a = float(i) * 2.39996;',            /* golden angle */
  '        float t = sqrt((float(i) + 0.5) / float(TAPS));',
  '        vec2 off = vec2(cos(a), sin(a)) * t * r * uTexel;',
  /* a sample nearer the camera than the focus must not bleed onto a sharp
     background, so weight each tap by how out of focus IT is */
  '        float dd = viewDepth(uv + off);',
  '        float w = clamp(abs(dd - uFocus) / max(uRange, 1e-4), 0.0, 1.0);',
  '        w = max(w, 0.05);',
  '        sum += texture2D(uColor, uv + off).rgb * w;',
  '        wsum += w;',
  '      }',
  '      col = sum / wsum;',
  '    }',
  '  }',

  '  if(uGrain > 0.0){',
  /* grain belongs to the IMAGE, so it is keyed to screen pixels and not to the
     scene - it must not swim about when the camera moves */
  '    float n = hash(gl_FragCoord.xy + uSeed) - 0.5;',
  '    col += n * uGrain;',
  '  }',

  '  gl_FragColor = vec4(col, 1.0);',
  '}'
].join('\n');

function ensure(w, h){
  if(target && sizeW === w && sizeH === h) return;
  if(target){ target.texture.dispose(); target.dispose(); }
  if(depthTarget){ depthTarget.texture.dispose(); depthTarget.dispose(); }

  target = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat, stencilBuffer: false
  });
  depthTarget = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    format: THREE.RGBAFormat, stencilBuffer: false
  });
  sizeW = w; sizeH = h;

  if(!quad){
    quadScene = new THREE.Scene();
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: {
        uColor:{value:null}, uDepth:{value:null},
        uTexel:{value:new THREE.Vector2()},
        uNear:{value:0.1}, uFar:{value:100}, uOrtho:{value:0},
        uFocus:{value:1}, uRange:{value:1},
        uDof:{value:0}, uGrain:{value:0}, uPixel:{value:0},
        uGrid:{value:new THREE.Vector2(100,100)}, uSeed:{value:0}
      },
      vertexShader: VERT, fragmentShader: FRAG, depthTest:false, depthWrite:false
    }));
    quad.frustumCulled = false;
    quadScene.add(quad);
  }
  quad.material.uniforms.uColor.value = target.texture;
  quad.material.uniforms.uDepth.value = depthTarget.texture;
  quad.material.uniforms.uTexel.value.set(1/w, 1/h);
}

/* Render the scene through the post pass. Returns false when there is nothing
   to do, so the caller falls back to rendering straight to the screen. */
P.renderWithFX = function(scene, cam){
  if(!P.fxActive()) return false;
  var r = P.renderer, size = r.getDrawingBufferSize(new THREE.Vector2());
  var w = Math.max(1, Math.floor(size.x)), h = Math.max(1, Math.floor(size.y));
  ensure(w, h);

  var prev = r.getRenderTarget();
  r.setRenderTarget(target);
  r.clear();
  r.render(scene, cam);

  /* the depth pass, only when something needs distances */
  if(FX.dofOn){
    var prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = depthMat;
    r.setRenderTarget(depthTarget);
    r.setClearColor(0xffffff, 1);          // cleared to the far plane
    r.clear();
    r.render(scene, cam);
    scene.overrideMaterial = prevOverride;
    r.setClearColor(P.ENV.bg, 1);
  }
  r.setRenderTarget(prev);

  var u = quad.material.uniforms;
  var ortho = !!cam.isOrthographicCamera;
  u.uNear.value = cam.near; u.uFar.value = cam.far;
  u.uOrtho.value = ortho ? 1 : 0;

  /* WHAT IS IN FOCUS is what you are orbiting around: the pivot is the point
     the whole camera model already treats as the subject. */
  u.uFocus.value = Math.max(cam.position.distanceTo(P.VIEW.pivot), 1e-3);
  /* f/22 keeps nearly everything sharp, f/1.4 almost nothing - the same way
     round as a real aperture. */
  u.uRange.value = Math.max(u.uFocus.value * (FX.fstop / 22), 1e-3);

  u.uDof.value   = FX.dofOn ? 1 : 0;
  u.uGrain.value = FX.grainOn ? (P.clamp(FX.grain, 0, 100) / 100) * 0.22 : 0;
  u.uPixel.value = FX.pixelOn ? 1 : 0;
  var block = Math.max(1, FX.pixel) * r.getPixelRatio();
  u.uGrid.value.set(Math.max(1, w/block), Math.max(1, h/block));
  /* a fixed seed, so the grain sits STILL. Reseeding per frame is television
     static; film grain belongs to the print and does not crawl when you look
     at it. */
  u.uSeed.value = 0;

  r.render(quadScene, quadCam);
  return true;
};

})(window.P);
