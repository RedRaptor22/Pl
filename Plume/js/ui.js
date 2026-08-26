/* ==========================================================================
   PLUME / ui.js — panel wiring, the joystick, tooltips and onboarding.
   --------------------------------------------------------------------------
   Two of the spec's documented rough edges are deliberately fixed here rather
   than reproduced: there ARE tooltips on every control (App Store reviews:
   "no tooltips", "obscure" iconography), and there IS a first-run walkthrough
   of the guide workflow (D.2: onboarding is a known weakness).
   ========================================================================== */
(function(P){
'use strict';

var S = P.Strokes, G = P.Guides, Tools = P.Tools, TOOL = P.TOOL;
var UI = P.UI = { primKind:'cube', primSeg:24, primTaper:1 };

function $(id){ return document.getElementById(id); }
function on(el, ev, fn){ if(el) el.addEventListener(ev, fn); }
function setOn(el, v){ if(el) el.classList.toggle('on', !!v); }

var PALETTE = ['#1b1c21','#ffffff','#f2545b','#ff8a3d','#f5c518',
               '#4cc38a','#5b9dff','#8b6cf0','#e879b9','#9a7b5c'];

/* ==========================================================================
   Theme — light or dark chrome, chosen from the canvas background unless the
   user has pinned it. Feather's UI does the same thing, and it matters here
   because the panels float directly over the scene.
   ========================================================================== */
UI.themeOverride = null;              // null = follow the background

UI.syncTheme = function(){
  var dark;
  if(UI.themeOverride) dark = (UI.themeOverride === 'dark');
  else {
    var c = P.ENV.bg;
    dark = (c.r*0.299 + c.g*0.587 + c.b*0.114) < 0.42;
  }
  document.body.classList.toggle('dark', dark);
};

UI.cycleTheme = function(){
  UI.themeOverride = UI.themeOverride === null ? 'light'
                   : UI.themeOverride === 'light' ? 'dark' : null;
  UI.syncTheme();
  P.toast(UI.themeOverride ? ('Theme: ' + UI.themeOverride) : 'Theme follows the background');
  UI.refresh();
};

/* ==========================================================================
   Tooltips  (fixes the documented "no tooltips" complaint)
   ========================================================================== */
var tipEl;
function initTips(){
  tipEl = $('tip');

  document.addEventListener('pointerover', function(e){
    /* hover tips are a mouse/pen affordance. On touch, pointerover fires on
       tap and the tip would just sit there over the control you pressed —
       long-press summons it instead (below). */
    if(e.pointerType === 'touch') return;
    showTipFor(e.target.closest && e.target.closest('[data-tip]'));
  });
  document.addEventListener('pointerout', function(e){
    if(e.pointerType === 'touch') return;
    if(!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-tip]')){
      tipEl.classList.remove('show');
    }
  });

  /* long-press to reveal a tip on touch */
  var pressTimer = null, pressTarget = null;
  document.addEventListener('pointerdown', function(e){
    if(e.pointerType !== 'touch') return;
    pressTarget = e.target.closest && e.target.closest('[data-tip]');
    if(!pressTarget) return;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function(){
      showTipFor(pressTarget);
      setTimeout(function(){ tipEl.classList.remove('show'); }, 2600);
    }, 480);
  }, true);
  function endPress(){ clearTimeout(pressTimer); pressTimer = null; }
  document.addEventListener('pointerup', endPress, true);
  document.addEventListener('pointercancel', endPress, true);
  document.addEventListener('pointermove', function(e){
    if(e.pointerType === 'touch' && pressTimer) endPress();
  }, true);

  function showTipFor(t){
    if(!t){ tipEl.classList.remove('show'); return; }
    tipEl.innerHTML = t.getAttribute('data-tip');
    tipEl.classList.add('show');
    var r = t.getBoundingClientRect();
    tipEl.style.visibility = 'hidden';
    tipEl.style.left = '0px'; tipEl.style.top = '0px';
    var tr = tipEl.getBoundingClientRect();
    var vw = document.documentElement.clientWidth;
    var x = P.clamp(r.left + r.width/2 - tr.width/2, 6, vw - tr.width - 6);
    var y = r.top - tr.height - 8;
    if(y < 6) y = r.bottom + 8;
    tipEl.style.left = x + 'px';
    tipEl.style.top  = y + 'px';
    tipEl.style.visibility = '';
  }
}

/* ==========================================================================
   Compact mode — panels become bottom sheets on phone-sized screens
   ========================================================================== */
/* sysMenu is deliberately NOT here — it is a centred modal now, because as a
   left-anchored popover it sat exactly on top of the brush rail. */
var SHEETS = ['tools','brush','joy','stagePanel'];
var COMPACT_MAX = 720;                 // GUESS: below this the side rails stop fitting

UI.compact = false;

UI.applyMode = function(){
  var compact = document.documentElement.clientWidth < COMPACT_MAX;
  if(compact === UI.compact && document.body.classList.contains('compact') === compact) return;
  UI.compact = compact;
  document.body.classList.toggle('compact', compact);

  for(var i=0;i<SHEETS.length;i++){
    var el = $(SHEETS[i]);
    if(!el) continue;
    el.classList.remove('open');
    if(compact){
      /* the transform hides it; `hidden` would kill the slide animation */
      el.classList.remove('hidden');
    } else {
      /* restore the desktop rules: rails visible, overlays hidden */
      if(SHEETS[i] === 'stagePanel') el.classList.add('hidden');
      else el.classList.remove('hidden');
    }
  }
  UI.refresh();
};

/* ---- the settings modal ---- */
UI.setMenu = function(open){
  $('sysMenu').classList.toggle('hidden', !open);
  $('scrim').classList.toggle('hidden', !open);
};
UI.menuOpen = function(){ return !$('sysMenu').classList.contains('hidden'); };

function sheetOpen(id){ var el = $(id); return !!el && el.classList.contains('open'); }

UI.openSheet = function(id){
  for(var i=0;i<SHEETS.length;i++) if(SHEETS[i] !== id) $(SHEETS[i]).classList.remove('open');
  var el = $(id);
  if(!el) return;
  el.classList.remove('hidden');
  el.classList.add('open');
  UI.refresh();
};

UI.toggleSheet = function(id){
  if(sheetOpen(id)){ $(id).classList.remove('open'); UI.refresh(); }
  else UI.openSheet(id);
};

/* used by the Android back handler */
UI.closeTopSheet = function(){
  if(UI.menuOpen()){ UI.setMenu(false); return true; }
  for(var i=0;i<SHEETS.length;i++){
    if(sheetOpen(SHEETS[i])){ $(SHEETS[i]).classList.remove('open'); UI.refresh(); return true; }
  }
  if(!UI.compact && !$('stagePanel').classList.contains('hidden')){
    $('stagePanel').classList.add('hidden'); UI.refresh(); return true;
  }
  return false;
};

/* ==========================================================================
   Segmented control helper
   ========================================================================== */
function seg(container, attr, apply){
  on(container, 'click', function(e){
    var b = e.target.closest('button');
    if(!b || !b.dataset[attr]) return;
    var all = container.querySelectorAll('button');
    for(var i=0;i<all.length;i++) all[i].classList.remove('on');
    b.classList.add('on');
    apply(b.dataset[attr]);
  });
}

/* ==========================================================================
   Init
   ========================================================================== */
