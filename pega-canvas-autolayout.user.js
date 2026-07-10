// ==UserScript==
// @name         Pega Strategy Canvas Auto-Layout
// @namespace    navaneethsen@gmail.com
// @version      1.7
// @description  Adds hierarchical / tree layout buttons to the Pega strategy canvas (Dev Studio)
// @match        *://*/prweb/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * Verified against Pega Infinity Dev Studio strategy canvas (localhost:18080).
 * The canvas lives in an inner frame; Tampermonkey injects into every matching
 * frame, and the panel only attaches in the frame that owns ViewerManager.
 *
 * Graph API used (all confirmed live):
 *   ViewerManager.viewer.graph            - graph object
 *   graph.vertices                        - id -> vertex map
 *   vertex.incoming / vertex.outgoing     - edge arrays with .source / .target
 *   vertex.getBounds()                    - {x,y,width,height,getCenterX(),getCenterY()}
 *   graph.beginUpdate() / endUpdate()
 *   graph.translateVertices(v, [dx,dy])
 *   graph.scaleFit()                      - zoom to fit (does NOT pan)
 *   viewer.moveView(cx, cy)               - pan so graph point (cx,cy) is centered
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------- helpers

  function getViewer() {
    var VM = window.ViewerManager;
    if (VM && VM.viewer && VM.viewer.graph) return VM.viewer;
    return null;
  }

  function getCanvasSize() {
    var svg = document.querySelector('.gfw-canvas svg');
    if (svg) {
      var r = svg.getBoundingClientRect();
      if (r.width && r.height) return { width: r.width, height: r.height };
    }
    return { width: 800, height: 600 };
  }

  // Layoutable vertices: everything except the invisible root container.
  function collectVertices(graph) {
    return Object.keys(graph.vertices)
      .map(function (k) { return graph.vertices[k]; })
      .filter(function (v) {
        return v && typeof v.getBounds === 'function' &&
               String(v.type || '').indexOf('root') !== 0;
      });
  }

  // After a layout, zoom-to-fit then pan so the content center is on screen.
  function fitAndCenter(viewer, vertices) {
    var graph = viewer.graph;
    try { graph.scaleFit(); } catch (e) { /* non-fatal */ }
    try {
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      vertices.forEach(function (v) {
        var b = v.getBounds();
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
      });
      viewer.moveView((minX + maxX) / 2, (minY + maxY) / 2);
    } catch (e) { /* non-fatal */ }
  }

  // ---------------------------------------------------- hierarchical layout

  /**
   * Hierarchical layout - organizes nodes by their connection depth.
   * Uses longest-path layering for DAGs, with cycle handling.
   */
  function applyHierarchicalLayout(graph, vertices, direction, spacing) {
    return applyCompound(graph, vertices, direction, spacing, computeLayeredPositions, 'Hierarchical layout');
  }

  /**
   * Size-aware layered (Sugiyama-lite) layout.
   *
   * Works in an abstract (layerAxis, crossAxis) space so vertical/horizontal
   * share one code path:
   *   horizontal flow -> layerAxis = X (depth), crossAxis = Y (siblings)
   *   vertical   flow -> layerAxis = Y (depth), crossAxis = X (siblings)
   *
   * Fixes over the old barycenter version, which fell apart when a canvas
   * mixed 270x240 shapes with 60px ones:
   *   1. Longest-path layering via proper topological order (cycle-safe).
   *   2. Ordering by MEDIAN of neighbour order (down+up sweeps) to cut crossings.
   *   3. Coordinate assignment in PIXEL space:
   *        - cross positions start packed by node size (no overlap by
   *          construction, whatever the size mix),
   *        - then each node is pulled toward the median of its neighbours'
   *          cross-centres and a separation sweep re-imposes the min gap,
   *          which straightens edges without ever letting big shapes collide.
   *   4. Layer depth advances by the max node size IN THAT LAYER, so a fat
   *      layer never overlaps the next.
   *
   * Exposed on window.__pcalCompute so it can be unit-tested off-DOM.
   */
  function computeLayeredPositions(nodes, edges, opts) {
    // nodes: [{id, w, h}], edges: [{source, target}]
    // returns { positions: {id:{x,y}}, layers, bounds:{minX,minY,maxX,maxY} }
    opts = opts || {};
    var isVertical = opts.direction === 'vertical';
    var spacing = opts.spacing || 60;
    var layerGap = spacing * 1.5;   // gap between layer bands (depth axis)
    var crossGap = spacing;         // gap between siblings (cross axis)

    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    // size helpers in abstract axes
    function depthSize(n) { return isVertical ? n.h : n.w; } // along flow
    function crossSize(n) { return isVertical ? n.w : n.h; } // perpendicular

    // adjacency restricted to this node set
    var outAdj = {}, inAdj = {};
    nodes.forEach(function (n) { outAdj[n.id] = []; inAdj[n.id] = []; });
    edges.forEach(function (e) {
      if (byId[e.source] && byId[e.target] && e.source !== e.target) {
        outAdj[e.source].push(e.target);
        inAdj[e.target].push(e.source);
      }
    });

    // ---- 1. break cycles, then longest-path layer over the acyclic graph --
    // CDH strategies are drawn cyclically (sub-strategy feedback loops), so a
    // plain longest-path never terminates cleanly. DFS-mark the back-edges
    // (edges pointing to a node still on the DFS stack) and layer on the rest;
    // the full edge set is still used later for ordering/alignment.
    var color = {};
    nodes.forEach(function (n) { color[n.id] = 0; }); // 0 new, 1 on-stack, 2 done
    var back = {};
    // iterative DFS to avoid deep recursion on large canvases
    function dfsFrom(start) {
      var stack = [{ id: start, i: 0 }];
      color[start] = 1;
      while (stack.length) {
        var top = stack[stack.length - 1];
        var adj = outAdj[top.id];
        if (top.i < adj.length) {
          var v = adj[top.i++];
          if (color[v] === 1) back[top.id + ' ' + v] = true; // back-edge
          else if (color[v] === 0) { color[v] = 1; stack.push({ id: v, i: 0 }); }
        } else {
          color[top.id] = 2;
          stack.pop();
        }
      }
    }
    // start at real sources first so most edges keep their forward direction
    var startIds = nodes.filter(function (n) { return inAdj[n.id].length === 0; })
      .map(function (n) { return n.id; })
      .concat(nodes.map(function (n) { return n.id; }));
    startIds.forEach(function (id) { if (color[id] === 0) dfsFrom(id); });

    var accOut = {}, accIndeg = {};
    nodes.forEach(function (n) { accOut[n.id] = []; accIndeg[n.id] = 0; });
    edges.forEach(function (e) {
      if (byId[e.source] && byId[e.target] && e.source !== e.target &&
          !back[e.source + ' ' + e.target]) {
        accOut[e.source].push(e.target); accIndeg[e.target]++;
      }
    });

    var layer = {};
    nodes.forEach(function (n) { layer[n.id] = 0; });
    var q = nodes.filter(function (n) { return accIndeg[n.id] === 0; }).map(function (n) { return n.id; });
    var topo = [];
    var localIndeg = {};
    nodes.forEach(function (n) { localIndeg[n.id] = accIndeg[n.id]; });
    while (q.length) {
      var id = q.shift();
      topo.push(id);
      accOut[id].forEach(function (t) {
        if (layer[t] < layer[id] + 1) layer[t] = layer[id] + 1;
        if (--localIndeg[t] === 0) q.push(t);
      });
    }

    // group into layers
    var maxLayer = 0;
    nodes.forEach(function (n) { if (layer[n.id] > maxLayer) maxLayer = layer[n.id]; });
    var layers = [];
    for (var L = 0; L <= maxLayer; L++) layers.push([]);
    // stable initial order = topo order, then any leftover nodes
    var placed = {};
    topo.forEach(function (id) { layers[layer[id]].push(byId[id]); placed[id] = true; });
    nodes.forEach(function (n) { if (!placed[n.id]) layers[layer[n.id]].push(n); });

    // ---- 2. crossing reduction: median ordering, down + up sweeps ---------
    function orderIndex(layerArr) {
      var idx = {};
      layerArr.forEach(function (n, i) { idx[n.id] = i; });
      return idx;
    }
    function median(vals) {
      if (!vals.length) return -1;
      vals.sort(function (a, b) { return a - b; });
      var m = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    }
    function sweep(adj, refLayerIdxOf) {
      // reorder each layer by median position of neighbours in the reference layer
      for (var li = 0; li < layers.length; li++) {
        var refIdx = refLayerIdxOf(li);
        if (!refIdx) continue;
        var arr = layers[li];
        var med = {};
        arr.forEach(function (n) {
          var positions = [];
          adj[n.id].forEach(function (nb) { if (refIdx[nb] !== undefined) positions.push(refIdx[nb]); });
          med[n.id] = median(positions);
        });
        // keep nodes with no neighbours (med = -1) at their current spot
        var withMed = arr.map(function (n, i) { return { n: n, i: i, m: med[n.id] }; });
        withMed.sort(function (a, b) {
          var am = a.m < 0 ? a.i : a.m, bm = b.m < 0 ? b.i : b.m;
          return am - bm || a.i - b.i;
        });
        layers[li] = withMed.map(function (x) { return x.n; });
      }
    }
    for (var iter = 0; iter < 4; iter++) {
      // down: order layer li by neighbours in li-1 (incoming)
      sweep(inAdj, function (li) { return li > 0 ? orderIndex(layers[li - 1]) : null; });
      // up: order layer li by neighbours in li+1 (outgoing)
      sweep(outAdj, function (li) { return li < layers.length - 1 ? orderIndex(layers[li + 1]) : null; });
    }

    // ---- 3a. depth coordinate: centre of each layer band ------------------
    var depthCenter = [];
    var run = 0;
    for (var d = 0; d < layers.length; d++) {
      var thick = 0;
      layers[d].forEach(function (n) { thick = Math.max(thick, depthSize(n)); });
      depthCenter[d] = run + thick / 2;
      run += thick + layerGap;
    }

    // ---- 3b. cross coordinate: pack, then median-align + separate ---------
    var cross = {}; // id -> cross-centre
    layers.forEach(function (arr) {
      var c = 0;
      arr.forEach(function (n) {
        c += crossSize(n) / 2;
        cross[n.id] = c;
        c += crossSize(n) / 2 + crossGap;
      });
    });

    // enforce order + min gap within a layer, anchored near desired positions
    function separate(arr) {
      // forward pass
      for (var i = 1; i < arr.length; i++) {
        var prev = arr[i - 1], cur = arr[i];
        var minC = cross[prev.id] + crossSize(prev) / 2 + crossGap + crossSize(cur) / 2;
        if (cross[cur.id] < minC) cross[cur.id] = minC;
      }
    }
    function alignPass(adjList) {
      layers.forEach(function (arr) {
        arr.forEach(function (n) {
          var positions = [];
          adjList[n.id].forEach(function (nb) { if (cross[nb] !== undefined) positions.push(cross[nb]); });
          if (positions.length) cross[n.id] = median(positions);
        });
        // re-sort by desired then re-separate so order is preserved & no overlap
        arr.sort(function (a, b) { return cross[a.id] - cross[b.id]; });
        separate(arr);
      });
    }
    // alternate down/up alignment a few times so positions propagate both ways
    for (var a2 = 0; a2 < 6; a2++) {
      alignPass(inAdj);   // align to parents
      alignPass(outAdj);  // align to children
    }

    // Stagger alternate layers on the cross axis. The aligner makes chains
    // perfectly straight, which reads well until several links share the line:
    // skip-edges, parallel runs, and dotted refs all collapse onto one stroke.
    // A half-spacing offset on every odd layer gives every segment its own
    // slope, so no two links are ever exactly collinear.
    var stagger = crossGap / 2;
    layers.forEach(function (arr, d) {
      if (d % 2 === 1) {
        arr.forEach(function (n) { cross[n.id] += stagger; });
      }
    });

    // De-collinearize dotted Reference links: when a ref edge's endpoints end
    // up on the same cross line as the flow (single-pipeline strategies put
    // EVERYTHING on one line), the dotted link is drawn exactly over the solid
    // connectors and is unreadable. Nudge the ref SOURCE off the line
    // (alternating sides), then re-separate each layer so nothing overlaps.
    var refs = opts.refEdges || [];
    var flip = 1;
    refs.forEach(function (e) {
      if (cross[e.source] === undefined || cross[e.target] === undefined) return;
      if (Math.abs(cross[e.source] - cross[e.target]) > 1) return; // already split
      var n = byId[e.source];
      cross[e.source] += flip * (crossSize(n) / 2 + crossGap);
      flip = -flip;
    });

    // restore in-layer order + minimum gaps after the offsets
    layers.forEach(function (arr) {
      arr.sort(function (a, b) { return cross[a.id] - cross[b.id]; });
      separate(arr);
    });

    // ---- 4. map abstract (depth, cross) -> (x, y), collect bounds ---------
    var positions = {};
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    layers.forEach(function (arr, d) {
      arr.forEach(function (n) {
        var cx, cy; // centre
        if (isVertical) { cx = cross[n.id]; cy = depthCenter[d]; }
        else { cx = depthCenter[d]; cy = cross[n.id]; }
        var x = cx - n.w / 2, y = cy - n.h / 2;
        positions[n.id] = { x: x, y: y };
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + n.w); maxY = Math.max(maxY, y + n.h);
      });
    });

    return { positions: positions, layers: layers.length, bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } };
  }

  /**
   * Pure tree layout — same {positions, bounds} contract as
   * computeLayeredPositions, so the compound framework can use either.
   * Each vertex is assigned to its first-encountered parent (DAG/cycle safe);
   * children are centred under their parent, subtrees packed on the cross axis.
   * Depth stepping is per-node (edge-to-edge + spacing) so one giant enclosure
   * doesn't inflate every level gap.
   */
  function computeTreePositions(nodes, edges, opts) {
    opts = opts || {};
    var isVertical = opts.direction === 'vertical';
    var spacing = opts.spacing || 60;
    var siblingPadding = spacing;

    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    function depthSize(n) { return isVertical ? n.h : n.w; }
    function crossSize(n) { return isVertical ? n.w : n.h; }

    var outAdj = {}, inAdj = {};
    nodes.forEach(function (n) { outAdj[n.id] = []; inAdj[n.id] = []; });
    edges.forEach(function (e) {
      if (byId[e.source] && byId[e.target] && e.source !== e.target) {
        outAdj[e.source].push(e.target); inAdj[e.target].push(e.source);
      }
    });

    // children via BFS, each node assigned to the first parent encountered
    var children = {};
    nodes.forEach(function (n) { children[n.id] = []; });
    var assigned = {};
    var roots = nodes.filter(function (n) { return inAdj[n.id].length === 0; }).map(function (n) { return n.id; });
    if (!roots.length) {
      var best = nodes[0].id, mx = -1;
      nodes.forEach(function (n) { if (outAdj[n.id].length > mx) { mx = outAdj[n.id].length; best = n.id; } });
      roots = [best];
    }
    var queue = roots.slice();
    roots.forEach(function (r) { assigned[r] = true; });
    while (queue.length) {
      var c = queue.shift();
      outAdj[c].forEach(function (t) {
        if (!assigned[t]) { assigned[t] = true; children[c].push(t); queue.push(t); }
      });
    }
    nodes.forEach(function (n) { if (!assigned[n.id]) { assigned[n.id] = true; roots.push(n.id); } });

    // subtree cross-extent, cycle-guarded
    var sw = {}, calc = {};
    function csw(id) {
      if (sw[id] !== undefined) return sw[id];
      if (calc[id]) return crossSize(byId[id]);
      calc[id] = true;
      var cl = children[id];
      if (!cl.length) sw[id] = crossSize(byId[id]);
      else {
        var tot = 0;
        cl.forEach(function (ch) { tot += csw(ch) + siblingPadding; });
        tot -= siblingPadding;
        sw[id] = Math.max(tot, crossSize(byId[id]));
      }
      calc[id] = false;
      return sw[id];
    }
    roots.forEach(csw);

    var pc = {};
    var positioned = {};
    function pos(id, p, c) {
      if (positioned[id]) return;
      positioned[id] = true;
      pc[id] = { p: p, c: c };
      var cl = children[id];
      if (!cl.length) return;
      var start = c - sw[id] / 2;
      var childPrimary = p + depthSize(byId[id]) / 2 + spacing;
      cl.forEach(function (ch) {
        var cw = sw[ch] || crossSize(byId[ch]);
        pos(ch, childPrimary + depthSize(byId[ch]) / 2, start + cw / 2);
        start += cw + siblingPadding;
      });
    }
    var totalRoots = 0;
    roots.forEach(function (r) { totalRoots += (sw[r] || spacing) + spacing * 2; });
    totalRoots -= spacing * 2;
    var rootStart = -totalRoots / 2;
    roots.forEach(function (r) {
      var rw = sw[r] || spacing;
      pos(r, 0, rootStart + rw / 2);
      rootStart += rw + spacing * 2;
    });

    var positions = {};
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      var q = pc[n.id] || { p: 0, c: 0 };
      var cx, cy;
      if (isVertical) { cx = q.c; cy = q.p; } else { cx = q.p; cy = q.c; }
      var x = cx - n.w / 2, y = cy - n.h / 2;
      positions[n.id] = { x: x, y: y };
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + n.w); maxY = Math.max(maxY, y + n.h);
    });
    return { positions: positions, layers: 0, bounds: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } };
  }

  /**
   * Compound (nested) layout for enclosure shapes.
   *
   * CDH strategies use "Context" enclosures (e.g. Customers, Agreements) that
   * visually wrap child shapes; membership lives on vertex.contents (an object
   * map, not the model parent tree — every shape's parent is the root). The old
   * flat layout tore contents out of their enclosure. This lays out each
   * enclosure's interior with the layered algorithm, sizes the enclosure to fit,
   * then lays out the parent level treating enclosures as single big nodes.
   *
   * contents: { containerId: [childId, ...] } (a child may itself be a container)
   * Returns { abs: {id:{x,y,w,h}}, fitted, topLevel, containerOf }.
   * Generalises the flat case: with no containers it reduces to one layered pass.
   */
  function computeCompoundLayout(nodes, edges, contents, opts) {
    opts = opts || {};
    var HEADER = opts.header != null ? opts.header : 50;
    var PAD = opts.pad != null ? opts.pad : 30;
    var spacing = opts.spacing || 60;
    var dir = opts.direction || 'horizontal';

    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    function isContainer(id) { return contents[id] && contents[id].length > 0; }

    var containerOf = {};
    Object.keys(contents).forEach(function (cid) {
      contents[cid].forEach(function (m) { containerOf[m] = cid; });
    });
    var topLevel = nodes.filter(function (n) { return !containerOf[n.id]; }).map(function (n) { return n.id; });

    var fitted = {};
    var rel = {};

    function ancestorInGroup(id, memberSet) {
      var cur = id, guard = 0;
      while (cur && guard++ < 1000) {
        if (memberSet[cur]) return cur;
        cur = containerOf[cur];
      }
      return null;
    }

    function layoutGroup(memberIds) {
      var memberSet = {};
      memberIds.forEach(function (id) { memberSet[id] = true; });
      // recurse into container members FIRST (bottom-up) so parents lay them
      // out at fitted size, not the raw enclosure size. The fitted size is at
      // least the LIVE measured size: Pega may render the enclosure bigger
      // than interior+padding (its own chrome), and siblings must clear the
      // real box or the enclosure visually covers them.
      memberIds.forEach(function (id) {
        if (isContainer(id) && !fitted[id]) {
          var innerC = layoutGroup(contents[id]);
          fitted[id] = {
            w: Math.max(innerC.w + 2 * PAD, byId[id].w),
            h: Math.max(innerC.h + HEADER + PAD, byId[id].h)
          };
        }
      });

      var localNodes = memberIds.map(function (id) {
        var sz = fitted[id] || { w: byId[id].w, h: byId[id].h };
        return { id: id, w: sz.w, h: sz.h };
      });
      function toLocal(edgeList) {
        var seen = {}, out = [];
        edgeList.forEach(function (e) {
          var s = ancestorInGroup(e.source, memberSet), t = ancestorInGroup(e.target, memberSet);
          if (s && t && s !== t) {
            var k = s + ' ' + t;
            if (!seen[k]) { seen[k] = true; out.push({ source: s, target: t }); }
          }
        });
        return out;
      }
      var localEdges = toLocal(edges);
      var localRefs = toLocal(opts.refEdges || []);

      var layoutFn = opts.layoutFn || computeLayeredPositions;
      var res = layoutFn(localNodes, localEdges, { direction: dir, spacing: spacing, refEdges: localRefs });
      memberIds.forEach(function (id) {
        rel[id] = { x: res.positions[id].x - res.bounds.minX, y: res.positions[id].y - res.bounds.minY };
      });
      return { w: res.bounds.maxX - res.bounds.minX, h: res.bounds.maxY - res.bounds.minY };
    }

    layoutGroup(topLevel);

    var abs = {};
    function place(memberIds, ox, oy) {
      memberIds.forEach(function (id) {
        var ax = ox + rel[id].x, ay = oy + rel[id].y;
        var sz = fitted[id] || byId[id];
        abs[id] = { x: ax, y: ay, w: sz.w, h: sz.h };
        if (isContainer(id)) place(contents[id], ax + PAD, ay + HEADER);
      });
    }
    place(topLevel, 0, 0);

    return { abs: abs, fitted: fitted, topLevel: topLevel, containerOf: containerOf, isContainer: isContainer };
  }

  // Normalise a vertex.contents / .children value (array | object-map | Set)
  // into an array of member ids that exist in idSet.
  function memberIds(x, idSet) {
    var out = [];
    if (!x) return out;
    function push(v) { var id = v && v.id; if (id && idSet[id]) out.push(id); }
    if (Array.isArray(x)) x.forEach(push);
    else if (typeof x.forEach === 'function') x.forEach(push);
    else if (typeof x === 'object') Object.keys(x).forEach(function (k) { push(x[k]); });
    return out;
  }

  // Both live-unverified enclosure mutations sit behind flags after a v1.5
  // field failure (giant empty enclosure boxes, shapes scattered, orphan
  // links): growVertices' signature is inferred, and expandVertex restores the
  // stored expandedState geometry, both of which can fight the layout.
  // Verify each with a console probe before turning back on.
  var ENABLE_ENCLOSURE_RESIZE = false; // graph.growVertices([dw,dh]) — unverified
  var ENABLE_ENCLOSURE_EXPAND = true;  // expandVertex/expand on cfg.expanded===false

  function applyCompound(graph, vertices, direction, spacing, layoutFn, label) {
    if (vertices.length === 0) return { success: false, message: 'No vertices to arrange' };

    var idSet = {};
    vertices.forEach(function (v) { idSet[v.id] = true; });
    var vById = {};
    vertices.forEach(function (v) { vById[v.id] = v; });
    var expandedOnce = {}; // one expand per vertex per layout run — never re-fire on pass 2

    // Expand collapsed enclosures. cfg.expanded is the authoritative state
    // (confirmed live on a Context enclosure: cfg has expanded/collapsedState/
    // expandedState). Only call expand() when expanded === false so an open
    // enclosure is never touched (in case expand semantics toggle). Falls back
    // to a geometry heuristic when the cfg flag is absent. Runs at the start
    // of EVERY pass so a re-render that re-collapses between passes is undone.
    function expandEnclosures() {
      if (!ENABLE_ENCLOSURE_EXPAND) return 0;
      var count = 0;
      vertices.forEach(function (v) {
        if (expandedOnce[v.id]) return; // even if cfg.expanded didn't flip, don't double-fire
        var m = memberIds(v.contents, idSet);
        if (!m.length) return;
        var needsExpand;
        var flag = v.cfg && typeof v.cfg.expanded === 'boolean' ? v.cfg.expanded : null;
        if (flag !== null) {
          needsExpand = flag === false;
        } else {
          // no cfg flag: expand when a member is invisible (hidden by collapse)
          needsExpand = m.some(function (id) {
            var mv = vById[id];
            try { return !!(mv && mv.isVisible && mv.isVisible() === false); }
            catch (e) { return false; }
          });
        }
        if (!needsExpand) return;
        expandedOnce[v.id] = true;
        try {
          if (typeof graph.expandVertex === 'function') graph.expandVertex(v);
          else if (typeof v.expand === 'function') v.expand();
          count++;
        } catch (e) {
          try { if (typeof v.expand === 'function') { v.expand(); count++; } } catch (e2) { /* non-fatal */ }
        }
      });
      if (count) console.log('[canvas-layout] expanded ' + count + ' enclosure(s)');
      return count;
    }

    // Split edges by type (confirmed live: 'Inheritance' = solid flow,
    // 'Reference' = dotted link). Reference links are NOT execution flow:
    // layering on them drags targets into fake layers and draws the dotted
    // line exactly over the straight connectors. Flow edges drive the layout;
    // ref edges are passed separately so the layout can de-collinearize their
    // endpoints (nudge the source off the flow line, making the dotted link a
    // visible diagonal instead of an overlay).
    var edges = [], refEdges = [];
    vertices.forEach(function (v) {
      (v.outgoing || []).forEach(function (e) {
        if (!e.target || !idSet[e.target.id]) return;
        var kind = '';
        try {
          kind = String((e.type && (e.type.name || e.type)) ||
                        (e.cfg && (e.cfg.type || e.cfg.category)) || '');
        } catch (ex) { /* treat as flow */ }
        var rec = { source: v.id, target: e.target.id };
        if (/ref/i.test(kind)) refEdges.push(rec);
        else edges.push(rec);
      });
    });
    var contents = {};
    var enclosureCount = 0;
    vertices.forEach(function (v) {
      var m = memberIds(v.contents, idSet);
      if (m.length) { contents[v.id] = m; enclosureCount++; }
    });

    // One full snapshot -> compute -> apply cycle. Bounds are re-read from the
    // live graph each call, so a second pass sees the REAL enclosure sizes
    // after Pega re-wrapped them around the moved children (pass 1 works from
    // pre-layout guesses; pass 2 corrects any enclosure that rendered bigger
    // than assumed and was covering its neighbours).
    function runPass() {
      expandEnclosures(); // reopen anything collapsed (or re-collapsed by a re-render)

      var nodes = vertices.map(function (v) {
        var b = v.getBounds();
        return { id: v.id, w: b.width, h: b.height };
      });

      var res = computeCompoundLayout(nodes, edges, contents, { direction: direction, spacing: spacing, layoutFn: layoutFn, refEdges: refEdges });

      // centre the whole thing on the canvas
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      Object.keys(res.abs).forEach(function (id) {
        var a = res.abs[id];
        minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
        maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
      });
      var canvas = getCanvasSize();
      var offX = Math.max(50, (canvas.width - (maxX - minX)) / 2) - minX;
      var offY = Math.max(50, (canvas.height - (maxY - minY)) / 2) - minY;

      // Apply parents BEFORE children: moving an enclosure may drag its
      // members, so set the enclosure first, then re-derive each child's delta
      // from its (possibly shifted) live bounds.
      //
      // Enclosures do NOT auto-wrap around their children (confirmed live:
      // cfg.expanded true yet box stayed 270x240 with children far outside),
      // so containers are explicitly RESIZED to the fitted layout box via
      // growVertices — the resize sibling of translateVertices.
      graph.beginUpdate();
      function apply(memberList) {
        memberList.forEach(function (id) {
          var v = vById[id], target = res.abs[id];
          if (v && target) {
            var b = v.getBounds();
            var dx = (target.x + offX) - b.x, dy = (target.y + offY) - b.y;
            if (dx !== 0 || dy !== 0) graph.translateVertices(v, [dx, dy]);
            if (res.isContainer(id) && ENABLE_ENCLOSURE_RESIZE) {
              try {
                var bb = v.getBounds();
                var dw = target.w - bb.width, dh = target.h - bb.height;
                if (dw !== 0 || dh !== 0) {
                  if (typeof graph.growVertices === 'function') graph.growVertices(v, [dw, dh]);
                  else if (typeof graph.growVertex === 'function') graph.growVertex(v, [dw, dh]);
                }
              } catch (e) { console.log('[canvas-layout] enclosure resize failed for ' + id + ':', e); }
            }
          }
          if (res.isContainer(id)) apply(contents[id]);
        });
      }
      apply(res.topLevel);
      graph.endUpdate();
    }

    runPass();
    runPass(); // second pass re-reads live bounds (now-resized enclosures)

    // Post-layout render refresh: children were moved with translateVertices,
    // but the enclosure's internal rendering only settles after a collapse/
    // expand cycle (user-verified: manually closing and reopening the
    // enclosure "fixes the form"). Mimic that exact cycle programmatically on
    // every open enclosure.
    vertices.forEach(function (v) {
      if (!memberIds(v.contents, idSet).length) return;
      if (v.cfg && v.cfg.expanded === false) return; // still collapsed: leave it
      try {
        if (typeof v.collapse === 'function' && typeof v.expand === 'function') {
          v.collapse();
          v.expand();
        }
      } catch (e) { /* non-fatal: layout already applied */ }
    });

    return {
      success: true,
      message: (label || 'Layout') + ' applied (' + direction + ')' +
        (enclosureCount ? ' — ' + enclosureCount + ' enclosure(s) nested' : ''),
      componentsArranged: vertices.length
    };
  }

  // ------------------------------------------------------------ tree layout

  /**
   * Tree layout — thin wrapper over the compound framework using the pure
   * tree positioner, so enclosures nest exactly like the hierarchical layout.
   */
  function applyTreeLayout(graph, vertices, direction, spacing) {
    return applyCompound(graph, vertices, direction, spacing, computeTreePositions, 'Tree layout');
  }

  // ------------------------------------------------------------------ UI

  var PANEL_ID = 'tm-canvas-layout-panel';
  var panelHidden = false; // set by the × button; poll respects it until reload

  function runLayout(kind, direction) {
    var viewer = getViewer();
    if (!viewer) { toast('Canvas not ready', true); return; }

    var graph = viewer.graph;
    var spacing = parseInt(document.getElementById('tm-layout-spacing').value, 10) || 60;
    var vertices = collectVertices(graph);

    var result;
    try {
      result = kind === 'tree'
        ? applyTreeLayout(graph, vertices, direction, spacing)
        : applyHierarchicalLayout(graph, vertices, direction, spacing);
    } catch (e) {
      console.error('[canvas-layout]', e);
      toast('Layout failed: ' + e.message, true);
      return;
    }

    if (result.success) {
      fitAndCenter(viewer, vertices);
      toast(result.message + ' — ' + result.componentsArranged + ' shapes');
    } else {
      toast(result.message, true);
    }
  }

  function toast(msg, isError) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText =
      'position:fixed;bottom:70px;right:16px;z-index:2147483647;' +
      'padding:8px 14px;border-radius:6px;font:12px/1.4 sans-serif;color:#fff;' +
      'background:' + (isError ? '#c0392b' : '#27ae60') + ';' +
      'box-shadow:0 2px 8px rgba(0,0,0,.3);opacity:.95;';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2500);
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return;

    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText =
      'position:fixed;bottom:16px;right:16px;z-index:2147483647;' +
      'display:flex;align-items:center;gap:6px;padding:6px 8px;' +
      'background:#2c3e50;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);' +
      'font:12px sans-serif;color:#ecf0f1;';

    var btnStyle =
      'padding:4px 8px;border:none;border-radius:4px;cursor:pointer;' +
      'background:#3498db;color:#fff;font:11px sans-serif;white-space:nowrap;';

    function mkBtn(label, title, onClick) {
      var b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.style.cssText = btnStyle;
      b.addEventListener('click', onClick);
      return b;
    }

    var label = document.createElement('span');
    label.textContent = 'Layout:';
    label.style.cssText = 'font-weight:bold;';
    panel.appendChild(label);

    panel.appendChild(mkBtn('Hier →', 'Hierarchical, left-to-right',
      function () { runLayout('hier', 'horizontal'); }));
    panel.appendChild(mkBtn('Hier ↓', 'Hierarchical, top-to-bottom',
      function () { runLayout('hier', 'vertical'); }));
    panel.appendChild(mkBtn('Tree →', 'Tree, left-to-right',
      function () { runLayout('tree', 'horizontal'); }));
    panel.appendChild(mkBtn('Tree ↓', 'Tree, top-to-bottom',
      function () { runLayout('tree', 'vertical'); }));

    var spacing = document.createElement('input');
    spacing.id = 'tm-layout-spacing';
    spacing.type = 'number';
    spacing.value = '60';
    spacing.min = '10';
    spacing.max = '500';
    spacing.title = 'Spacing (px)';
    spacing.style.cssText =
      'width:48px;padding:3px 4px;border:none;border-radius:4px;font:11px sans-serif;';
    panel.appendChild(spacing);

    var fitBtn = mkBtn('Fit', 'Zoom to fit + center', function () {
      var viewer = getViewer();
      if (!viewer) { toast('Canvas not ready', true); return; }
      fitAndCenter(viewer, collectVertices(viewer.graph));
    });
    fitBtn.style.background = '#7f8c8d';
    panel.appendChild(fitBtn);

    var hideBtn = mkBtn('×', 'Hide panel (until page reload)', function () {
      panelHidden = true; // stop the poll from resurrecting it
      panel.remove();
    });
    hideBtn.style.cssText = btnStyle + 'background:transparent;font-size:14px;padding:2px 4px;';
    panel.appendChild(hideBtn);

    document.body.appendChild(panel);
    console.log('[canvas-layout] panel attached');
  }

  // Attach only in the frame that owns the strategy canvas. Viewer appears
  // after async load and can be torn down/recreated on tab switches, so keep
  // polling: add the panel when a viewer exists, drop it when it goes away.
  setInterval(function () {
    if (panelHidden) return;
    var viewer = getViewer();
    var panel = document.getElementById(PANEL_ID);
    if (viewer && !panel && document.querySelector('.gfw-canvas svg')) {
      buildPanel();
    }
  }, 1500);

  // Exposed so the layout math can be unit-tested off-DOM (node/console).
  try {
    window.__pcalCompute = computeLayeredPositions;
    window.__pcalTree = computeTreePositions;
    window.__pcalCompound = computeCompoundLayout;
    window.__pcalApply = applyCompound;
  } catch (e) { /* ignore */ }
})();
