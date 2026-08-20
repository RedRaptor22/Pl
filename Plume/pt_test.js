// Dry-run: rotation-minimizing frames via double reflection (Wang et al. 2008)
// plus ring-based index buffer bounds. Plain JS, no Three.js.
//
// Run with:  node pt_test.js
// This covers the frame maths in isolation (the same algorithm now lives in
// P.transportFrames in js/core.js, and is what Bend sweeps a profile with).
// For the mechanics themselves — guide creation, projection, bend, masking,
// erase, gestures — open test.html over http:// instead; it drives the real
// app in an iframe and needs no toolchain.

const EPS = 1e-9;
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const mul=(a,s)=>[a[0]*s,a[1]*s,a[2]*s];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const len=a=>Math.sqrt(dot(a,a));
function norm(a){const l=len(a); return l<EPS?null:mul(a,1/l);}

// Any unit vector perpendicular to t, chosen without a degenerate axis.
function perpTo(t){
  const ax = Math.abs(t[0])<0.9 ? [1,0,0] : [0,1,0];
  return norm(cross(t,ax)) || [1,0,0];
}

// Tangents from a polyline: central differences, endpoints one-sided.
function tangents(pts){
  const n=pts.length, T=[];
  if(n===1) return [[0,0,1]];
  for(let i=0;i<n;i++){
    let v;
    if(i===0) v=sub(pts[1],pts[0]);
    else if(i===n-1) v=sub(pts[n-1],pts[n-2]);
    else v=sub(pts[i+1],pts[i-1]);
    let u=norm(v);
    if(!u){ // coincident neighbours: reuse previous tangent, else scan forward
      u = T[i-1] || null;
      if(!u){ for(let j=i+1;j<n&&!u;j++) u=norm(sub(pts[j],pts[i])); }
      if(!u) u=[0,0,1];
    }
    T.push(u);
  }
  return T;
}

// Parallel-transport frames. seed = optional preferred initial reference dir.
function ptFrames(pts, seed){
  const T=tangents(pts), n=pts.length, R=[];
  let r0=null;
  if(seed){ const p=sub(seed, mul(T[0], dot(seed,T[0]))); r0=norm(p); }
  if(!r0) r0=perpTo(T[0]);
  R.push(r0);
  for(let i=0;i<n-1;i++){
    const v1=sub(pts[i+1],pts[i]);
    const c1=dot(v1,v1);
    let rNext;
    if(c1<EPS){
      rNext=R[i];                                  // coincident points: carry through
    } else {
      const rL=sub(R[i], mul(v1, 2*dot(v1,R[i])/c1));
      const tL=sub(T[i], mul(v1, 2*dot(v1,T[i])/c1));
      const v2=sub(T[i+1], tL);
      const c2=dot(v2,v2);
      rNext = c2<EPS ? rL : sub(rL, mul(v2, 2*dot(v2,rL)/c2));
    }
    // re-orthonormalise against the tangent to stop drift accumulating
    let r=sub(rNext, mul(T[i+1], dot(rNext,T[i+1])));
    r=norm(r) || perpTo(T[i+1]);
    R.push(r);
  }
  return R.map((r,i)=>({t:T[i], r, s:cross(T[i],r)}));
}

// Frenet, for comparison only.
function frenet(pts){
  const T=tangents(pts), n=pts.length, out=[];
  for(let i=0;i<n;i++){
    let dT;
    if(i===0) dT=sub(T[1]||T[0],T[0]);
    else if(i===n-1) dT=sub(T[n-1],T[n-2]);
    else dT=sub(T[i+1],T[i-1]);
    let nrm=norm(cross(T[i],cross(dT,T[i]))) || perpTo(T[i]);
    out.push({t:T[i], r:nrm, s:cross(T[i],nrm)});
  }
  return out;
}

function finite(f){ return [f.t,f.r,f.s].every(v=>v.every(Number.isFinite)); }
function ortho(f){
  return Math.abs(len(f.t)-1)<1e-6 && Math.abs(len(f.r)-1)<1e-6 &&
         Math.abs(dot(f.t,f.r))<1e-6;
}

let fails=0;
function check(name, cond, extra){
  if(!cond){ fails++; console.log('FAIL  '+name+(extra!==undefined?'  '+extra:'')); }
  else console.log('ok    '+name+(extra!==undefined?'  '+extra:''));
}