UI.init = function(){
  initTips();

  /* ---- tools ----
     FACT (D.1): "each icon toggles on repeated tap". Tapping the active Draw
     gives Draw Shape, Select gives Lasso, Erase gives Vacuum — which is how
     eleven tools fit behind six icons. */
  var PARTNER = { draw:'shape', shape:'draw', select:'lasso', lasso:'select',
                  erase:'vacuum', vacuum:'erase' };
  function toolClick(e){
    var b = e.target.closest('button[data-tool]');
    if(!b) return;
    var want = b.dataset.tool;
    if(TOOL.mode === want && PARTNER[want]) want = PARTNER[want];
    P.setTool(want);
    if(UI.compact) UI.closeTopSheet();
  }
  on($('tools'), 'click', toolClick);
  on($('ctx'),   'click', toolClick);       // the guide tools live down there

  on($('btnTheme'), 'click', function(){ UI.cycleTheme(); });

  /* brush swatch opens the type popover */
  on($('brushColor'), 'click', function(){
    $('brushGrid').classList.toggle('hidden');
    UI.refresh();
  });
  document.addEventListener('pointerdown', function(e){
    var g = $('brushGrid');
    if(g.classList.contains('hidden')) return;
    if(e.target.closest('#brushGrid') || e.target.closest('#brushColor')) return;
    g.classList.add('hidden');
    UI.refresh();
  }, true);

  /* FACT (C.10): Mirror supports X and, from v1.5, Z. */
  on($('btnMirror'), 'click', function(){
    TOOL.mirror = TOOL.mirror === null ? 'x' : (TOOL.mirror === 'x' ? 'z' : null);
    P.toast(TOOL.mirror ? ('Mirror ' + TOOL.mirror.toUpperCase()) : 'Mirror off');
    UI.refresh();
  });

  on($('btnStage'), 'click', function(){
    if(UI.compact) UI.toggleSheet('stagePanel');
    else { $('stagePanel').classList.toggle('hidden'); UI.refresh(); }
  });

  /* ---- settings modal ---- */
  on($('btnMenu'), 'click', function(){ UI.setMenu(!UI.menuOpen()); UI.refresh(); });
  on($('btnMenuClose'), 'click', function(){ UI.setMenu(false); UI.refresh(); });
  on($('scrim'), 'click', function(){ UI.setMenu(false); UI.refresh(); });

  /* ---- brush rail collapse ---- */
  on($('btnBrushMin'), 'click', function(){
    var min = document.body.classList.toggle('brushmin');
    this.textContent = min ? '+' : '–';
  });

  /* ---- group actions ---- */
  on($('btnDuplicate'), 'click', function(){ Tools.duplicateSelection(); });
  on($('btnGroupNew'), 'click', function(){
    var g = Tools.newGroup();
    P.toast('New group: ' + g.name);
  });
  on($('btnGroupDup'), 'click', function(){ Tools.duplicateGroup(S.activeGroup); });
  on($('btnGroupDel'), 'click', function(){ Tools.deleteGroup(S.activeGroup); });
  on($('btnHome'), 'click', function(){ P.resetView(); P.toast('View reset'); });

  on($('optFinger'),   'click', function(){ P.Input.fingerPen = !P.Input.fingerPen; UI.refresh(); });
  on($('optAutoGuide'),'click', function(){ TOOL.autoGuide = !TOOL.autoGuide; UI.refresh(); });
  on($('optStable'),   'click', function(){ TOOL.stableOn = !TOOL.stableOn; UI.refresh(); });
  on($('optIsolate'),  'click', function(){ G.isolate = !G.isolate; UI.refresh(); });
  on($('optClamp'),    'click', function(){ G.clampOffSurface = !G.clampOffSurface; UI.refresh(); });
  on($('optHoldShape'),'click', function(){
    TOOL.shapeHold = !TOOL.shapeHold;
    P.toast(TOOL.shapeHold ? 'Hold the pen still to snap a shape' : 'Hold-to-shape off');
    UI.refresh();
  });
  on($('stableAmt'), 'input', function(){
    TOOL.stable = parseFloat(this.value)/100;
    $('stableVal').textContent = this.value;
  });

  on($('focal'), 'input', function(){
    P.VIEW.focal = parseFloat(this.value);
    P.applyCamera(); UI.refreshView();
  });
  on($('btnProj'), 'click', function(){ P.toast(P.toggleProjection()); UI.refreshView(); });
  on($('viewSeg'), 'click', function(e){
    var b = e.target.closest('button[data-view]');
    if(!b) return;
    var v = P.ORTHO_VIEWS[parseInt(b.dataset.view,10)];
    P.animateView({theta:v.theta, phi:v.phi, roll:0});
    P.toast(v.name + ' view');
  });

  on($('btnPNG'), 'click', function(){
    P.renderer.render(P.scene, P.cam());
    P.Export.saveURL(P.renderer.domElement.toDataURL('image/png'),
                     'plume-' + Date.now() + '.png');
  });
  on($('btnClear'), 'click', function(){
    var removed = S.list.slice(), guide = G.active;
    if(!removed.length && !guide) return;
    P.History.run({
      label:'clear', cost: P.History.costOf(removed),
      redo: function(){ S.clear(); G.setActive(null); },
      undo: function(){
        for(var i=0;i<removed.length;i++) S.add(removed[i]);
        G.setActive(guide);
      }
    });
    P.onSceneChange();
  });
  on($('btnHideUI'), 'click', function(){
    document.body.classList.add('hideui');
    P.toast('UI hidden — double-click the canvas to bring it back');
  });
  on(P.elStage, 'dblclick', function(){
    if(document.body.classList.contains('hideui')) document.body.classList.remove('hideui');
  });
  on($('btnWalk'), 'click', function(){ startWalk(0); });

  on($('diagX'), 'click', function(){
    var hid = $('diagBody').classList.toggle('hide');
    this.textContent = hid ? '+' : '–';
  });

  /* ---- brush panel ---- */
  seg($('brushGrid'), 'brush', function(v){
    TOOL.brush = v;
    styleOnce('restyle brush', { brush: v });
  });
  seg($('pressSeg'), 'p',     function(v){ TOOL.pressureTarget = v; });

  on($('size'), 'input', function(){
    var v = parseFloat(this.value);
    if(beginStyleEdit('resize')) applyStyle({ scale: v / sizeAtEditStart() });
    UI.setSize(v);
    UI.refresh();
  });
  on($('size'), 'change', endStyleEdit);
  on($('opacity'), 'input', function(){
    var v = parseFloat(this.value)/100;
    if(beginStyleEdit('restyle opacity')) applyStyle({ opacity: v });
    TOOL.opacity = v;
    UI.refresh();
  });
  on($('opacity'), 'change', endStyleEdit);
  dragValue($('sizeVal'),    'size');
  dragValue($('opacityVal'), 'opacity');
  on($('btnPressure'), 'click', function(){ TOOL.pressureOn = !TOOL.pressureOn; UI.refresh(); });
  on($('colorPick'), 'input', function(){
    TOOL.color.set(this.value); markSwatch(this.value);
    if(beginStyleEdit('recolour')) applyStyle({ color: TOOL.color });
  });
  on($('colorPick'), 'change', endStyleEdit);
  on($('btnEyedrop'), 'click', function(){ P.setTool('eyedrop'); P.toast('Tap a curve to sample its colour'); });
  on($('btnInject'),  'click', function(){ P.setTool('inject');  P.toast('Tap a curve to sample its brush'); });
  on($('btnUndo'), 'click', function(){ P.History.undo(); P.onSceneChange(); });
  on($('btnRedo'), 'click', function(){ P.History.redo(); P.onSceneChange(); });

  buildSwatches();

  /* ---- guide bar ---- */
  on($('guideOpacity'), 'input', function(){
    G.setOpacity(null, parseFloat(this.value)/100);
    $('guideOpacityVal').textContent = this.value + '%';
  });
  on($('btnGuideBend'),  'click', function(){ P.setTool('bend'); P.toast('Orbit, then draw the new sweep path'); });
  on($('btnGuideSave'),  'click', function(){ Tools.saveGuide(); });
  on($('btnGuideClose'), 'click', function(){ Tools.closeGuide(); });

  /* ---- contextual slider ---- */
  on($('ctxRange'), 'input', function(){
    var v = parseFloat(this.value)/100;
    if(TOOL.mode === 'loft'){
      P.loftTension = v;
      $('ctxVal').textContent = v.toFixed(2);
      Tools.loftPreview(v);
    } else if(TOOL.mode === 'prim'){
      UI.primSeg = Math.max(3, Math.round(3 + v*45));
      $('ctxVal').textContent = UI.primSeg;
      Tools.primPreview(UI.primKind, UI.primSeg, UI.primTaper);
    }
  });
  on($('ctxRange2'), 'input', function(){
    UI.primTaper = parseFloat(this.value)/100;
    $('ctxVal2').textContent = UI.primTaper.toFixed(2);
    Tools.primPreview(UI.primKind, UI.primSeg, UI.primTaper);
  });
  seg($('primKinds'), 'prim', function(v){
    UI.primKind = v;
    Tools.primPreview(v, UI.primSeg, UI.primTaper);
    UI.refresh();
  });
  on($('btnCtxDone'), 'click', function(){
    if(TOOL.mode === 'loft'){
      if(!Tools.loftCommit()) P.toast('Select two or more curves first');
      else { P.setTool('draw'); P.toast('Loft guide created'); }
    } else if(TOOL.mode === 'prim'){
      Tools.primCommit(); P.setTool('draw'); P.toast('Primitive guide created');
    }
  });
  on($('btnCtxCancel'), 'click', function(){ Tools.stagedCancel(); P.setTool('draw'); });

  /* ---- stage panel ---- */
  seg($('stageTabs'), 'tab', function(v){
    $('bodyGroup').classList.toggle('hidden', v !== 'group');
    $('bodyRes').classList.toggle('hidden',   v !== 'res');
    $('bodyEnv').classList.toggle('hidden',   v !== 'env');
  });
  on($('btnSelAll'), 'click', function(){
    var all = S.list.filter(S.visible), before = S.selection.slice();
    P.History.run({
      label:'select all',
      redo: function(){ for(var i=0;i<all.length;i++) S.setSelected(all[i], true); },
      undo: function(){
        S.clearSelection();
        for(var i=0;i<before.length;i++) S.setSelected(before[i], true);
      }
    });
    P.onSceneChange();
  });
  on($('btnDelSel'), 'click', function(){
    var sel = S.selection.slice();
    if(!sel.length){ P.toast('Nothing selected'); return; }
    P.History.run({
      label:'delete', cost: P.History.costOf(sel),
      redo: function(){ for(var i=0;i<sel.length;i++) S.remove(sel[i]); },
      undo: function(){ for(var i=0;i<sel.length;i++) S.add(sel[i]); }
    });
    P.onSceneChange();
  });

  /* ---- imported references (C.1) ---- */
  on($('btnImportRef'), 'click', function(){ $('refInput').click(); });
  on($('refInput'), 'change', function(){
    var f = this.files && this.files[0];
    this.value = '';
    if(!f) return;
    P.toast('Loading ' + f.name + '…');
    P.Import.load(f).then(function(guide){
      var prev = G.active;
      P.History.run({
        label: 'import reference',
        redo: function(){ G.setActive(guide); },
        undo: function(){ G.setActive(prev); }
      });
      P.autoPivot(true);
      P.toast(guide.kind === 'image' ? 'Image guide — draw straight onto it'
                                     : 'Model guide — orbit and draw on the surface');
      P.onSceneChange();
    }).catch(function(err){
      P.toast(err.message || 'Could not import that file');
    });
  });

  on($('bgPick'), 'input', function(){ P.ENV.bg.set(this.value); P.applyEnv(); });
  on($('optGrid'),   'click', function(){ P.ENV.grid = !P.ENV.grid; P.applyEnv(); UI.refresh(); });
  on($('optAxis'),   'click', function(){ P.ENV.axis = !P.ENV.axis; P.applyEnv(); UI.refresh(); });
  on($('optFog'),    'click', function(){ P.ENV.fog  = !P.ENV.fog;  P.applyEnv(); UI.refresh(); });
  on($('optRender'), 'click', function(){
    P.ENV.render = !P.ENV.render; P.invalidateGroundShadow(); UI.refresh();
    P.toast(P.ENV.render ? 'Render mode — shadows and effects are live'
                         : 'Draw mode — fast shading');
  });
  on($('optShadow'), 'click', function(){
    P.ENV.groundShadow = !P.ENV.groundShadow; P.invalidateGroundShadow(); UI.refresh();
  });
  on($('optToon'),   'click', function(){
    P.LIGHT.toon = !P.LIGHT.toon; P.applyLight(); UI.refresh();
  });
  on($('lightPick'), 'input', function(){
    P.LIGHT.color.set(this.value); P.applyLight(); UI.refresh();
  });
  dragValue($('lightIntVal'), 'lightInt');
  dragValue($('lightAmbVal'), 'lightAmb');
  bindLightPad($('lightPad'));
  on($('optShaded'), 'click', function(){
    P.ENV.shaded = !P.ENV.shaded; S.setShaded(P.ENV.shaded); UI.refresh();
  });

  /* ---- compact dock ---- */
  on($('dockUndo'),  'click', function(){ P.History.undo(); P.onSceneChange(); });
  on($('dockRedo'),  'click', function(){ P.History.redo(); P.onSceneChange(); });
  on($('dockTools'), 'click', function(){ UI.toggleSheet('tools'); });
  on($('dockBrush'), 'click', function(){ UI.toggleSheet('brush'); });
  on($('dockJoy'),   'click', function(){ UI.toggleSheet('joy'); });
  on($('dockStage'), 'click', function(){ UI.toggleSheet('stagePanel'); });

  /* picking a tool on a phone should get out of the way again */
  on($('tools'), 'click', function(e){
    if(UI.compact && e.target.closest('button[data-tool]')) UI.closeTopSheet();
  });

  /* ---- file ---- */
  on($('btnNew'), 'click', function(){
    if(P.Strokes.list.length || P.Guides.active){
      if(!confirm('Start a new sketch? The current one is autosaved but will be replaced.')) return;
    }
    P.Doc.clear();
    P.resetView();
    P.Doc.saveNow().catch(function(){});
    P.toast('New sketch');
  });
  on($('btnSaveNow'), 'click', function(){
    P.Doc.saveNow().then(function(){ P.toast('Saved to this device'); })
                   .catch(function(){ P.toast('Could not save'); });
  });
  on($('btnExport'), 'click', function(){
    P.Doc.download();
    P.toast('Exported .plume.json');
  });

  /* Geometry out. With something selected this exports just that, which is
     the same rule the rest of the app follows for a live selection. */
  function exportGeometry(format, label){
    var selOnly = P.Strokes.selection.length > 0;
    var st;
    try { st = P.Export.download(format, {selectionOnly:selOnly}); }
    catch(err){ P.toast('Could not write that file'); return; }
    if(!st){
      P.toast(selOnly ? 'Nothing in the selection to export' : 'Nothing to export yet');
      return;
    }
    P.toast('Exported ' + st.parts + (st.parts === 1 ? ' curve' : ' curves') +
            ' as ' + label + ' — ' + st.triangles.toLocaleString() + ' triangles');
  }
  on($('btnOBJ'), 'click', function(){ exportGeometry('obj', '.obj + .mtl'); });
  on($('btnSTL'), 'click', function(){ exportGeometry('stl', '.stl'); });
  on($('btnImport'), 'click', function(){ $('fileInput').click(); });
  on($('fileInput'), 'change', function(){
    var f = this.files && this.files[0];
    if(!f) return;
    P.Doc.importFile(f)
      .then(function(){ P.toast('Sketch loaded'); })
      .catch(function(err){ P.toast(err.message || 'Could not open that file'); });
    this.value = '';
  });

  /* ---- selection action bar ---- */
  on($('btnSelDup'),    'click', function(){ Tools.duplicateSelection(); });
  on($('btnSelDupMir'), 'click', function(){ Tools.duplicateMirrored(); });
  on($('btnSelDelete'), 'click', function(){ $('btnDelSel').click(); });
  on($('btnSelLiquify'), 'click', function(){
    if(!Tools.liquifyTargets().length){ P.toast('Select the curves to liquify first'); return; }
    P.setTool('liquify');
    P.toast('Liquify — press and drag over the selection');
  });

  /* ---- liquify panel ---- */
  seg($('lqModes'), 'lq', function(v){ TOOL.liquify.mode = v; UI.refresh(); });
  dragValue($('lqSizeVal'),     'lqSize');
  dragValue($('lqRangeVal'),    'lqRange');
  dragValue($('lqStrengthVal'), 'lqStrength');
  on($('btnLqApply'), 'click', function(){ Tools.liquifyApply(); });
  on($('btnLqClose'), 'click', function(){ P.setTool('select'); UI.refresh(); });

  /* ---- rail collapse tab ---- */
  on($('railTab'), 'click', function(){
    var hidden = document.body.classList.toggle('railhidden');
    this.setAttribute('data-tip', hidden ? 'Show the brush rail' : 'Hide the brush rail');
  });

  /* ---- top-left shortcuts ---- */
  on($('btnExportTop'), 'click', function(){ UI.setMenu(true); UI.refresh(); });
  on($('btnWalkTop'),   'click', function(){ startWalk(0); });

  /* ---- brush type popover ---- */
  on($('brushType'), 'click', function(){
    closePopovers('brushGrid');
    $('brushGrid').classList.toggle('hidden');
    UI.refresh();
  });

  /* ---- size / opacity popover, and the keypad ---- */
  on($('btnSize'), 'click', function(){
    closePopovers('slidePop');
    anchorTo($('slidePop'), this);
    $('slidePop').classList.toggle('hidden');
    UI.refresh();
  });
  on($('btnOpacity'), 'click', function(){
    closePopovers('slidePop');
    anchorTo($('slidePop'), this);
    $('slidePop').classList.toggle('hidden');
    UI.refresh();
  });
  /* tapping a readout types an exact value; dragging it is the slider —
     both are wired in dragValue() above */

  initKeypad();
  initColorWheel();
  initJoystick();

  P.History.listeners.push(function(){ UI.refresh(); });
  window.addEventListener('resize', UI.applyMode);

  UI.applyMode();
  if(!localStorage.getItem('plume.walk.done')) startWalk(0);
  UI.refresh();
  UI.refreshView();
};

