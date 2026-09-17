// The dispatch schedule: who answers the phone in each hour of the week.
//
// Loaded by app.js when the customer has the schedule feature. Kept separate
// because it is the one screen with real interaction, and the rest of the
// portal stays small without it.
(function () {
  'use strict';

  var sched = {
    data: null,
    painting: null,     // destination id being painted, or null for "unassign"
    dragging: false,
    dirty: false,
  };

  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function destById(id) {
    if (!id || !sched.data) return null;
    for (var i = 0; i < sched.data.destinations.length; i++) {
      if (sched.data.destinations[i].id === id) return sched.data.destinations[i];
    }
    return null;
  }

  // Readable ink on an arbitrary brand colour, so a pale dispatcher colour
  // does not produce an unreadable cell.
  function ink(hex) {
    var n = parseInt(String(hex).slice(1), 16);
    var c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) > 0.45 ? '#101828' : '#FFFFFF';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  window.renderSchedule = async function (host, api, onError) {
    host.innerHTML = '<div class="empty">Loading the schedule…</div>';
    try {
      sched.data = await api('/api/schedule');
      draw(host, api, onError);
    } catch (err) {
      onError(host, err);
    }
  };

  function draw(host, api, onError) {
    var d = sched.data;
    var now = d.now || { day: -1, hour: -1 };

    host.innerHTML =
      '<div class="card">' +
        '<h2>Who answers the phone</h2>' +
        '<p class="desc">The people and numbers calls can go to. Add one, then ' +
          'paint the hours below.</p>' +
        '<div class="dest-row" id="destRow"></div>' +
        '<div class="dest-add">' +
          '<input id="dName" placeholder="Name, e.g. Yossi" maxlength="60">' +
          '<input id="dTarget" placeholder="Extension or number">' +
          '<input id="dColour" type="color" value="#2F6FED" title="Colour on the grid">' +
          '<button class="btn" id="dAdd">Add</button>' +
        '</div>' +
        '<div id="destErr"></div>' +
      '</div>' +

      '<div class="card">' +
        '<div class="sched-head">' +
          '<div><h2>The week</h2>' +
            '<p class="desc" style="margin:0">Click or drag to paint. Times are ' +
            h(d.timezone) + '.</p></div>' +
          '<div class="grow"></div>' +
          '<button class="btn" id="schSave" disabled>Save</button>' +
        '</div>' +
        paintbar(d) +
        '<div class="grid-scroll">' + gridTable(d, now) + '</div>' +
        appliedNote(d) +
        '<div id="schErr"></div>' +
      '</div>';

    renderDests(host);
    wire(host, api, onError);
  }

  function paintbar(d) {
    var swatches = d.destinations.map(function (x) {
      return '<button class="paint" data-paint="' + h(x.id) + '" ' +
        'style="background:' + h(x.colour) + ';color:' + ink(x.colour) + '">' +
        h(x.name) + '</button>';
    }).join('');
    return '<div class="paintbar">' +
      '<span class="paint-label">Paint with</span>' + swatches +
      '<button class="paint paint-none" data-paint="">Leave alone</button>' +
      '<span class="paint-hint" id="paintHint">pick one, then drag across the grid</span>' +
    '</div>';
  }

  function gridTable(d, now) {
    var head = '<thead><tr><th></th>';
    for (var hh = 0; hh < 24; hh++) head += '<th>' + pad2(hh) + '</th>';
    head += '</tr></thead>';

    var body = '<tbody>';
    for (var day = 0; day < 7; day++) {
      body += '<tr><th scope="row">' + h(d.days[day]) + '</th>';
      for (var hour = 0; hour < 24; hour++) {
        var dest = destById(d.grid[day][hour]);
        var isNow = day === now.day && hour === now.hour;
        body += '<td class="cell' + (isNow ? ' now' : '') + (dest ? '' : ' unset') + '"' +
          ' data-day="' + day + '" data-hour="' + hour + '"' +
          (dest ? ' style="background:' + h(dest.colour) + ';color:' + ink(dest.colour) + '"' : '') +
          ' title="' + h(d.days[day]) + ' ' + pad2(hour) + ':00 — ' +
            (dest ? h(dest.name) : 'not scheduled') + '">' +
          (dest ? h(dest.name.slice(0, 2)) : '') + '</td>';
      }
      body += '</tr>';
    }
    return '<table class="sched">' + head + body + '</tbody></table>';
  }

  // What the phone system is actually set to, which is not always what the
  // grid says: the engine may have failed, or not caught up yet.
  function appliedNote(d) {
    if (!d.applied) {
      return '<div class="applied">Nothing has been applied to the phone system yet.</div>';
    }
    if (d.applied.lastError) {
      return '<div class="alert alert-err" style="margin-top:14px">' +
        'The phone system could not be updated: ' + h(d.applied.lastError) +
        '. It will be retried automatically.</div>';
    }
    var currentDest = destById(d.grid[d.now.day] && d.grid[d.now.day][d.now.hour]);
    var live = d.applied.target;
    var matches = currentDest && currentDest.target === live;
    return '<div class="applied' + (matches ? '' : ' applied-stale') + '">' +
      'Calls are going to <b>' + h(live || 'nowhere set') + '</b>' +
      (currentDest ? ' (' + h(currentDest.name) + ')' : '') +
      (matches ? '' : ' — the schedule has changed and is being applied') + '.</div>';
  }

  function renderDests(host) {
    var row = host.querySelector('#destRow');
    if (!sched.data.destinations.length) {
      row.innerHTML = '<div class="empty" style="padding:8px 0">No one added yet.</div>';
      return;
    }
    row.innerHTML = sched.data.destinations.map(function (x) {
      return '<span class="dest">' +
        '<span class="dest-dot" style="background:' + h(x.colour) + '"></span>' +
        '<span><b>' + h(x.name) + '</b><span class="dest-target num">' + h(x.target) + '</span></span>' +
        '<button class="dest-x" data-del="' + h(x.id) + '" title="Remove">&times;</button>' +
      '</span>';
    }).join('');
  }

  function wire(host, api, onError) {
    var saveBtn = host.querySelector('#schSave');

    function markDirty() {
      sched.dirty = true;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }

    // ---- paint selection ----
    host.querySelectorAll('[data-paint]').forEach(function (b) {
      b.addEventListener('click', function () {
        sched.painting = b.dataset.paint || null;
        host.querySelectorAll('[data-paint]').forEach(function (x) {
          x.classList.toggle('picked', x === b);
        });
        var hint = host.querySelector('#paintHint');
        if (hint) hint.textContent = 'now drag across the grid';
      });
    });

    // ---- painting cells ----
    function paintCell(td) {
      if (sched.painting === undefined) return;
      var day = Number(td.dataset.day), hour = Number(td.dataset.hour);
      sched.data.grid[day][hour] = sched.painting;
      var dest = destById(sched.painting);
      td.className = 'cell' + (dest ? '' : ' unset') +
        (td.classList.contains('now') ? ' now' : '');
      td.style.background = dest ? dest.colour : '';
      td.style.color = dest ? ink(dest.colour) : '';
      td.textContent = dest ? dest.name.slice(0, 2) : '';
      markDirty();
    }

    host.querySelectorAll('td.cell').forEach(function (td) {
      td.addEventListener('mousedown', function (e) {
        e.preventDefault();
        if (sched.painting === undefined) return;
        sched.dragging = true;
        paintCell(td);
      });
      td.addEventListener('mouseenter', function () {
        if (sched.dragging) paintCell(td);
      });
    });
    document.addEventListener('mouseup', function () { sched.dragging = false; });

    // ---- destinations ----
    var addBtn = host.querySelector('#dAdd');
    addBtn.addEventListener('click', async function () {
      var name = host.querySelector('#dName').value.trim();
      var target = host.querySelector('#dTarget').value.trim();
      var colour = host.querySelector('#dColour').value;
      if (!name || !target) return;
      addBtn.disabled = true;
      try {
        await api('/api/schedule/destinations', { method: 'POST',
          body: { name: name, target: target, colour: colour } });
        window.renderSchedule(host, api, onError);
      } catch (err) {
        host.querySelector('#destErr').innerHTML =
          '<div class="alert alert-err" style="margin-top:10px">' + h(err.message) + '</div>';
        addBtn.disabled = false;
      }
    });

    host.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Remove this destination?\n\nAny hours set to it become unscheduled.')) return;
        try {
          await api('/api/schedule/destinations/' + b.dataset.del, { method: 'DELETE' });
          window.renderSchedule(host, api, onError);
        } catch (err) {
          host.querySelector('#destErr').innerHTML =
            '<div class="alert alert-err" style="margin-top:10px">' + h(err.message) + '</div>';
        }
      });
    });

    // ---- saving ----
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        var out = await api('/api/schedule/grid', { method: 'PUT', body: { grid: sched.data.grid } });
        sched.dirty = false;
        saveBtn.textContent = 'Saved';
        // Reload so the "calls are going to" line reflects what was applied.
        setTimeout(function () { window.renderSchedule(host, api, onError); }, 700);
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        host.querySelector('#schErr').innerHTML =
          '<div class="alert alert-err" style="margin-top:12px">' + h(err.message) + '</div>';
      }
    });

    // Leaving with unsaved paint loses it, which is worth one interruption.
    window.onbeforeunload = function () {
      if (sched.dirty) return 'Your schedule has not been saved.';
    };
  }
})();