// --- degenerate / edge cases ------------------------------------------------
const cases = {
  'single point': [[0,0,0]],
  'two identical points': [[1,2,3],[1,2,3]],
  'all identical (5)': Array.from({length:5},()=>[0,0,0]),
  'straight line': Array.from({length:20},(_,i)=>[i*0.1,0,0]),
  'straight then dup mid': [[0,0,0],[1,0,0],[1,0,0],[2,0,0]],
  'exact 180 reversal': [[0,0,0],[1,0,0],[0,0,0]],
  'near-180 hairpin': [[0,0,0],[1,0,0],[0,1e-6,0]],
  'tiny scale (1e-7)': Array.from({length:10},(_,i)=>[i*1e-7,Math.sin(i)*1e-7,0]),
  'huge scale (1e7)': Array.from({length:10},(_,i)=>[i*1e7,Math.sin(i)*1e7,0]),
  'helix 200':Array.from({length:200},(_,i)=>{const u=i*0.12;return [Math.cos(u),Math.sin(u),u*0.15];}),
  'inflection (S-curve)': Array.from({length:120},(_,i)=>{const u=-3+i*0.05;return [u,Math.sin(u),0];}),
  'planar circle 128': Array.from({length:128},(_,i)=>{const u=i/128*2*Math.PI;return [Math.cos(u),Math.sin(u),0];}),
};
for(const [name,pts] of Object.entries(cases)){
  const F=ptFrames(pts);
  check(name+' :: no NaN', F.every(finite));
  check(name+' :: orthonormal', F.every(ortho));
}

// --- flip behaviour at an inflection: PT should stay smooth, Frenet should not
{
  const pts=cases['inflection (S-curve)'];
  const worst=(F)=>{let w=0;for(let i=1;i<F.length;i++)w=Math.max(w,len(sub(F[i].r,F[i-1].r)));return w;};
  const wp=worst(ptFrames(pts)), wf=worst(frenet(pts));
  check('PT frame is continuous across inflection', wp<0.2, 'max step '+wp.toFixed(4));
  check('Frenet flips there (PT is the right call)', wf>1.0, 'max step '+wf.toFixed(4));
}

// --- closed-loop drift: how far off is the frame after a full circle? --------
{
  const F=ptFrames(cases['planar circle 128']);
  const d=len(sub(F[F.length-1].r, F[0].r));
  check('planar loop closes with negligible drift', d<1e-6, 'drift '+d.toExponential(2));
}

// --- seeded start direction is respected ------------------------------------
{
  const pts=cases['straight line'];
  const F=ptFrames(pts,[0,0,1]);
  check('seed direction honoured', Math.abs(Math.abs(dot(F[0].r,[0,0,1]))-1)<1e-9);
  const G=ptFrames(pts,[1,0,0]); // seed parallel to tangent -> must not NaN
  check('seed parallel to tangent falls back safely', G.every(finite) && G.every(ortho));
}

// --- ring index buffer bounds ----------------------------------------------
function ringIndices(nPts, seg){
  const idx=[];
  for(let i=0;i<nPts-1;i++)for(let j=0;j<seg;j++){
    const a=i*seg+j, b=i*seg+(j+1)%seg, c=(i+1)*seg+j, d=(i+1)*seg+(j+1)%seg;
    idx.push(a,c,b, b,c,d);
  }
  return idx;
}
{
  let bad=0, maxTested=0;
  for(const nPts of [2,3,5,17,64,500,2000]) for(const seg of [3,4,6,8,12,16]){
    const verts=nPts*seg, idx=ringIndices(nPts,seg);
    if(idx.some(v=>v<0||v>=verts)) bad++;
    if(idx.length !== (nPts-1)*seg*6) bad++;
    maxTested=Math.max(maxTested,verts);
  }
  check('ring index buffer in bounds & correct count', bad===0, 'max verts '+maxTested);
  check('index fits Uint16 below 65536 verts', maxTested<65536, 'else Uint32 needed');
}

// --- ribbon (flat brush) index buffer, open cross-section -------------------
function ribbonIndices(nPts, seg){ // seg = points across the ribbon, NOT wrapped
  const idx=[];
  for(let i=0;i<nPts-1;i++)for(let j=0;j<seg-1;j++){
    const a=i*seg+j, b=i*seg+j+1, c=(i+1)*seg+j, d=(i+1)*seg+j+1;
    idx.push(a,c,b, b,c,d);
  }
  return idx;
}
{
  let bad=0;
  for(const nPts of [2,10,300]) for(const seg of [2,3,5]){
    const verts=nPts*seg, idx=ribbonIndices(nPts,seg);
    if(idx.some(v=>v<0||v>=verts)) bad++;
    if(idx.length !== (nPts-1)*(seg-1)*6) bad++;
  }
  check('ribbon index buffer in bounds & correct count', bad===0);
}

console.log(fails===0 ? '\nALL PASS' : '\n'+fails+' FAILURE(S)');
process.exit(fails?1:0);