/* autosave indicator */
P.onSaveState = function(state){
  var dot = $('saveDot'), info = $('saveInfo');
  if(!dot) return;
  dot.classList.toggle('dirty', state === 'dirty');
  dot.classList.toggle('error', state === 'error');
  if(!info) return;
  if(state === 'saved'){
    info.textContent = 'Saved to this device ' + new Date().toLocaleTimeString() + '.';
  } else if(state === 'error'){
    info.textContent = 'Autosave failed — export the file to be safe.';
  } else {
    info.textContent = 'Unsaved changes…';
  }
};

/* ==========================================================================
   Popover plumbing — anchoring, and one-at-a-time behaviour
   ========================================================================== */
var POPOVERS = ['brushGrid','slidePop','keypad','colorCard'];

function closePopovers(except){
  for(var i=0;i<POPOVERS.length;i++){
    if(POPOVERS[i] !== except) $(POPOVERS[i]).classList.add('hidden');
  }
}
UI.closePopovers = closePopovers;
function anyPopoverOpen(){
  for(var i=0;i<POPOVERS.length;i++){
    if(!$(POPOVERS[i]).classList.contains('hidden')) return POPOVERS[i];
  }
  return null;
}

/* park a floating card beside the control that opened it, kept on screen */
function anchorTo(card, btn){
  var r = btn.getBoundingClientRect();
  card.classList.remove('hidden');
  var w = card.offsetWidth, h = card.offsetHeight;
  card.classList.add('hidden');
  var vw = document.documentElement.clientWidth;
  var vh = document.documentElement.clientHeight;
  card.style.left = P.clamp(r.right + 10, 8, Math.max(8, vw - w - 8)) + 'px';
  card.style.top  = P.clamp(r.top + r.height/2 - h/2, 8, Math.max(8, vh - h - 8)) + 'px';
  card.style.right = 'auto';
  card.style.bottom = 'auto';
  card.style.transform = 'none';
}

/* a tap anywhere else dismisses them */
document.addEventListener('pointerdown', function(e){
  if(!anyPopoverOpen()) return;
  if(e.target.closest && (e.target.closest('#brushGrid') || e.target.closest('#slidePop') ||
     e.target.closest('#keypad') || e.target.closest('#colorCard') ||
     e.target.closest('#brushType') || e.target.closest('#brushColor') ||
     e.target.closest('#btnSize') || e.target.closest('#btnOpacity') ||
     e.target.closest('#sizeVal') || e.target.closest('#opacityVal'))) return;
  closePopovers();
  UI.refresh();
}, true);

/* ==========================================================================
   Numeric keypad — type an exact value, as the reference does for size in mm
   ========================================================================== */
var keypadFor = null, keypadBuf = '';

function openKeypad(which){
  keypadFor = which;
  keypadBuf = '';
  closePopovers('keypad');
  $('keypadLabel').textContent = which === 'size' ? 'Size' : 'Opacity';
  $('keypadUnit').textContent  = which === 'size' ? 'mm' : '%';
  anchorTo($('keypad'), which === 'size' ? $('btnSize') : $('btnOpacity'));
  $('keypad').classList.remove('hidden');
  drawKeypad();
  UI.refresh();
}

/* ==========================================================================
   Size and opacity — drag the readout
   --------------------------------------------------------------------------
   FACT (brush panel docs): brush size "can be adjusted by sliding up or down",
   and so can opacity; size runs 1mm-300mm and opacity 0-100%. So the readouts
   are the slider — drag up for more, down for less — and a tap still opens the
   keypad for an exact number. The popover sliders stay for mouse users.

   Size moves geometrically rather than linearly: a millimetre matters at 2mm
   and is invisible at 200mm, and a 300:1 range on a linear drag would make the
   bottom of it unusable. Opacity is linear because 0-100% is already uniform.
   ========================================================================== */
var SIZE_PER_PX = 0.011, OPACITY_PER_PX = 0.004, DRAG_SLOP = 3;

