// ==UserScript==
// @name         Pega Strategy Canvas Auto-Layout
// @namespace    senn1.pega.tools
// @version      1.0
// @description  Adds hierarchical / tree layout buttons to the Pega strategy canvas (Dev Studio)
// @match        http://localhost:18080/prweb/*
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
    console.log('[applyHierarchicalLayout] Direction:', direction, 'Spacing:', spacing);

    if (vertices.length === 0) {
      return { success: false, message: 'No vertices to arrange' };
    }

    var isVertical = direction === 'vertical';
    var levelPadding = spacing * 1.5;
    var siblingPadding = spacing;

    var vertexById = {};
    vertices.forEach(function (v) { vertexById[v.id] = v; });

    var levels = {};
    var maxLevel = 0;

    // Roots: no incoming edges from within this vertex set
    var roots = vertices.filter(function (v) {
      var incoming = v.incoming || [];
      return !incoming.some(function (edge) {
        return edge.source && vertexById[edge.source.id];
      });
    });

    // Pure cycle: pick vertex with most outgoing edges
    if (roots.length === 0) {
      var bestRoot = vertices[0];
      var maxOutgoing = -1;
      vertices.forEach(function (v) {
        var count = (v.outgoing || []).filter(function (e) {
          return e.target && vertexById[e.target.id];
        }).length;
        if (count > maxOutgoing) { maxOutgoing = count; bestRoot = v; }
      });
      roots = [bestRoot];
    }

    // BFS longest-path layering (guarded against runaway cycles)
    var visited = {};
    var queue = [];
    roots.forEach(function (root) {
      levels[root.id] = 0;
      visited[root.id] = true;
      queue.push(root);
    });

    var guard = 0, guardMax = vertices.length * vertices.length + 100;
    while (queue.length > 0 && guard++ < guardMax) {
      var current = queue.shift();
      var currentLevel = levels[current.id];

      (current.outgoing || []).forEach(function (edge) {
        var target = edge.target;
        if (target && vertexById[target.id]) {
          if (!visited[target.id]) {
            visited[target.id] = true;
            levels[target.id] = currentLevel + 1;
            maxLevel = Math.max(maxLevel, currentLevel + 1);
            queue.push(target);
          } else {
            var newLevel = currentLevel + 1;
            if (newLevel > levels[target.id] && newLevel <= vertices.length) {
              levels[target.id] = newLevel;
              maxLevel = Math.max(maxLevel, newLevel);
              queue.push(target);
            }
          }
        }
      });
    }

    // Disconnected vertices go to level 0
    vertices.forEach(function (v) {
      if (!visited[v.id]) levels[v.id] = 0;
    });

    // Group by level
    var levelGroups = {};
    vertices.forEach(function (v) {
      var level = levels[v.id] || 0;
      (levelGroups[level] = levelGroups[level] || []).push(v);
    });

    // Barycenter sort within each level to reduce crossings
    Object.keys(levelGroups).forEach(function (level) {
      var group = levelGroups[level];
      if (group.length > 1 && parseInt(level) > 0) {
        var prevLevel = levelGroups[parseInt(level) - 1] || [];
        var prevPositions = {};
        prevLevel.forEach(function (v, idx) { prevPositions[v.id] = idx; });

        group.sort(function (a, b) {
          var aSum = 0, aCount = 0, bSum = 0, bCount = 0;
          (a.incoming || []).forEach(function (edge) {
            if (edge.source && prevPositions[edge.source.id] !== undefined) {
              aSum += prevPositions[edge.source.id]; aCount++;
            }
          });
          (b.incoming || []).forEach(function (edge) {
            if (edge.source && prevPositions[edge.source.id] !== undefined) {
              bSum += prevPositions[edge.source.id]; bCount++;
            }
          });
          return (aCount ? aSum / aCount : 0) - (bCount ? bSum / bCount : 0);
        });
      }
    });

    // Level dimensions
    var levelDimensions = {};
    var totalPrimaryDim = 0;
    var maxSecondaryDim = 0;

    Object.keys(levelGroups).forEach(function (level) {
      var group = levelGroups[level];
      var levelPrimary = 0, levelSecondary = 0;

      group.forEach(function (v, index) {
        var bounds = v.getBounds();
        if (isVertical) {
          levelSecondary += bounds.width + (index > 0 ? siblingPadding : 0);
          levelPrimary = Math.max(levelPrimary, bounds.height);
        } else {
          levelSecondary += bounds.height + (index > 0 ? siblingPadding : 0);
          levelPrimary = Math.max(levelPrimary, bounds.width);
        }
      });

      levelDimensions[level] = { primary: levelPrimary, secondary: levelSecondary };
      maxSecondaryDim = Math.max(maxSecondaryDim, levelSecondary);
    });

    Object.keys(levelDimensions).forEach(function (level, idx) {
      totalPrimaryDim += levelDimensions[level].primary + (idx > 0 ? levelPadding : 0);
    });

    var canvas = getCanvasSize();
    var startX, startY;
    if (isVertical) {
      startX = Math.max(50, (canvas.width - maxSecondaryDim) / 2);
      startY = Math.max(50, (canvas.height - totalPrimaryDim) / 2);
    } else {
      startX = Math.max(50, (canvas.width - totalPrimaryDim) / 2);
      startY = Math.max(50, (canvas.height - maxSecondaryDim) / 2);
    }

    // Position
    graph.beginUpdate();

    var currentPos = isVertical ? startY : startX;

    Object.keys(levelGroups).sort(function (a, b) { return parseInt(a) - parseInt(b); }).forEach(function (level) {
      var group = levelGroups[level];
      var groupOffset = (maxSecondaryDim - levelDimensions[level].secondary) / 2;
      var groupStart = (isVertical ? startX : startY) + groupOffset;

      group.forEach(function (v) {
        var bounds = v.getBounds();
        var newX, newY;

        if (isVertical) {
          newX = groupStart; newY = currentPos;
          groupStart += bounds.width + siblingPadding;
        } else {
          newX = currentPos; newY = groupStart;
          groupStart += bounds.height + siblingPadding;
        }

        var dx = newX - bounds.x;
        var dy = newY - bounds.y;
        if (dx !== 0 || dy !== 0) {
          graph.translateVertices(v, [dx, dy]);
        }
      });

      currentPos += levelDimensions[level].primary + levelPadding;
    });

    graph.endUpdate();

    return {
      success: true,
      message: 'Hierarchical layout applied (' + direction + ')',
      levels: maxLevel + 1,
      componentsArranged: vertices.length
    };
  }

  // ------------------------------------------------------------ tree layout

  /**
   * Tree layout - arranges vertices in a tree structure with centered children.
   * DAG-safe (one parent per vertex) and cycle-safe.
   */
  function applyTreeLayout(graph, vertices, direction, spacing) {
    console.log('[applyTreeLayout] Direction:', direction, 'Spacing:', spacing);

    if (vertices.length === 0) {
      return { success: false, message: 'No vertices to arrange' };
    }

    var isVertical = direction === 'vertical';
    var siblingPadding = spacing;

    // Level step is center-to-center, so it must clear the widest (horizontal)
    // or tallest (vertical) node — a fixed spacing*2 made wide shapes overlap
    // in left-to-right mode.
    var maxPrimaryDim = 0;
    vertices.forEach(function (v) {
      var b = v.getBounds();
      maxPrimaryDim = Math.max(maxPrimaryDim, isVertical ? b.height : b.width);
    });
    var levelPadding = maxPrimaryDim + spacing;

    var vertexById = {};
    vertices.forEach(function (v) { vertexById[v.id] = v; });

    var children = {};
    var assignedToTree = {};
    vertices.forEach(function (v) { children[v.id] = []; });

    var roots = vertices.filter(function (v) {
      var incoming = v.incoming || [];
      return !incoming.some(function (edge) {
        return edge.source && vertexById[edge.source.id];
      });
    });

    if (roots.length === 0) {
      var bestRoot = vertices[0];
      var maxOutgoing = -1;
      vertices.forEach(function (v) {
        var count = (v.outgoing || []).filter(function (e) {
          return e.target && vertexById[e.target.id];
        }).length;
        if (count > maxOutgoing) { maxOutgoing = count; bestRoot = v; }
      });
      roots = [bestRoot];
    }

    // BFS: each vertex belongs to the first parent encountered
    var queue = roots.slice();
    roots.forEach(function (root) { assignedToTree[root.id] = true; });

    while (queue.length > 0) {
      var current = queue.shift();
      (current.outgoing || []).forEach(function (edge) {
        var target = edge.target;
        if (target && vertexById[target.id] && !assignedToTree[target.id]) {
          assignedToTree[target.id] = true;
          children[current.id].push(target);
          queue.push(target);
        }
      });
    }

    // Disconnected vertices become extra roots
    vertices.forEach(function (v) {
      if (!assignedToTree[v.id]) {
        assignedToTree[v.id] = true;
        roots.push(v);
      }
    });

    // Subtree widths with cycle protection
    var subtreeWidth = {};
    var calculating = {};

    function calcSubtreeWidth(v) {
      if (subtreeWidth[v.id] !== undefined) return subtreeWidth[v.id];
      if (calculating[v.id]) {
        var b = v.getBounds();
        return isVertical ? b.width : b.height;
      }
      calculating[v.id] = true;

      var childList = children[v.id] || [];
      if (childList.length === 0) {
        var bounds = v.getBounds();
        subtreeWidth[v.id] = isVertical ? bounds.width : bounds.height;
      } else {
        var totalWidth = 0;
        childList.forEach(function (child) {
          totalWidth += calcSubtreeWidth(child) + siblingPadding;
        });
        totalWidth -= siblingPadding;
        subtreeWidth[v.id] = Math.max(totalWidth,
          isVertical ? v.getBounds().width : v.getBounds().height);
      }

      calculating[v.id] = false;
      return subtreeWidth[v.id];
    }

    roots.forEach(function (root) { calcSubtreeWidth(root); });

    graph.beginUpdate();

    var positioned = {};

    function positionSubtree(v, x, y, level) {
      if (positioned[v.id]) return;
      positioned[v.id] = true;

      var bounds = v.getBounds();
      var dx = x - bounds.getCenterX();
      var dy = y - bounds.getCenterY();
      if (dx !== 0 || dy !== 0) {
        graph.translateVertices(v, [dx, dy]);
      }

      var childList = children[v.id] || [];
      if (childList.length === 0) return;

      var totalChildWidth = subtreeWidth[v.id];
      var childStartOffset = -totalChildWidth / 2;

      childList.forEach(function (child) {
        var childWidth = subtreeWidth[child.id] || siblingPadding;
        var childOffset = childStartOffset + childWidth / 2;

        var childX, childY;
        if (isVertical) {
          childX = x + childOffset;
          childY = y + levelPadding;
        } else {
          childX = x + levelPadding;
          childY = y + childOffset;
        }

        positionSubtree(child, childX, childY, level + 1);
        childStartOffset += childWidth + siblingPadding;
      });
    }

    var totalRootsWidth = 0;
    roots.forEach(function (root) {
      totalRootsWidth += (subtreeWidth[root.id] || spacing) + spacing * 2;
    });
    totalRootsWidth -= spacing * 2;

    var maxDepth = 0;
    function calcDepth(v, depth, visitedDepth) {
      if (visitedDepth[v.id]) return;
      visitedDepth[v.id] = true;
      maxDepth = Math.max(maxDepth, depth);
      (children[v.id] || []).forEach(function (child) {
        calcDepth(child, depth + 1, visitedDepth);
      });
    }
    var depthVisited = {};
    roots.forEach(function (root) { calcDepth(root, 0, depthVisited); });

    var totalPrimaryDim = maxDepth * levelPadding + maxPrimaryDim;

    var canvas = getCanvasSize();
    var startX, startY;
    if (isVertical) {
      startX = Math.max(100, canvas.width / 2);
      startY = Math.max(80, (canvas.height - totalPrimaryDim) / 2);
    } else {
      startX = Math.max(80, (canvas.width - totalPrimaryDim) / 2);
      startY = Math.max(100, canvas.height / 2);
    }

    var rootOffset = -totalRootsWidth / 2;

    roots.forEach(function (root) {
      var rootWidth = subtreeWidth[root.id] || spacing;
      if (isVertical) {
        positionSubtree(root, startX + rootOffset + rootWidth / 2, startY, 0);
      } else {
        positionSubtree(root, startX, startY + rootOffset + rootWidth / 2, 0);
      }
      rootOffset += rootWidth + spacing * 2;
    });

    graph.endUpdate();

    return {
      success: true,
      message: 'Tree layout applied (' + direction + ')',
      roots: roots.length,
      componentsArranged: vertices.length
    };
  }

  // ------------------------------------------------------------------ UI

  var PANEL_ID = 'tm-canvas-layout-panel';

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

    var hideBtn = mkBtn('×', 'Hide panel', function () { panel.remove(); });
    hideBtn.style.cssText = btnStyle + 'background:transparent;font-size:14px;padding:2px 4px;';
    panel.appendChild(hideBtn);

    document.body.appendChild(panel);
    console.log('[canvas-layout] panel attached');
  }

  // Attach only in the frame that owns the strategy canvas. Viewer appears
  // after async load and can be torn down/recreated on tab switches, so keep
  // polling: add the panel when a viewer exists, drop it when it goes away.
  setInterval(function () {
    var viewer = getViewer();
    var panel = document.getElementById(PANEL_ID);
    if (viewer && !panel && document.querySelector('.gfw-canvas svg')) {
      buildPanel();
    }
  }, 1500);
})();
