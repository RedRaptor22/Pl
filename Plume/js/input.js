/* ==========================================================================
   PLUME / input.js — pointer routing, palm rejection, and the full gesture set.
   --------------------------------------------------------------------------
   Gestures follow Feather's documented Navigation page (B.1):
     one finger swipe .............. orbit (with release momentum)
     one finger double-tap ......... snap to the nearest of the six ortho views
     pinch ......................... zoom
     two finger swipe .............. pan
     two finger twist .............. roll the canvas
     three finger double-tap ....... perspective <-> orthographic
     three finger swipe (vertical).. focal length, 10-500 mm
     tap and hold on curve/grid .... pin the orbit point
     tap and hold on empty space ... unpin, or reset the view if not pinned
   Drawing is pen-only, with the documented Finger-Pen workaround as a toggle.

   Palm rejection: penDown blocks all touch handling, and any touch already
   live when the pen lands is marked as a palm and stays blocked until it
   physically lifts — so a palm resting through a whole stroke can never
   resume orbiting when the pen leaves the glass.
   ========================================================================== */
(function(P){
'use strict';

var el = P.elStage, TOOL = P.TOOL, Tools = P.Tools, S = P.Strokes, G = P.Guides;

/* FINGER-FIRST BY DEFAULT ON TOUCH HARDWARE.
   Feather is pen-only for guides because every iPad can pair a Pencil. Most
   Android tablets ship without a usable stylus, so the documented Finger-Pen
   "workaround" is promoted to the default whenever the primary pointer is
   coarse. If a real pen ever touches the glass we hand the app back to the
   pen-first mapping, once, and say so.                                     */
var coarse = false;
try { coarse = window.matchMedia('(pointer: coarse)').matches; } catch(err){}

var IN = P.Input = {
  fingerPen : coarse,
  fingerPenAuto : coarse,   // true while the value is ours, not the user's
  penDown   : false,
  penSeen   : false,
  barrelSeen: false
};

var blocked = Object.create(null);        // pointerId -> palm
var touches = Object.create(null);
var touchCount = 0;

var orbit = null, pinch = null, tri = null;
var holdTimer = null, holdOrigin = null;
var lastTap = {t:0, x:0, y:0, n:0};

/* A gesture spans from the first finger landing to the last one lifting.
   Its PEAK finger count is what identifies it, not the count at any single
   pointerup — fingers come off one at a time, so reading the count on each
   lift would report every three-finger tap as a one-finger tap. */
var gesture = null;

var HOLD_MS = 480, HOLD_SLOP = 12, TAP_MS = 300, TAP_SLOP = 22, TAP_MAX_MS = 420;

function touchList(){
  var out = [];
  for(var id in touches) out.push(touches[id]);
  return out;
}
function centroid(list){
  var cx=0, cy=0;
  for(var i=0;i<list.length;i++){ cx+=list[i].x; cy+=list[i].y; }
  return {x:cx/list.length, y:cy/list.length};
}
function cancelHold(){ if(holdTimer){ clearTimeout(holdTimer); holdTimer=null; } holdOrigin=null; }
function cancelNav(){ orbit=null; pinch=null; tri=null; cancelHold(); }

/* ---- is this pointer a drawing pointer? ---------------------------------- */
function isPen(e){
  if(e.pointerType === 'pen') return true;
  if(e.pointerType === 'mouse') return e.button === 0 && !e.shiftKey && !e.altKey;
  return e.pointerType === 'touch' && IN.fingerPen;
}

/* ==========================================================================
   Pen / draw pointer
   ========================================================================== */
function penBegin(e){
  IN.penDown = true;
  drawPointer = {id:e.pointerId, type:e.pointerType, x:e.clientX, y:e.clientY};
  for(var id in touches) blocked[id] = true;      // everything down now is palm
  touches = Object.create(null); touchCount = 0;
  cancelNav();
  P.killSpin();
  try{ el.setPointerCapture(e.pointerId); }catch(err){}

  /* Select and Loft are tap tools, not drag tools */
  if(TOOL.mode === 'select'){
    penTapPending = {x:e.clientX, y:e.clientY, t:performance.now(), moved:false};
    holdOrigin = {x:e.clientX, y:e.clientY};
    holdTimer = setTimeout(function(){
      holdTimer = null;
      if(Tools.longPressSelect(holdOrigin.x, holdOrigin.y)){
        penTapPending = null;
        P.toast('Guide selected — use the joystick');
      }
    }, HOLD_MS);
    return;
  }
  if(TOOL.mode === 'loft'){
    penTapPending = {x:e.clientX, y:e.clientY, t:performance.now(), moved:false};
    return;
  }
  Tools.begin(e.clientX, e.clientY, e);
}

var penTapPending = null;
var drawPointer = null;         // the pointer currently drawing, if any

function penMove(e){
  if(drawPointer && drawPointer.id === e.pointerId){
    drawPointer.x = e.clientX; drawPointer.y = e.clientY;
  }
  if(penTapPending){
    if(Math.hypot(e.clientX-penTapPending.x, e.clientY-penTapPending.y) > TAP_SLOP){
      penTapPending.moved = true;
      cancelHold();
    }
    /* once a select press has moved it is a SWEEP, picking up every curve it
       crosses. The tap is still the tap while it holds still. */
    if(penTapPending.moved && TOOL.mode === 'select'){
      Tools.sweepSelect(e.clientX, e.clientY, penTapPending);
    }
    return;
  }
  if(holdOrigin && Math.hypot(e.clientX-holdOrigin.x, e.clientY-holdOrigin.y) > HOLD_SLOP) cancelHold();

  /* COALESCED SAMPLES. A pen reports far faster than the display refreshes —
     an S Pen at ~240Hz against a 60Hz frame — and the browser hands over one
     pointermove per frame with the rest folded into it. Asking for them back
     is the difference between a stroke sampled every 30px on a fast flick and
     one sampled every 8px, and it costs nothing where it is unsupported. */
  var co = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
  if(co && co.length > 1){
    for(var i=0;i<co.length;i++) Tools.extend(co[i].clientX, co[i].clientY, co[i]);
    return;
  }
  Tools.extend(e.clientX, e.clientY, e);
}

function penEnd(e){
  IN.penDown = false;
  drawPointer = null;
  cancelHold();
  try{ el.releasePointerCapture(e.pointerId); }catch(err){}
  if(penTapPending){
    var tp = penTapPending; penTapPending = null;
    if(tp.moved && TOOL.mode === 'select'){ Tools.endSweepSelect(); return; }
    if(!tp.moved){
      /* a tap ADDS rather than replacing; there is no modifier key on a
         tablet, and picking two curves has to be possible without one */
      if(TOOL.mode === 'select') Tools.tapSelect(tp.x, tp.y, true);
      else if(TOOL.mode === 'loft'){
        Tools.loftPick(tp.x, tp.y);
        P.onSceneChange();
      }
    }
    return;
  }
  Tools.finish();
}

/* ==========================================================================
   Navigation pointers
   ========================================================================== */
function navBegin(e){
  touches[e.pointerId] = {id:e.pointerId, x:e.clientX, y:e.clientY,
                          sx:e.clientX, sy:e.clientY};
  touchCount++;
  P.killSpin();
  P.cancelViewAnim();

  if(!gesture) gesture = {max:0, t0:performance.now(), moved:false, held:false,
                          cx:e.clientX, cy:e.clientY};
  if(touchCount > gesture.max){
    gesture.max = touchCount;
    var g = centroid(touchList());
    gesture.cx = g.x; gesture.cy = g.y;      // centroid at peak finger count
  }

  if(touchCount === 1){
    orbit = {id:e.pointerId, x:e.clientX, y:e.clientY, vx:0, vy:0};
    pinch = null; tri = null;
    holdOrigin = {x:e.clientX, y:e.clientY};
    cancelHold();
    holdTimer = setTimeout(function(){ doPressHold(holdOrigin.x, holdOrigin.y); }, HOLD_MS);
  } else if(touchCount === 2){
    cancelHold(); orbit = null; tri = null;
    var t = touchList();
    pinch = {
      dist: Math.hypot(t[0].x-t[1].x, t[0].y-t[1].y),
      ang : Math.atan2(t[1].y-t[0].y, t[1].x-t[0].x),
      cx  : (t[0].x+t[1].x)/2, cy:(t[0].y+t[1].y)/2,
      radius: P.VIEW.radius, roll: P.VIEW.roll
    };
  } else if(touchCount === 3){
    cancelHold(); orbit = null; pinch = null;
    var c = centroid(touchList());
    tri = {cx:c.x, cy:c.y, focal:P.VIEW.focal};
  } else {
    cancelNav();
  }
}

function navMove(e){
  var rec = touches[e.pointerId];
  if(!rec) return;
  rec.x = e.clientX; rec.y = e.clientY;

  /* a finger that travels is a swipe, not a tap */
  if(gesture && Math.hypot(e.clientX-rec.sx, e.clientY-rec.sy) > TAP_SLOP) gesture.moved = true;

  if(holdOrigin && Math.hypot(e.clientX-holdOrigin.x, e.clientY-holdOrigin.y) > HOLD_SLOP) cancelHold();

  if(tri && touchCount === 3){
    var c = centroid(touchList());
    if(IN.fingerPen){
      /* finger-drawing mode: one finger draws, so pan moves up to three.
         FOV lives on the lens slider instead — there is no fourth finger
         mapping worth teaching. */
      panPivot(c.x - tri.cx, c.y - tri.cy);
      tri.cx = c.x; tri.cy = c.y;
    } else {
      /* FACT (B.1): three-finger swipe changes FOV, 10-500 mm.
         GUESS: up = longer lens. The docs say "up = increase" without saying
         increase what; longer focal is the reading that matches "increase FOV
         value". */
      var dy = tri.cy - c.y;
      P.VIEW.focal = P.clamp(tri.focal * Math.exp(dy * 0.006),
                             P.TUNE.focalMin, P.TUNE.focalMax);
    }
    P.applyCamera();
    P.onViewChange();
    return;
  }

  if(pinch && touchCount === 2){
    var t = touchList();
    if(t.length < 2) return;
    var dist = Math.hypot(t[0].x-t[1].x, t[0].y-t[1].y);
    var ang  = Math.atan2(t[1].y-t[0].y, t[1].x-t[0].x);
    var cx = (t[0].x+t[1].x)/2, cy = (t[0].y+t[1].y)/2;
    if(dist > 4 && pinch.dist > 4) P.VIEW.radius = pinch.radius * (pinch.dist/dist);
    P.VIEW.roll = pinch.roll + (ang - pinch.ang);
    if(IN.fingerPen){
      /* two fingers orbit here, because one finger is busy drawing */
      var k2 = 0.0062;
      P.VIEW.theta -= (cx - pinch.cx) * k2;
      P.VIEW.phi   -= (cy - pinch.cy) * k2;
    } else {
      panPivot(cx - pinch.cx, cy - pinch.cy);
    }
    pinch.cx = cx; pinch.cy = cy;
    pinch.radius = P.VIEW.radius; pinch.dist = dist;
    P.applyCamera();
    P.onViewChange();
    return;
  }

  if(orbit && orbit.id === e.pointerId){
    var k = 0.0062;                                   // GUESS: orbit sensitivity
    var dth = -(e.clientX - orbit.x) * k;
    var dph = -(e.clientY - orbit.y) * k;
    P.VIEW.theta += dth;
    P.VIEW.phi   += dph;
    orbit.vx = dth; orbit.vy = dph;
    orbit.x = e.clientX; orbit.y = e.clientY;
    P.applyCamera();
    P.onViewChange();
  }
}

function navEnd(e){
  delete blocked[e.pointerId];
  if(touches[e.pointerId]){ delete touches[e.pointerId]; touchCount = Math.max(0, touchCount-1); }
  cancelHold();

  if(orbit && orbit.id === e.pointerId){
    /* legacy release note: "added momentum to camera rotation movement" */
    P.addSpin(orbit.vx, orbit.vy);
  }
  if(touchCount < 3) tri = null;
  if(touchCount < 2) pinch = null;
  if(touchCount === 0) orbit = null;
  else if(touchCount === 1){
    var t = touchList()[0];
    orbit = {id:t.id, x:t.x, y:t.y, vx:0, vy:0};
  }
}

function panPivot(dxPx, dyPx){
  var right = new THREE.Vector3(), up = new THREE.Vector3(), fwd = new THREE.Vector3();
  P.camBasis(right, up, fwd);
  var s = P.viewHeight()/P.viewport().h;
  P.VIEW.pivot.addScaledVector(right, -dxPx*s);
  P.VIEW.pivot.addScaledVector(up,     dyPx*s);
  P.VIEW.pinned = true;
}

/* ==========================================================================
   Taps: single/double, 1-finger and 3-finger
   ========================================================================== */
function registerTap(x, y, fingers){
  var now = performance.now();
  /* lastTap.n === 0 means "nothing pending". It must be an explicit sentinel
     rather than a zeroed timestamp: performance.now() starts near zero, so in
     the first fraction of a second `now - 0` is still inside the double-tap
     window and a third tap would fire a second time. */
  var isDouble = lastTap.n === fingers &&
                 (now - lastTap.t < TAP_MS) &&
                 (Math.hypot(x-lastTap.x, y-lastTap.y) < TAP_SLOP);
  if(isDouble){
    lastTap = {t:0, x:0, y:0, n:0};              // consumed
    if(fingers === 1){
      var name = P.snapNearestOrtho();
      P.toast(name + ' view');
    } else if(fingers === 3){
      P.toast(P.toggleProjection());
      P.onViewChange();
    }
    return true;
  }
  lastTap = {t:now, x:x, y:y, n:fingers};
  return false;
}

/* FACT (B.2/B.3): hold on a curve or the grid pins the orbit point; hold on
   empty space unpins it, or resets the view when it was not pinned. */
function doPressHold(x, y){
  holdTimer = null;
  if(gesture) gesture.held = true;          // a hold is never also a tap
  var eye = P.cam().position.clone();
  var ray = P.rayFrom(x, y);

  var hits = ray.intersectObjects(S.group.children, false);
  if(hits.length){
    P.VIEW.pivot.copy(hits[0].point); P.VIEW.pinned = true;
    P.syncViewToEye(eye); P.applyCamera(); P.pulsePivot();
    P.toast('Orbit point pinned'); orbit = null; P.onViewChange(); return;
  }
  if(G.hasActive()){
    var gh = ray.intersectObject(G.active.mesh, false);
    if(gh.length){
      P.VIEW.pivot.copy(gh[0].point); P.VIEW.pinned = true;
      P.syncViewToEye(eye); P.applyCamera(); P.pulsePivot();
      P.toast('Orbit point pinned'); orbit = null; P.onViewChange(); return;
    }
  }
  if(P.ENV.grid){
    var plane = new THREE.Plane(new THREE.Vector3(0,1,0), 0), gt = new THREE.Vector3();
    if(ray.ray.intersectPlane(plane, gt) && Math.abs(gt.x) < 20 && Math.abs(gt.z) < 20){
      P.VIEW.pivot.copy(gt); P.VIEW.pinned = true;
      P.syncViewToEye(eye); P.applyCamera(); P.pulsePivot();
      P.toast('Orbit point pinned'); orbit = null; P.onViewChange(); return;
    }
  }
  /* empty space */
  if(P.VIEW.pinned){
    P.VIEW.pinned = false;
    P.autoPivot(true);
    P.pulsePivot();
    P.toast('Orbit point released');
  } else {
    P.resetView();
    P.toast('View reset');
  }
  orbit = null;
  P.onViewChange();
}

/* ==========================================================================
   Event wiring
   ========================================================================== */
el.addEventListener('pointerdown', function(e){
  e.preventDefault();
  P.reportPointer(e, false);

  /* first real pen contact: give the app back to the pen-first mapping */
  if(e.pointerType === 'pen' && !IN.penSeen){
    IN.penSeen = true;
    if(IN.fingerPen && IN.fingerPenAuto){
      IN.fingerPen = false; IN.fingerPenAuto = false;
      P.toast('Pen detected — one finger now orbits');
      if(P.UI) P.UI.refresh();
    }
  }

  if(isPen(e)){
    if(IN.penDown){
      /* In finger-drawing mode a second finger means "I wanted to navigate,
         not draw". Abandon the stroke in progress and hand BOTH fingers to
         navigation, otherwise the second finger is swallowed and the user is
         stuck mid-stroke with no way to orbit. */
      if(IN.fingerPen && e.pointerType === 'touch' && drawPointer &&
         drawPointer.type === 'touch'){
        Tools.cancel();
        IN.penDown = false;
        var first = drawPointer; drawPointer = null;
        touches[first.id] = {id:first.id, x:first.x, y:first.y, sx:first.x, sy:first.y};
        touchCount = 1;
        gesture = {max:1, t0:performance.now(), moved:true, held:false,
                   cx:first.x, cy:first.y};
        navBegin(e);
      }
      return;
    }
    penBegin(e);
    return;
  }
  if(IN.penDown || blocked[e.pointerId]){ blocked[e.pointerId] = true; return; }
  navBegin(e);
}, {passive:false});

el.addEventListener('pointermove', function(e){
  if(e.pointerType === 'pen'){
    var hovering = !IN.penDown && e.buttons === 0;
    P.reportPointer(e, hovering);
    if(IN.penDown){ e.preventDefault(); penMove(e); }
    else P.updateHoverCursor(e.clientX, e.clientY, e);
    return;
  }
  if(IN.penDown && !isPen(e)) return;
  if(IN.penDown && isPen(e)){ e.preventDefault(); penMove(e); return; }
  if(blocked[e.pointerId] || !touches[e.pointerId]){
    if(e.pointerType === 'mouse' && e.buttons === 0) P.updateHoverCursor(e.clientX, e.clientY, e);
    return;
  }
  e.preventDefault();
  navMove(e);
}, {passive:false});

function up(e){
  if(e.pointerType === 'pen' || (IN.penDown && isPen(e))){
    if(IN.penDown) penEnd(e);
    return;
  }
  navEnd(e);
  if(touchCount > 0 || !gesture) return;

  /* last finger up: decide whether the whole gesture was a tap */
  var g = gesture; gesture = null;
  if(g.moved || g.held) return;
  if(performance.now() - g.t0 > TAP_MAX_MS) return;
  registerTap(g.cx, g.cy, g.max);
}
el.addEventListener('pointerup', up);
el.addEventListener('pointercancel', function(e){
  if(e.pointerType === 'pen' || (IN.penDown && isPen(e))){
    if(IN.penDown){ IN.penDown = false; Tools.cancel(); }
    return;
  }
  navEnd(e);
  if(touchCount === 0) gesture = null;      // a cancelled gesture is not a tap
});
el.addEventListener('pointerleave', function(e){
  if(e.pointerType === 'pen' && !IN.penDown) P.hideHoverCursor();
});
el.addEventListener('contextmenu', function(e){ e.preventDefault(); });

/* ---- mouse extras: wheel zoom, right-drag orbit, middle-drag pan --------- */
el.addEventListener('wheel', function(e){
  e.preventDefault();
  P.cancelViewAnim();
  P.VIEW.radius *= Math.exp(e.deltaY * 0.0012);
  P.applyCamera();
  P.onViewChange();
}, {passive:false});

/* ==========================================================================
   Keyboard — the desktop equivalents of the multi-finger gestures, and the
   documented rough edge worth fixing: Feather has no gesture undo at all.
   ========================================================================== */
window.addEventListener('keydown', function(e){
  if(e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  var k = e.key.toLowerCase();

  if((e.ctrlKey || e.metaKey) && k === 'z'){
    e.preventDefault();
    if(e.shiftKey) P.History.redo(); else P.History.undo();
    P.onSceneChange(); return;
  }
  if((e.ctrlKey || e.metaKey) && k === 'y'){
    e.preventDefault(); P.History.redo(); P.onSceneChange(); return;
  }
  if(e.ctrlKey || e.metaKey) return;

  switch(k){
    case 'd': P.setTool('draw');   break;
    case 'g': P.setTool('guide');  break;
    case 'b': P.setTool('bend');   break;
    case 'e': P.setTool('erase');  break;
    case 'v': P.setTool('vacuum'); break;
    case 's': P.setTool('select'); break;
    case 'l': P.setTool('lasso');  break;
    case 'm': P.setTool('smooth'); break;
    case 'k': P.setTool('fill');   break;   // f is View reset
    case 'r': P.setTool('shape');  break;
    case 'o': P.toast(P.toggleProjection()); P.onViewChange(); break;
    case 'f': P.resetView(); P.toast('View reset'); break;
    case '[': P.VIEW.focal = P.clamp(P.VIEW.focal/1.15, P.TUNE.focalMin, P.TUNE.focalMax);
              P.applyCamera(); P.onViewChange(); break;
    case ']': P.VIEW.focal = P.clamp(P.VIEW.focal*1.15, P.TUNE.focalMin, P.TUNE.focalMax);
              P.applyCamera(); P.onViewChange(); break;
    case 'escape': Tools.stagedCancel(); P.setTool('draw'); break;
  }
  if(k >= '1' && k <= '6'){
    var v = P.ORTHO_VIEWS[parseInt(k,10)-1];
    P.animateView({theta:v.theta, phi:v.phi, roll:0});
    P.toast(v.name + ' view');
  }
});

/* ==========================================================================
   Android hardware / gesture back
   --------------------------------------------------------------------------
   Inside a TWA or Capacitor shell an unhandled back press exits the app, which
   from a sketchbook is indistinguishable from losing your work. Arm a history
   entry and consume back presses while there is anything to dismiss; when
   there genuinely is nothing left, stop re-arming so the next press exits.
   ========================================================================== */
P.onBack = function(){
  if(P.UI && P.UI.closeTopSheet && P.UI.closeTopSheet()) return true;
  if(P.stagedGuide){ Tools.stagedCancel(); P.setTool('draw'); return true; }
  if(P.Strokes.selection.length){ P.Strokes.clearSelection(); P.onSceneChange(); return true; }
  if(P.History.canUndo()){ P.History.undo(); P.onSceneChange(); return true; }
  return false;
};

(function armBack(){
  if(!window.history || !window.history.pushState) return;
  try { history.pushState({plume:1}, ''); } catch(err){ return; }
  window.addEventListener('popstate', function(){
    if(P.onBack()){
      try { history.pushState({plume:1}, ''); } catch(err){}
    }
    /* not handled: leave the stack alone so the shell can close the app */
  });
})();

/* Keep the screen awake while sketching — a drawing app gets long stretches
   with no touch events, which is exactly when Android dims and sleeps. */
(function keepAwake(){
  if(!navigator.wakeLock || !navigator.wakeLock.request) return;
  var lock = null;
  function acquire(){
    if(document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function(l){
      lock = l;
      l.addEventListener('release', function(){ lock = null; });
    }).catch(function(){ /* denied or unsupported: not fatal */ });
  }
  acquire();
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'visible' && !lock) acquire();
  });
})();

/* ---- diagnostics readout (kept from stage 1; useful on real hardware) ---- */
P.reportPointer = function(e, hovering){
  var d = P.diag;
  if(!d) return;
  d.type.textContent  = e.pointerType || '—';
  d.press.textContent = (e.pressure !== undefined ? e.pressure.toFixed(3) : '—');
  d.tilt.textContent  = (e.tiltX|0) + ' / ' + (e.tiltY|0);
  d.btn.textContent   = e.buttons;
  d.hover.textContent = hovering ? 'yes' : 'no';
  if(e.pointerType === 'pen' && (e.buttons & 2)){
    IN.barrelSeen = true;
    d.barrel.textContent = 'DETECTED';
    d.barrel.style.color = 'var(--accent)';
  }
};

})(window.P);