/* Liquify's three numbers are dragged the same way — FACT: size, range and
   strength are each "adjusted by sliding up or down". Size is a screen radius
   so it moves geometrically like the brush; the other two are percentages and
   move linearly. */
var LQ = {
  lqSize:     { get:function(){ return TOOL.liquify.size; },
                set:function(v){ TOOL.liquify.size = Math.round(P.clamp(v, 8, 600)); },
                log:true },
  lqRange:    { get:function(){ return TOOL.liquify.range; },
                set:function(v){ TOOL.liquify.range = Math.round(P.clamp(v, 0, 100)); } },
  lqStrength: { get:function(){ return TOOL.liquify.strength; },
                set:function(v){ TOOL.liquify.strength = Math.round(P.clamp(v, 1, 100)); } },
  /* the light's two numbers ride the same drag-a-readout mechanism the
     liquify ones do, so there is one way to nudge a number in this app */
  lightInt:   { get:function(){ return P.LIGHT.intensity*100; },
                set:function(v){ P.LIGHT.intensity = P.clamp(v/100, 0, 3); P.applyLight(); } },
  lightAmb:   { get:function(){ return P.LIGHT.ambient*100; },
                set:function(v){ P.LIGHT.ambient = P.clamp(v/100, 0, 1); P.applyLight(); } }
};

/* THE LIGHT PAD. Sideways turns the key light around the sketch, up and down
   raises it from the horizon to overhead - the two things Feather's lighting
   icon slides between, given a surface big enough to aim with a thumb. The dot
   is where the light IS, so dragging it left moves the light left. */
function bindLightPad(el){
  if(!el) return;
  var drag = null;
  function place(e){
    var r = el.getBoundingClientRect();
    var fx = P.clamp((e.clientX - r.left) / r.width,  0, 1);
    var fy = P.clamp((e.clientY - r.top)  / r.height, 0, 1);
    P.LIGHT.az  = (fx - 0.5) * Math.PI * 2;
    P.LIGHT.alt = (1 - fy) * (Math.PI/2);        // horizon at the bottom
    P.applyLight();
    UI.refresh();
  }
  on(el, 'pointerdown', function(e){
    drag = true; place(e);
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
    e.preventDefault();
  });
  on(el, 'pointermove', function(e){ if(drag) place(e); });
  function stop(e){
    if(!drag) return;
    drag = null;
    try{ el.releasePointerCapture(e.pointerId); }catch(err){}
  }
  on(el, 'pointerup', stop);
  on(el, 'pointercancel', stop);
}

function placeLightDot(){
  var dot = $('lightDot'), pad = $('lightPad');
  if(!dot || !pad) return;
  var fx = P.LIGHT.az / (Math.PI*2) + 0.5;
  var fy = 1 - P.LIGHT.alt / (Math.PI/2);
  dot.style.left = (P.clamp(fx,0,1)*100) + '%';
  dot.style.top  = (P.clamp(fy,0,1)*100) + '%';
}

/* ==========================================================================
   The brush panel, pointed at a selection
   --------------------------------------------------------------------------
   With curves selected the panel edits them as well as the tool: the tool
   still takes the new value, so the next stroke matches what you just set, and
   the selection takes it too.

   A slider drag is ONE history entry, not one per frame. The snapshot is taken
   when the gesture starts and the entry pushed when it ends; every frame in
   between scales from that same snapshot, so dragging back and forth cannot
   compound. A discrete change - a swatch, a brush, a typed number - opens and
   closes the gesture in one go.
   ========================================================================== */
var styleEdit = null;

function styleTargets(){
  return P.Strokes.selection.length ? P.Strokes.selection.slice() : null;
}

function beginStyleEdit(label){
  if(styleEdit) return styleEdit;
  var st = styleTargets();
  if(!st) return null;
  /* the slider's reading BEFORE this gesture moved it, which is what a
     proportional resize is measured against */
  styleEdit = { strokes: st, before: P.Strokes.styleSnapshot(st),
                label: label, sizeFrom: UI.getSize() };
  return styleEdit;
}
function sizeAtEditStart(){
  return (styleEdit && styleEdit.sizeFrom > 0) ? styleEdit.sizeFrom : UI.getSize();
}

function applyStyle(changes){
  if(!styleEdit) return false;
  P.Strokes.restyle(styleEdit.strokes, changes, styleEdit.before);
  return true;
}

function endStyleEdit(){
  var e = styleEdit;
  styleEdit = null;
  if(!e) return;
  var after = P.Strokes.styleSnapshot(e.strokes);
  var moved = false;
  for(var i=0;i<after.length;i++){
    var a = after[i], b = e.before[i];
    if(a.brush !== b.brush || a.opacity !== b.opacity ||
       a.baseRadius !== b.baseRadius || a.color.getHex() !== b.color.getHex()){
      moved = true; break;
    }
  }
  if(!moved) return;
  P.History.push({
    label: e.label,
    redo: function(){ P.Strokes.styleRestore(e.strokes, after); },
    undo: function(){ P.Strokes.styleRestore(e.strokes, e.before); }
  });
  P.onSceneChange();
}
UI.endStyleEdit = endStyleEdit;

/* Every one of these edits is a GESTURE, and a gesture ends when the finger
   comes up - on the wheel, on a swatch, on a slider, anywhere. Listening once
   here beats threading an end through every control, and it is a no-op when no
   edit is open. */
document.addEventListener('pointerup', endStyleEdit, true);
document.addEventListener('pointercancel', endStyleEdit, true);

/* one-shot: for controls that change by a tap rather than a drag */
/* SELECTING LOADS THE PANEL. Otherwise the panel would have two truths at
   once - the tool's number and the selection's - and dragging the size to 80mm
   while the readout showed the selection's average of 63mm would be nonsense.
   Adopting on selection means the panel always shows the tool, the tool always
   shows what you last picked, and a proportional resize starts from where the
   selection actually is. Properties the selection does not agree on are left
   alone rather than flattened to the first stroke's. */
var lastSelSig = null;
function adoptSelectionStyle(){
  var sel = P.Strokes.selection;
  var sig = sel.length ? sel.map(function(x){ return x.id; }).join(',') : '';
  if(sig === lastSelSig) return;
  lastSelSig = sig;
  if(!sel.length) return;
  var st = P.Strokes.styleOf(sel);
  if(!st) return;
  if(st.brush)            TOOL.brush = st.brush;
  if(st.hex !== null)     TOOL.color.setHex(st.hex);
  if(st.opacity !== null) TOOL.opacity = st.opacity;
  if(st.sizeMM > 0)       UI.setSize(st.sizeMM);
}
UI.adoptSelectionStyle = adoptSelectionStyle;

function styleOnce(label, changes){
  if(!beginStyleEdit(label)) return;
  applyStyle(changes);
  endStyleEdit();
}
UI.styleOnce = styleOnce;

/* The size control edits whichever tool is in hand — the eraser carries its
   own size, so switching to it re-points the readout rather than resizing the
   brush underneath you. */
UI.sizeKey  = function(){ return P.Tools.sizeTarget(); };
UI.getSize  = function(){ return TOOL[UI.sizeKey()]; };
UI.setSize  = function(v){
  TOOL[UI.sizeKey()] = P.clamp(v, P.TUNE.brushMinMM, P.TUNE.brushMaxMM);
};

function dragValue(el, which){
  if(!el) return;
  var drag = null, ate = false, ateAt = 0;
  el.classList.add('dragv');

  /* No preventDefault on pointerdown: the tap has to survive as a click so a
     still finger still opens the keypad. touch-action:none on .dragv is what
     stops a touch drag from scrolling the panel instead. */
  on(el, 'pointerdown', function(e){
    drag = { y:e.clientY, moved:false,
             from: LQ[which] ? LQ[which].get()
                 : which === 'size' ? UI.getSize() : TOOL.opacity };
    try { el.setPointerCapture(e.pointerId); } catch(err){}
  });
  on(el, 'pointermove', function(e){
    if(!drag) return;
    var dy = drag.y - e.clientY;                       // up is more
    if(!drag.moved && Math.abs(dy) < DRAG_SLOP) return;
    drag.moved = true;
    if(LQ[which]){
      var spec = LQ[which];
      spec.set(spec.log ? drag.from * Math.exp(dy * SIZE_PER_PX)
                        : drag.from + dy * 0.4);
    }
    else if(which === 'size'){
      var nv = drag.from * Math.exp(dy * SIZE_PER_PX);
      if(beginStyleEdit('resize')) applyStyle({ scale: nv / sizeAtEditStart() });
      UI.setSize(nv);
    }
    else {
      var no = P.clamp(drag.from + dy * OPACITY_PER_PX, 0.05, 1);
      if(beginStyleEdit('restyle opacity')) applyStyle({ opacity: no });
      TOOL.opacity = no;
    }
    UI.refresh();
  });
  function end(e){
    if(!drag) return;
    /* A drag is not a tap. Swallow exactly the ONE click this gesture is about
       to generate rather than everything for the next few hundred ms — a time
       window also eats the deliberate tap that follows a quick adjustment. */
    if(drag.moved){ ate = true; ateAt = performance.now(); }
    drag = null;
    try { el.releasePointerCapture(e.pointerId); } catch(err){}
  }
  on(el, 'pointerup', end);
  on(el, 'pointercancel', end);
  on(el, 'click', function(){
    var swallow = ate && (performance.now() - ateAt) < 700;
    ate = false;                       // and never hold it against a later tap
    if(swallow || LQ[which]) return;   // liquify's numbers are drag-only
    openKeypad(which);
  });
}

function keypadCurrent(){
  return keypadFor === 'size' ? Math.round(UI.getSize())
                              : Math.round(TOOL.opacity*100);
}
function drawKeypad(){
  $('keypadVal').textContent = keypadBuf === '' ? keypadCurrent() : keypadBuf;
}

function commitKeypad(){
  var v = parseFloat(keypadBuf);
  if(!isNaN(v)){
    if(keypadFor === 'size'){
      var was = UI.getSize();
      UI.setSize(v);
      if(was > 0) styleOnce('resize', { scale: UI.getSize() / was });
    } else {
      TOOL.opacity = P.clamp(v/100, 0.05, 1);
      styleOnce('restyle opacity', { opacity: TOOL.opacity });
    }
  }
  $('keypad').classList.add('hidden');
  keypadFor = null; keypadBuf = '';
  UI.refresh();
}

function initKeypad(){
  on($('keypad'), 'click', function(e){
    var b = e.target.closest('button');
    if(!b) return;
    var k = b.dataset.key;
    if(k === 'ok'){ commitKeypad(); return; }
    if(k === 'back'){ keypadBuf = keypadBuf.slice(0, -1); drawKeypad(); return; }
    if(keypadBuf.length < 4) keypadBuf += k;
    drawKeypad();
  });
}

/* ==========================================================================
   Colour wheel — hue ring plus a saturation/value square, with a hex field.
   Replaces the native colour input, which cannot be styled to match.
   ========================================================================== */
var hsv = {h:220, s:0.1, v:0.13};

function initColorWheel(){
  var wheel = $('hueWheel'), ctx = wheel.getContext('2d');
  var R = 100, inner = 62;
  var img = ctx.createImageData(200, 200);
  for(var y=0;y<200;y++){
    for(var x=0;x<200;x++){
      var dx = x-R, dy = y-R, d = Math.sqrt(dx*dx+dy*dy);
      var o = (y*200+x)*4;
      if(d > R || d < inner){ img.data[o+3] = 0; continue; }
      var hh = (Math.atan2(dy, dx)*180/Math.PI + 360) % 360;
      var rgb = hsvToRgb(hh, 1, 1);
      img.data[o] = rgb[0]; img.data[o+1] = rgb[1]; img.data[o+2] = rgb[2];
      /* feather the two edges so the ring is not aliased */
      var edge = Math.min(R - d, d - inner);
      img.data[o+3] = 255 * P.clamp(edge, 0, 1);
    }
  }
  ctx.putImageData(img, 0, 0);

  bindWheelDrag(wheel, function(x, y){
    hsv.h = (Math.atan2(y-R, x-R)*180/Math.PI + 360) % 360;
    pushColor();
  });
  bindWheelDrag($('svCanvas'), function(x, y){
    hsv.s = P.clamp(x/104, 0, 1);
    hsv.v = P.clamp(1 - y/104, 0, 1);
    pushColor();
  });

  on($('hexIn'), 'change', function(){
    var v = this.value.replace(/[^0-9a-fA-F]/g, '');
    if(v.length === 3) v = v[0]+v[0]+v[1]+v[1]+v[2]+v[2];
    if(v.length !== 6) return;
    TOOL.color.set('#' + v);
    setHSVFromColor();
    paintSV(); placeKnobs();
    UI.refresh();
  });
  on($('btnHexPick'), 'click', function(){
    closePopovers();
    P.setTool('eyedrop');
    P.toast('Tap a curve to sample its colour');
  });

  on($('brushColor'), 'click', function(){
    closePopovers('colorCard');
    setHSVFromColor();
    anchorTo($('colorCard'), this);
    $('colorCard').classList.toggle('hidden');
    paintSV(); placeKnobs();
    UI.refresh();
  });

  setHSVFromColor(); paintSV(); placeKnobs();
}

function bindWheelDrag(el, fn){
  var down = false;
  function at(e){
    var r = el.getBoundingClientRect();
    fn((e.clientX - r.left) * (el.width / r.width),
       (e.clientY - r.top)  * (el.height / r.height));
  }
  on(el, 'pointerdown', function(e){
    down = true; el.setPointerCapture(e.pointerId); at(e); e.preventDefault();
  });
  on(el, 'pointermove', function(e){ if(down) at(e); });
  on(el, 'pointerup',   function(){ down = false; });
  on(el, 'pointercancel', function(){ down = false; });
}

function paintSV(){
  var c = $('svCanvas'), ctx = c.getContext('2d');
  var base = hsvToRgb(hsv.h, 1, 1);
  ctx.fillStyle = 'rgb(' + base[0] + ',' + base[1] + ',' + base[2] + ')';
  ctx.fillRect(0, 0, 104, 104);
  var g1 = ctx.createLinearGradient(0, 0, 104, 0);
  g1.addColorStop(0, 'rgba(255,255,255,1)');
  g1.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g1; ctx.fillRect(0, 0, 104, 104);
  var g2 = ctx.createLinearGradient(0, 0, 0, 104);
  g2.addColorStop(0, 'rgba(0,0,0,0)');
  g2.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g2; ctx.fillRect(0, 0, 104, 104);
}

function placeKnobs(){
  var R = 100, ring = 81;
  var a = hsv.h * Math.PI/180;
  var hk = $('hueKnob');
  hk.style.left = (R + Math.cos(a)*ring) + 'px';
  hk.style.top  = (R + Math.sin(a)*ring) + 'px';
  hk.style.background = '#' + TOOL.color.getHexString();
  var sk = $('svKnob');
  sk.style.left = (48 + hsv.s*104) + 'px';
  sk.style.top  = (48 + (1-hsv.v)*104) + 'px';
  sk.style.background = '#' + TOOL.color.getHexString();
}

function pushColor(){
  var rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
  TOOL.color.setRGB(rgb[0]/255, rgb[1]/255, rgb[2]/255);
  if(beginStyleEdit('recolour')) applyStyle({ color: TOOL.color });
  paintSV(); placeKnobs();
  UI.refresh();
}

function setHSVFromColor(){
  var r = TOOL.color.r, g = TOOL.color.g, b = TOOL.color.b;
  var mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx-mn;
  var h = 0;
  if(d > 1e-6){
    if(mx === r) h = 60*(((g-b)/d) % 6);
    else if(mx === g) h = 60*((b-r)/d + 2);
    else h = 60*((r-g)/d + 4);
  }
  hsv.h = (h + 360) % 360;
  hsv.s = mx < 1e-6 ? 0 : d/mx;
  hsv.v = mx;
}

function hsvToRgb(h, s, v){
  var c = v*s, x = c*(1 - Math.abs(((h/60) % 2) - 1)), m = v - c, r, g, b;
  if(h < 60)       { r=c; g=x; b=0; }
  else if(h < 120) { r=x; g=c; b=0; }
  else if(h < 180) { r=0; g=c; b=x; }
  else if(h < 240) { r=0; g=x; b=c; }
  else if(h < 300) { r=x; g=0; b=c; }
  else             { r=c; g=0; b=x; }
  return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
}

/* ==========================================================================
   Swatches
   ========================================================================== */
function buildSwatches(){
  var host = $('swatches');
  host.innerHTML = '';
  for(var i=0;i<PALETTE.length;i++){
    var b = document.createElement('button');
    b.className = 'sw' + (i===0 ? ' on' : '');
    b.style.background = PALETTE[i];
    b.dataset.col = PALETTE[i];
    host.appendChild(b);
  }
  on(host, 'click', function(e){
    var b = e.target.closest('.sw');
    if(!b) return;
    TOOL.color.set(b.dataset.col);
    $('colorPick').value = b.dataset.col;
    markSwatch(b.dataset.col);
    styleOnce('recolour', { color: TOOL.color });
  });
}
function markSwatch(hex){
  var all = $('swatches').querySelectorAll('.sw');
  for(var i=0;i<all.length;i++){
    all[i].classList.toggle('on', all[i].dataset.col.toLowerCase() === String(hex).toLowerCase());
  }
}

/* ==========================================================================
   Joystick  (D.1) — drives the current selection, or a selected guide
   --------------------------------------------------------------------------
   The pad works in the view plane and the strip on the depth axis, so the
   widget always means what the screen shows regardless of the orbit.
   ========================================================================== */
/* ==========================================================================
   The three coloured arcs are the world axes. They sit at FIXED, equally
   spaced positions on the ring - Y up, X to the lower right, Z to the lower
   left - and stay there however the camera orbits. Earlier they were drawn
   where each axis happened to project to on screen, which meant the handle you
   were reaching for slid out from under your thumb every time you moved the
   view, and two axes could crowd into the same place while the third had a
   third of the ring to itself.

   Only the PLACEMENT is fixed. Dragging still uses each axis's real screen
   direction and its real pixels-per-unit, so pulling the X arc moves along
   world X by the distance the drag actually covers, and an axis pointing at
   the camera still dims, because there is no sensible direction to drag it in.
   ========================================================================== */
var AXES = [
  {key:'x', vec:new THREE.Vector3(1,0,0), arc:'arcX', lab:'labX'},
  {key:'y', vec:new THREE.Vector3(0,1,0), arc:'arcY', lab:'labY'},
  {key:'z', vec:new THREE.Vector3(0,0,1), arc:'arcZ', lab:'labZ'}
];
var PAD_C = 54, PAD_R = 43, PAD_INNER = 19;   // in the pad's 108-unit viewBox

/* where each arc lives, a third of the ring apart. SVG angles run clockwise
   from east, so -90 degrees is straight up. */
var AXIS_ANG = [Math.PI/6, -Math.PI/2, Math.PI*5/6];   // x, y, z

/* Where does this world axis point on screen, and how many pixels is one world
   unit along it? Returns null when the axis is nearly end-on, where the
   direction is meaningless and the arc should be dimmed. */
function axisScreen(axis){
  var c = Tools.transformCentre() || P.VIEW.pivot;
  var a = P.worldToScreen(c, {});
  var b = P.worldToScreen(c.clone().addScaledVector(axis.vec, 1), {});
  var dx = b.x - a.x, dy = b.y - a.y;
  var len = Math.hypot(dx, dy);
  if(len < 4) return null;                    // pointing at (or away from) us
  return {ang: Math.atan2(dy, dx), pxPerUnit: len, ux: dx/len, uy: dy/len};
}

function arcPath(cx, cy, r, a0, a1){
  var x0 = cx + Math.cos(a0)*r, y0 = cy + Math.sin(a0)*r;
  var x1 = cx + Math.cos(a1)*r, y1 = cy + Math.sin(a1)*r;
  var large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return 'M' + x0.toFixed(2) + ' ' + y0.toFixed(2) +
         ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1.toFixed(2) + ' ' + y1.toFixed(2);
}

var axisInfo = [null, null, null];

UI.layoutJoystick = function(){
  if($('joy').classList.contains('hidden')) return;
  var SPAN = 0.62;                            // ~35 degrees either side
  for(var i=0;i<AXES.length;i++){
    var A = AXES[i], info = axisScreen(A);
    axisInfo[i] = info;
    var arc = $(A.arc), lab = $(A.lab);
    if(!arc) continue;
    if(!info){
      arc.setAttribute('d', '');
      arc.classList.add('dim');
      lab.setAttribute('opacity', '0');
      continue;
    }
    var at = AXIS_ANG[i];
    arc.classList.remove('dim');
    arc.setAttribute('d', arcPath(PAD_C, PAD_C, PAD_R, at - SPAN, at + SPAN));
    lab.setAttribute('opacity', '0.9');
    lab.setAttribute('x', (PAD_C + Math.cos(at)*(PAD_R - 13)).toFixed(1));
    lab.setAttribute('y', (PAD_C + Math.sin(at)*(PAD_R - 13)).toFixed(1));
  }
};

/* which axis did this press land on? null means the free centre */
function pickAxis(localX, localY){
  var dx = localX - PAD_C, dy = localY - PAD_C;
  var r = Math.hypot(dx, dy);
  if(r < PAD_INNER) return null;
  var ang = Math.atan2(dy, dx), best = null, bestD = 1.0;   // ~57 degrees
  for(var i=0;i<AXES.length;i++){
    if(!axisInfo[i]) continue;                 // end-on: nothing to drag along
    var d = Math.abs(((ang - AXIS_ANG[i] + Math.PI*3) % (Math.PI*2)) - Math.PI);
    if(d < bestD){ bestD = d; best = i; }
  }
  return best;
}

/* scale along one world axis, about a point */
function axisScaleMatrix(C, A, k){
  var m = new THREE.Matrix4(), e = m.elements, f = k - 1;
  var xx=A.x*A.x, yy=A.y*A.y, zz=A.z*A.z, xy=A.x*A.y, xz=A.x*A.z, yz=A.y*A.z;
  e[0]=1+f*xx; e[4]=f*xy;   e[8]=f*xz;    e[12]=0;
  e[1]=f*xy;   e[5]=1+f*yy; e[9]=f*yz;    e[13]=0;
  e[2]=f*xz;   e[6]=f*yz;   e[10]=1+f*zz; e[14]=0;
  e[3]=0;      e[7]=0;      e[11]=0;      e[15]=1;
  return about(C, m);
}

function initJoystick(){
  seg($('joyMode'), 'joy', function(){ /* mode read live from the DOM */ });
  bindPad($('joyPad'));
  bindDrag($('joyStrip'), true);
  bindJoyGrip();
  UI.layoutJoystick();
}

/* ---- drag the panel itself ---- */
function bindJoyGrip(){
  var grip = $('joyGrip'), panel = $('joy');
  var from = null, lastTap = 0, movedThisPress = false;
  on(grip, 'pointerdown', function(e){
    if(UI.compact) return;                    // it is a bottom sheet there
    e.preventDefault();
    var now = performance.now();
    /* Only a genuine tap-tap parks the panel. Without the `lastTap` guard
       being cleared by a drag, grabbing again straight after moving it would
       be read as a double-tap and snap it back — which is maddening. */
    if(now - lastTap < 300){
      panel.classList.remove('placed');
      panel.style.left = panel.style.top = '';
      lastTap = 0;
      return;
    }
    lastTap = now;
    movedThisPress = false;
    var r = panel.getBoundingClientRect();
    from = {dx: e.clientX - r.left, dy: e.clientY - r.top};
    panel.classList.add('placed');
    panel.style.left = r.left + 'px';
    panel.style.top  = r.top + 'px';
    panel.style.right = 'auto';
    try{ grip.setPointerCapture(e.pointerId); }catch(err){}
  });
  on(grip, 'pointermove', function(e){
    if(!from) return;
    movedThisPress = true;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var w = panel.offsetWidth, h = panel.offsetHeight;
    panel.style.left = P.clamp(e.clientX - from.dx, 4, Math.max(4, vw - w - 4)) + 'px';
    panel.style.top  = P.clamp(e.clientY - from.dy, 4, Math.max(4, vh - h - 4)) + 'px';
  });
  function end(){
    /* a press that dragged is not half of a double-tap */
    if(movedThisPress) lastTap = 0;
    from = null;
  }
  on(grip, 'pointerup', end);
  on(grip, 'pointercancel', end);
}

/* ---- the pad: free in the middle, axis-locked on an arc ---- */
function bindPad(el){
  var last = null, axis = null, startAng = 0;
  function local(e){
    var r = el.getBoundingClientRect();
    return {x:(e.clientX - r.left) * (108 / r.width),
            y:(e.clientY - r.top)  * (108 / r.height)};
  }
  on(el, 'pointerdown', function(e){
    e.preventDefault();
    if(!Tools.beginTransform()){ P.toast('Select a curve or the guide first'); return; }
    var p = local(e);
    axis = pickAxis(p.x, p.y);
    last = {x:e.clientX, y:e.clientY};
    startAng = Math.atan2(p.y - PAD_C, p.x - PAD_C);
    if(axis !== null){
      $(AXES[axis].arc).classList.add('hot');
      $('joyTarget').textContent = joyMode() + ' along ' + AXES[axis].key.toUpperCase();
    }
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
  });
  on(el, 'pointermove', function(e){
    if(!last) return;
    var gx = e.clientX - last.x, gy = e.clientY - last.y;
    last = {x:e.clientX, y:e.clientY};
    var m = (axis === null) ? deltaMatrix(joyMode(), gx, gy, false)
                            : axisDelta(axis, gx, gy, local(e));
    if(m) Tools.stepTransform(m);
  });
  function end(e){
    if(!last) return;
    last = null;
    if(axis !== null) $(AXES[axis].arc).classList.remove('hot');
    axis = null;
    try{ el.releasePointerCapture(e.pointerId); }catch(err){}
    Tools.endTransform();
    UI.refresh();
  }
  on(el, 'pointerup', end);
  on(el, 'pointercancel', end);

  /* the pad state depends on the pointer position for rotation */
  function axisDelta(i, gx, gy, p){
    var C = Tools.transformCentre();
    var info = axisInfo[i];
    if(!C || !info) return null;
    var A = AXES[i].vec;
    var mode = joyMode();

    if(mode === 'move'){
      /* how far the drag went ALONG the axis's screen direction, converted
         back into world units by that axis's own pixels-per-unit */
      var along = (gx*info.ux + gy*info.uy) / info.pxPerUnit;
      var v = A.clone().multiplyScalar(along);
      return new THREE.Matrix4().makeTranslation(v.x, v.y, v.z);
    }
    if(mode === 'rotate'){
      /* sweep around the pad centre turns the object about that axis */
      var ang = Math.atan2(p.y - PAD_C, p.x - PAD_C);
      var d = ang - startAng;
      while(d >  Math.PI) d -= Math.PI*2;
      while(d < -Math.PI) d += Math.PI*2;
      startAng = ang;
      var q = new THREE.Quaternion().setFromAxisAngle(A, d);
      return about(C, new THREE.Matrix4().makeRotationFromQuaternion(q));
    }
    var k = Math.exp((gx*info.ux + gy*info.uy) * 0.006);
    return axisScaleMatrix(C, A, k);
  }
}

function joyMode(){
  var b = $('joyMode').querySelector('button.on');
  return b ? b.dataset.joy : 'move';
}

function bindDrag(el, isStrip){
  var last = null;
  on(el, 'pointerdown', function(e){
    e.preventDefault();
    if(!Tools.beginTransform()){ P.toast('Select a curve or the guide first'); return; }
    last = {x:e.clientX, y:e.clientY};
    try{ el.setPointerCapture(e.pointerId); }catch(err){}
  });
  on(el, 'pointermove', function(e){
    if(!last) return;
    var dx = e.clientX - last.x, dy = e.clientY - last.y;
    last = {x:e.clientX, y:e.clientY};
    var m = deltaMatrix(joyMode(), dx, dy, isStrip);
    if(m) Tools.stepTransform(m);
  });
  function end(e){
    if(!last) return;
    last = null;
    try{ el.releasePointerCapture(e.pointerId); }catch(err){}
    Tools.endTransform();
  }
  on(el, 'pointerup', end);
  on(el, 'pointercancel', end);
}

var _r = new THREE.Vector3(), _u = new THREE.Vector3(), _f = new THREE.Vector3();

function deltaMatrix(mode, dx, dy, isStrip){
  var c = Tools.transformCentre();
  if(!c) return null;
  P.camBasis(_r, _u, _f);
  var world = P.viewHeight()/P.viewport().h;

  if(mode === 'move'){
    var v = new THREE.Vector3();
    if(isStrip) v.addScaledVector(_f, dy*world);            // depth axis
    else v.addScaledVector(_r, dx*world).addScaledVector(_u, -dy*world);
    return new THREE.Matrix4().makeTranslation(v.x, v.y, v.z);
  }

  if(mode === 'rotate'){
    var k = 0.011, q = new THREE.Quaternion();
    if(isStrip){
      q.setFromAxisAngle(_f.clone().normalize(), dy*k);      // roll
    } else {
      var qa = new THREE.Quaternion().setFromAxisAngle(_u.clone().normalize(), dx*k);
      var qb = new THREE.Quaternion().setFromAxisAngle(_r.clone().normalize(), dy*k);
      q.multiplyQuaternions(qa, qb);
    }
    return about(c, new THREE.Matrix4().makeRotationFromQuaternion(q));
  }

  var f = Math.exp(-dy * 0.006);
  return about(c, new THREE.Matrix4().makeScale(f,f,f));
}

function about(c, m){
  return new THREE.Matrix4().makeTranslation(c.x,c.y,c.z)
    .multiply(m)
    .multiply(new THREE.Matrix4().makeTranslation(-c.x,-c.y,-c.z));
}

/* ==========================================================================
   Refresh
   ========================================================================== */
UI.refresh = function(){
  /* before anything reads the tool: a fresh selection loads its own style into
     it, so every readout below shows the curves you just picked */
  adoptSelectionStyle();
  /* tool buttons, in both the pill and the bottom context menu */
  var tools = document.querySelectorAll('button[data-tool]');
  for(var i=0;i<tools.length;i++){
    tools[i].classList.toggle('on', tools[i].dataset.tool === TOOL.mode);
  }
  /* on desktop only one of each toggle pair is shown — reveal whichever is
     currently active so the pill always reflects the live tool */
  var pairs = [['draw','shape'],['select','lasso'],['erase','vacuum']];
  for(i=0;i<pairs.length;i++){
    var a = document.querySelector('#tools button[data-tool="'+pairs[i][0]+'"]');
    var b2 = document.querySelector('#tools button[data-tool="'+pairs[i][1]+'"]');
    if(!a || !b2) continue;
    var altIsLive = (TOOL.mode === pairs[i][1]);
    a.classList.toggle('alt', altIsLive);
    b2.classList.toggle('alt', !altIsLive);
  }

  /* the rail swatch shows the current colour */
  var bc = $('brushColor');
  if(bc){
    bc.style.background = '#' + TOOL.color.getHexString();
    bc.classList.toggle('on', !$('colorCard').classList.contains('hidden'));
  }
  setOn($('brushType'), !$('brushGrid').classList.contains('hidden'));
  setOn($('btnSize'),    !$('slidePop').classList.contains('hidden'));
  setOn($('btnTheme'), UI.themeOverride !== null);
  var hx = $('hexIn');
  if(hx && document.activeElement !== hx) hx.value = TOOL.color.getHexString().toUpperCase();

  /* The selection action bar rides along with the selection — except while
     liquifying, when the strip takes its place at the foot of the screen and
     duplicating or deleting mid-deformation is not what the hand is there for. */
  var liquifying = TOOL.mode === 'liquify';
  var selCount = S.selection.length;
  $('selBar').classList.toggle('hidden', selCount === 0 || liquifying);

  /* the liquify panel is the tool: it is up whenever the tool is */
  $('liquifyPanel').classList.toggle('hidden', !liquifying);
  if(liquifying){
    $('lqSizeVal').textContent     = TOOL.liquify.size;
    $('lqRangeVal').textContent    = TOOL.liquify.range;
    $('lqStrengthVal').textContent = TOOL.liquify.strength;
    var lqb = $('lqModes').querySelectorAll('button');
    for(var lq=0; lq<lqb.length; lq++){
      lqb[lq].classList.toggle('on', lqb[lq].dataset.lq === TOOL.liquify.mode);
    }
  }

  /* lighting readouts */
  if($('lightIntVal')) $('lightIntVal').textContent = Math.round(P.LIGHT.intensity*100) + '%';
  if($('lightAmbVal')) $('lightAmbVal').textContent = Math.round(P.LIGHT.ambient*100) + '%';
  if($('lightPick'))   $('lightPick').value = '#' + P.LIGHT.color.getHexString();
  setOn($('optToon'), P.LIGHT.toon);
  setOn($('optRender'), P.ENV.render);
  setOn($('optShadow'), P.ENV.groundShadow);
  placeLightDot();

  /* the rail's size/opacity readouts, and their popover twins */
  var erasing = UI.sizeKey() === 'eraserMM';
  var sv = Math.round(UI.getSize()) + 'mm';
  var ov = Math.round(TOOL.opacity*100) + '%';
  $('sizeVal').textContent = sv;
  $('opacityVal').textContent = ov;
  if($('sizeValPop'))    $('sizeValPop').textContent = sv;
  if($('opacityValPop')) $('opacityValPop').textContent = ov;
  $('btnSize').setAttribute('data-tip', erasing
    ? 'Eraser size — drag up or down, or tap the value to type one'
    : 'Brush size — drag up or down, or tap the value to type one');

  /* the icons carry no text label now, so the mirror axis goes in the tooltip */
  var mir = $('btnMirror');
  mir.classList.toggle('on', !!TOOL.mirror);
  mir.setAttribute('data-tip', TOOL.mirror
    ? ('Mirror ' + TOOL.mirror.toUpperCase() + ' — tap to cycle')
    : 'Mirror — X, then Z');

  /* a panel is "showing" via .open when compact, via !.hidden otherwise */
  function showing(id){
    var el = $(id);
    return UI.compact ? el.classList.contains('open') : !el.classList.contains('hidden');
  }
  setOn($('btnStage'), showing('stagePanel'));
  setOn($('dockTools'), showing('tools'));
  setOn($('dockBrush'), showing('brush'));
  setOn($('dockJoy'),   showing('joy'));
  setOn($('dockStage'), showing('stagePanel'));
  var du = $('dockUndo'), dr = $('dockRedo');
  if(du) du.disabled = !P.History.canUndo();
  if(dr) dr.disabled = !P.History.canRedo();

  /* toggles */
  setOn($('optFinger'),    P.Input.fingerPen);
  setOn($('optAutoGuide'), TOOL.autoGuide);
  setOn($('optStable'),    TOOL.stableOn);
  setOn($('optIsolate'),   G.isolate);
  setOn($('optClamp'),     G.clampOffSurface);
  setOn($('optHoldShape'), TOOL.shapeHold);
  setOn($('btnPressure'),  TOOL.pressureOn);
  setOn($('optGrid'),      P.ENV.grid);
  setOn($('optAxis'),      P.ENV.axis);
  setOn($('optFog'),       P.ENV.fog);
  setOn($('optShaded'),    P.ENV.shaded);
  setOn($('btnEyedrop'),   TOOL.mode === 'eyedrop');
  setOn($('btnInject'),    TOOL.mode === 'inject');

  /* brush readouts (they change when the injector samples, and when a
     selection is made) */
  $('size').value = UI.getSize();
  $('opacity').value = Math.round(TOOL.opacity*100);
  $('colorPick').value = '#' + TOOL.color.getHexString();
  var bs = $('brushGrid').querySelectorAll('button');
  var picked = null;
  for(i=0;i<bs.length;i++){
    var isOn = bs[i].dataset.brush === TOOL.brush;
    bs[i].classList.toggle('on', isOn);
    if(isOn) picked = bs[i];
  }
  /* THE RAIL SHOWS THE BRUSH YOU ARE HOLDING. The button that opens the brush
     grid used to carry one generic mark whatever was selected, so the rail
     could not tell you a pencil from a ribbon without opening it. It now wears
     the chosen brush's own icon, copied from the grid button rather than kept
     as a second drawing of the same thing - two copies would eventually
     disagree, and the tapered nib and the pencil are only a curve apart. */
  var railIcon = $('brushType');
  if(railIcon && picked && railIcon.dataset.shows !== TOOL.brush){
    railIcon.dataset.shows = TOOL.brush;
    railIcon.innerHTML = picked.innerHTML;
  }

  /* ---- bottom bar: one row that shows staging, else the guide, else a hint */
  var staging = (TOOL.mode === 'loft' || TOOL.mode === 'prim');
  var has = G.hasActive();
  $('ctxSlider').classList.toggle('hidden', !staging);
  $('guideBar').classList.toggle('hidden', staging || !has);
  $('ctxHint').classList.toggle('hidden', staging || has);
  if(has){
    $('guideName').textContent = G.active.name;
    $('btnGuideBend').disabled = false;   // sweeps replace their path, the rest deform
    $('guideOpacity').value = Math.round(G.active.opacity*100);
    $('guideOpacityVal').textContent = Math.round(G.active.opacity*100) + '%';
  } else {
    $('ctxHint').textContent = TOOL.autoGuide
      ? 'No 3D guide. Draw a stroke — it extrudes along the view direction into one.'
      : 'No 3D guide. Pick the Guide tool and draw a stroke to extrude one.';
  }

  /* contextual slider contents */
  if(staging){
    var isLoft = TOOL.mode === 'loft';
    $('primKinds').classList.toggle('hidden', isLoft);
    $('ctxRow2').classList.toggle('hidden', isLoft || UI.primKind !== 'tube');
    $('ctxLabel').textContent = isLoft ? ('Tension — ' + Tools.loftCount() + ' curves picked')
                                       : 'Segments';
    if(isLoft){
      $('ctxRange').value = Math.round(P.loftTension*100);
      $('ctxVal').textContent = P.loftTension.toFixed(2);
    } else {
      $('ctxRange').value = Math.round((UI.primSeg-3)/45*100);
      $('ctxVal').textContent = UI.primSeg;
      $('ctxRange2').value = Math.round(UI.primTaper*100);
      $('ctxVal2').textContent = UI.primTaper.toFixed(2);
    }
  }

  /* undo / redo */
  $('btnUndo').disabled = !P.History.canUndo();
  $('btnRedo').disabled = !P.History.canRedo();

  /* Joystick: only present when it has something to move. It is a big panel
     and an idle one is just clutter — this is most of the space win. */
  var t = Tools.transformTarget();
  $('joyTarget').textContent = !t ? 'Nothing selected'
    : (t.kind === 'guide' ? 'Guide selected'
                          : t.strokes.length + ' curve' + (t.strokes.length>1?'s':'') + ' selected');
  if(!UI.compact) $('joy').classList.toggle('hidden', !t);
  if(t) UI.layoutJoystick();    // aim the axis arcs at the new target

  /* counts */
  var n = S.list.length;
  if(P.diag && P.diag.count) P.diag.count.textContent = n;
  $('vCount').textContent = n;

  refreshLists();
};

/* ==========================================================================
   The grouping panel
   --------------------------------------------------------------------------
   Built to match Feather's: a row per group, name on the left, then the arrow
   that moves the current canvas selection into that group and the eye that
   hides it. Tap the name to rename, tap the row to make it the one you are
   drawing into, hold it to select everything inside.

   Rows are rebuilt wholesale on every refresh, so the two pieces of transient
   state that must survive a rebuild — an open rename box and an in-flight long
   press — are held out here rather than on the elements.
   ========================================================================== */
var renamingId = null, pressTimer = null, pressId = null, pressMoved = false;
var GROUP_HOLD_MS = 480;

/* Cancels the pending hold ONLY. It used to clear pressId as well, which made
   it impossible to call safely from the handlers that need to read pressId
   afterwards — the tap-to-activate path compared an id this had already
   nulled, so tapping a row silently did nothing. */
function cancelGroupPress(){
  if(pressTimer){ clearTimeout(pressTimer); pressTimer = null; }
}
function endGroupPress(){ cancelGroupPress(); pressId = null; pressMoved = false; }

function renderGroups(){
  var gl = $('groupList');
  if(!gl) return;
  if(renamingId !== null) return;          // never yank the box out mid-rename

  gl.innerHTML = '';
  S.ensureGroup();
  for(var i=0;i<S.groups.length;i++){
    (function(g){
      var n = S.membersOf(g.id).length;
      var row = document.createElement('div');
      row.className = 'grpRow' + (g.id === S.activeGroup ? ' on' : '') +
                      (g.visible === false ? ' hidden-group' : '');
      row.dataset.id = g.id;

      var name = document.createElement('button');
      name.className = 'grpName';
      name.type = 'button';
      name.textContent = g.name;
      /* Tap the name of the group you are in to rename it. On any other row a
         tap selects that row first — the same slow double-tap every file list
         uses, and it leaves the whole row as a target for switching groups
         rather than a sliver of padding beside the name. */
      var isActive = g.id === S.activeGroup;
      name.setAttribute('data-tip', isActive ? 'Tap to rename' : 'Tap to draw into this group');
      name.onclick = function(e){
        e.stopPropagation();
        if(g.id === S.activeGroup) beginRename(row, g);
        else P.Tools.setActiveGroup(g.id);
      };
      row.appendChild(name);

      var count = document.createElement('span');
      count.className = 'grpCount';
      count.textContent = n ? n : '';
      row.appendChild(count);

      var arrow = document.createElement('button');
      arrow.className = 'ico sm';
      arrow.innerHTML = '<svg><use href="#i-enter"/></svg>';
      arrow.setAttribute('data-tip', 'Move the selected curves into ' + g.name);
      arrow.onclick = function(e){
        e.stopPropagation();
        P.Tools.assignSelection(g.id);
      };
      row.appendChild(arrow);

      var eye = document.createElement('button');
      eye.className = 'ico sm' + (g.visible === false ? ' off' : '');
      eye.innerHTML = '<svg><use href="#i-eye' + (g.visible === false ? '-off' : '') + '"/></svg>';
      eye.setAttribute('data-tip', g.visible === false ? 'Show this group' : 'Hide this group');
      eye.onclick = function(e){
        e.stopPropagation();
        P.Tools.setGroupVisible(g.id, g.visible === false);
      };
      row.appendChild(eye);

      /* tap to make active, hold to select everything in it */
      row.addEventListener('pointerdown', function(e){
        if(e.target.closest('button')) return;
        cancelGroupPress();
        pressId = g.id; pressMoved = false;
        pressTimer = setTimeout(function(){
          pressTimer = null; pressMoved = true;     // the tap is spent on the hold
          P.Tools.selectGroup(g.id);
        }, GROUP_HOLD_MS);
      });
      row.addEventListener('pointerup', function(e){
        if(e.target.closest('button')) return;
        var tapped = !pressMoved && pressId === g.id;
        endGroupPress();
        if(tapped) P.Tools.setActiveGroup(g.id);
      });
      row.addEventListener('pointercancel', endGroupPress);
      row.addEventListener('pointerleave', endGroupPress);

      gl.appendChild(row);
    })(S.groups[i]);
  }
}
UI.renderGroups = renderGroups;

function beginRename(row, g){
  renamingId = g.id;
  var input = document.createElement('input');
  input.className = 'grpNameEdit';
  input.value = g.name;
  input.setAttribute('aria-label', 'Group name');
  row.replaceChild(input, row.firstChild);
  input.focus();
  input.select();

  var done = false;
  function finish(commit){
    if(done) return;
    done = true;
    renamingId = null;
    if(commit) P.Tools.renameGroup(g.id, input.value);
    renderGroups();
    UI.refresh();
  }
  input.onkeydown = function(e){
    if(e.key === 'Enter'){ e.preventDefault(); finish(true); }
    else if(e.key === 'Escape'){ e.preventDefault(); finish(false); }
    e.stopPropagation();                 // the canvas has single-key shortcuts
  };
  input.onblur = function(){ finish(true); };
}

function refreshLists(){
  var sp = $('stagePanel');
  var visible = UI.compact ? sp.classList.contains('open') : !sp.classList.contains('hidden');
  if(!visible) return;

  renderGroups();

  var rl = $('resList');
  rl.innerHTML = '';
  if(!G.resources.length){
    rl.innerHTML = '<div class="empty">No saved guides.</div>';
  } else {
    for(var r=0;r<G.resources.length;r++){
      (function(g, idx){
        var d = document.createElement('div');
        d.className = 'listItem' + (g === G.active ? ' sel' : '');

        var eye = document.createElement('button');
        eye.className = 'ghost small';
        eye.style.cssText = 'min-height:0;padding:0 5px;flex:0 0 auto';
        eye.textContent = g.visible ? '◉' : '○';
        eye.title = g.visible ? 'Showing as reference' : 'Hidden';
        eye.onclick = function(ev){
          ev.stopPropagation();            // the row itself activates
          G.setResourceVisible(g, !g.visible);
          P.onSceneChange();
        };
        d.appendChild(eye);

        var label = document.createElement('span');
        label.textContent = g.name + ' ' + (idx+1);
        d.appendChild(label);

        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = (g === G.active) ? 'active' : g.kind;
        d.appendChild(tag);

        d.onclick = function(){ Tools.activateResource(g); P.toast('Guide activated'); };
        rl.appendChild(d);
      })(G.resources[r], r);
    }
  }
}

UI.refreshView = function(){
  UI.layoutJoystick();          // the arcs point along the axes, so they orbit too
  $('vFocal').textContent = Math.round(P.VIEW.focal);
  $('focal').value = Math.round(P.VIEW.focal);
  $('focalVal').textContent = Math.round(P.VIEW.focal) + 'mm';
  $('vProj').textContent = P.VIEW.ortho ? 'Ortho' : 'Persp';
  setOn($('btnProj'), P.VIEW.ortho);
  $('vPivot').textContent = P.VIEW.pinned ? 'pinned' : 'auto';
};

/* ==========================================================================
   First-run walkthrough  (fixes D.2)
   ========================================================================== */
var WALK = [
  { t:'Draw one stroke',
    b:'With no guide active, your first stroke is not a curve — it is extruded along the ' +
      'direction you are looking in and becomes a translucent <b>3D guide</b>. Draw one now.' },
  { t:'Orbit and look at it',
    b:function(){
      return P.Input.fingerPen
        ? 'Drag with <b>two fingers</b> to orbit — one finger is busy drawing. Pinch to ' +
          'zoom, three fingers to pan. The guide has depth: the ' +
          '<b style="color:#ff8a3d">orange edge</b> marks where your first stroke was.'
        : 'Drag with one finger, or hold the right mouse button, to orbit. The guide has ' +
          'depth: the <b style="color:#ff8a3d">orange edge</b> marks where your first ' +
          'stroke was.';
    } },
  { t:'Draw on the guide',
    b:'Every stroke from here projects onto that surface, so it picks up real 3D coordinates. ' +
      'That is the whole trick.' },
  { t:'Bend it',
    b:'Orbit to a new viewpoint, hit <b>Bend</b>, and draw a path. The first stroke keeps its ' +
      'shape and gets swept along what you just drew — a circle plus a big top-view circle ' +
      'gives you a doughnut.' },
  { t:'Navigate',
    b:function(){
      return 'Double-tap snaps to the nearest of the six straight-on views, and a ' +
        'three-finger double-tap flips to orthographic. Press and hold to pin the orbit ' +
        'point; hold on empty space to reset. ' +
        (P.Input.fingerPen
          ? 'Change the lens from the <b>≡</b> menu.'
          : 'Swipe three fingers to change the lens (10–500mm).');
    } },
  { t:'The guide is also a mask',
    b:'Anything hidden behind the guide cannot be erased or selected — cover what you want to ' +
      'protect, then erase freely. Toggle it under <b>Isolate by guide</b>.' }
];
var walkIdx = 0;

function startWalk(i){
  walkIdx = i;
  showWalk();
  $('walk').classList.remove('hidden');
}
function showWalk(){
  var w = WALK[walkIdx];
  $('walkStep').textContent = 'Step ' + (walkIdx+1) + ' of ' + WALK.length;
  $('walkTitle').textContent = w.t;
  /* some steps describe gestures, which differ between pen and finger mode */
  $('walkBody').innerHTML = (typeof w.b === 'function') ? w.b() : w.b;
  $('walkNext').textContent = walkIdx === WALK.length-1 ? 'Start sketching' : 'Next';
}
on(document, 'click', function(e){
  if(e.target && e.target.id === 'walkNext'){
    walkIdx++;
    if(walkIdx >= WALK.length) endWalk(); else showWalk();
  } else if(e.target && e.target.id === 'walkSkip'){
    endWalk();
  }
});
function endWalk(){
  $('walk').classList.add('hidden');
  try{ localStorage.setItem('plume.walk.done','1'); }catch(err){}
}

})(window.P);
