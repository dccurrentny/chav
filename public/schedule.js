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
    skewMs: 0,          // server clock minus this browser's clock
    ticker: null,
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

  /* ------------------------------------------------------------- clocks */

  // The portal's clock, not the laptop's. A browser several minutes out would
  // otherwise show a shift ending at the wrong time, which is the one number
  // on this page people are going to act on.
  function nowMs() { return Date.now() + sched.skewMs; }

  // How far the customer's timezone is from UTC at a given instant. Everything
  // on this page is in their zone, whatever zone the browser happens to be in.
  function tzOffset(tz, date) {
    var p = {};
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    var asUtc = Date.UTC(+p.year, +p.month - 1, +p.day,
      p.hour === '24' ? 0 : +p.hour, +p.minute, +p.second);
    return asUtc - date.getTime();
  }

  // 'YYYY-MM-DDTHH:MM' as read on a clock in the customer's zone -> an instant.
  function wallToInstant(wall, tz) {
    var naive = new Date(wall + ':00Z');
    if (isNaN(naive)) return null;
    var off = tzOffset(tz, naive);
    var t = naive.getTime() - off;
    // One correction: an entry inside a DST shift lands on the wrong offset
    // first time round.
    var off2 = tzOffset(tz, new Date(t));
    if (off2 !== off) t = naive.getTime() - off2;
    return new Date(t);
  }

  // An instant -> 'YYYY-MM-DDTHH:MM' on a clock in the customer's zone, which
  // is what a datetime-local input wants.
  function instantToWall(date, tz) {
    var shifted = new Date(date.getTime() + tzOffset(tz, date));
    return shifted.toISOString().slice(0, 16);
  }

  function fmtTime(date, tz) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', minute: '2-digit',
    }).format(date);
  }

  function fmtWhen(date, tz) {
    var today = instantToWall(new Date(nowMs()), tz).slice(0, 10);
    var wall = instantToWall(date, tz);
    var stamp = fmtTime(date, tz);
    if (wall.slice(0, 10) === today) return 'today ' + stamp;
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    }).format(date) + ' ' + stamp;
  }

  // "2h 15m", "45m", "under a minute" — no seconds, because a shift is not a
  // stopwatch and a ticking seconds counter reads as an alarm.
  function humanLeft(ms) {
    if (ms <= 0) return 'now';
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return 'under a minute';
    var days = Math.floor(mins / 1440);
    var hours = Math.floor((mins % 1440) / 60);
    var rem = mins % 60;
    if (days) return days + 'd ' + hours + 'h';
    if (hours) return hours + 'h ' + pad2(rem) + 'm';
    return rem + 'm';
  }

  /* -------------------------------------------------------------- render */

  window.renderSchedule = async function (host, api, onError) {
    host.innerHTML = '<div class="empty">Loading the schedule…</div>';
    if (sched.ticker) { clearInterval(sched.ticker); sched.ticker = null; }
    try {
      sched.data = await api('/api/schedule');
      if (sched.data.serverNow) {
        sched.skewMs = new Date(sched.data.serverNow).getTime() - Date.now();
      }
      draw(host, api, onError);
    } catch (err) {
      onError(host, err);
    }
  };

  function draw(host, api, onError) {
    var d = sched.data;
    var now = d.now || { day: -1, hour: -1 };

    host.innerHTML =
      onNowCard(d) +

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

      overrideCard(d) +

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
    startTicker(host, api, onError);
  }

  // The one thing someone glancing at this page wants to know: who is on, and
  // for how much longer.
  function onNowCard(d) {
    var cur = d.current;
    var chip = cur
      ? '<span class="on-dot" style="background:' + h(cur.colour || '#2F6FED') + '"></span>' +
        '<b>' + h(cur.name || cur.target) + '</b>' +
        (cur.name ? '<span class="num on-target">' + h(cur.target) + '</span>' : '')
      : '<span class="on-dot on-dot-none"></span><b>Nobody scheduled</b>';

    var badge = cur && cur.source === 'override'
      ? '<span class="tag tag-override">temporary override</span>' : '';
    if (cur && cur.source === 'override-none') badge = '<span class="tag tag-override">override: no one</span>';

    return '<div class="card on-now' + (cur ? '' : ' on-now-empty') + '">' +
      '<div class="on-head">' + chip + badge + '</div>' +
      '<div class="on-left" id="onLeft"></div>' +
      '<div class="on-next" id="onNext"></div>' +
    '</div>';
  }

  // Filled by the ticker so the number stays true without reloading the page.
  function paintLeft(host) {
    var d = sched.data;
    var left = host.querySelector('#onLeft');
    var nextEl = host.querySelector('#onNext');
    if (!left) return false;

    if (!d.until) {
      left.textContent = d.current ? 'On until further notice — nothing else is scheduled.' : '';
      if (nextEl) nextEl.textContent = '';
      return false;
    }

    var until = new Date(d.until);
    var ms = until.getTime() - nowMs();
    if (ms <= 0) return true;    // tell the caller to reload: the shift turned over

    left.innerHTML = d.current
      ? 'On for another <b>' + h(humanLeft(ms)) + '</b>, until ' +
        h(fmtWhen(until, d.timezone))
      : 'Nothing scheduled for another <b>' + h(humanLeft(ms)) + '</b>';

    if (nextEl) {
      nextEl.innerHTML = d.next && d.next.name
        ? 'Then <b>' + h(d.next.name) + '</b> ' +
          '<span class="num">' + h(d.next.target) + '</span> takes over.'
        : 'Then nobody is scheduled.';
    }
    return false;
  }

  function startTicker(host, api, onError) {
    if (sched.ticker) clearInterval(sched.ticker);
    paintLeft(host);
    sched.ticker = setInterval(function () {
      // Gone from the page (the customer navigated away) — stop.
      if (!document.body.contains(host)) { clearInterval(sched.ticker); sched.ticker = null; return; }
      // Never reload on top of unsaved paint.
      if (paintLeft(host) && !sched.dirty) window.renderSchedule(host, api, onError);
    }, 15000);
  }

  /* ----------------------------------------------------------- overrides */

  function overrideCard(d) {
    var opts = d.destinations.map(function (x) {
      return '<option value="' + h(x.id) + '">' + h(x.name) + ' — ' + h(x.target) + '</option>';
    }).join('');

    var startWall = instantToWall(new Date(nowMs()), d.timezone);
    var endWall = instantToWall(new Date(nowMs() + 2 * 3600_000), d.timezone);

    return '<div class="card">' +
      '<h2>Just for now</h2>' +
      '<p class="desc">Send calls somewhere else for a few hours or a few days, ' +
        'without changing the week. When it runs out, the week takes over again ' +
        'on its own.</p>' +

      (d.destinations.length
        ? '<div class="ovr-form">' +
            '<label>Send calls to' +
              '<select id="oDest">' + opts +
                '<option value="">Nobody — leave the phone system alone</option>' +
              '</select></label>' +
            '<label>From<input id="oFrom" type="datetime-local" value="' + h(startWall) + '"></label>' +
            '<label>Until<input id="oTo" type="datetime-local" value="' + h(endWall) + '"></label>' +
            '<label class="grow">Note (optional)' +
              '<input id="oNote" maxlength="200" placeholder="e.g. Yossi at a chasunah"></label>' +
            '<button class="btn" id="oAdd">Set override</button>' +
          '</div>' +
          '<div class="ovr-quick">' +
            '<span class="paint-label">Until</span>' +
            '<button class="quick" data-hours="1">+1 hour</button>' +
            '<button class="quick" data-hours="2">+2 hours</button>' +
            '<button class="quick" data-hours="4">+4 hours</button>' +
            '<button class="quick" data-eod="1">end of today</button>' +
            '<button class="quick" data-eod="2">end of tomorrow</button>' +
          '</div>'
        : '<div class="empty" style="padding:8px 0">Add someone above first.</div>') +

      '<div id="ovrErr"></div>' +
      overrideList(d) +
    '</div>';
  }

  function overrideList(d) {
    if (!d.overrides || !d.overrides.length) {
      return '<div class="empty" style="padding:10px 0 2px">Nothing overridden — the week is running as set.</div>';
    }
    var now = nowMs();
    return '<ul class="ovr-list">' + d.overrides.map(function (o) {
      var from = new Date(o.starts_at), to = new Date(o.ends_at);
      var live = from.getTime() <= now && now < to.getTime();
      return '<li class="ovr' + (live ? ' ovr-live' : '') + '">' +
        '<span class="dest-dot" style="background:' +
          h(o.destination_id ? (o.colour || '#2F6FED') : '#98A2B3') + '"></span>' +
        '<span class="ovr-body">' +
          '<b>' + h(o.destination_id ? o.destination_name : 'Nobody') + '</b>' +
          (o.destination_id ? ' <span class="num">' + h(o.target) + '</span>' : '') +
          '<span class="ovr-when">' + h(fmtWhen(from, d.timezone)) + ' → ' +
            h(fmtWhen(to, d.timezone)) + '</span>' +
          (o.note ? '<span class="ovr-note">' + h(o.note) + '</span>' : '') +
        '</span>' +
        (live ? '<span class="tag tag-live">on now</span>' : '<span class="tag">upcoming</span>') +
        '<button class="dest-x" data-ovrdel="' + h(o.id) + '" title="Cancel">&times;</button>' +
      '</li>';
    }).join('') + '</ul>';
  }

  /* ---------------------------------------------------------- week grid */

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
    var live = d.applied.target;
    var matches = d.current && d.current.target === live;
    return '<div class="applied' + (matches ? '' : ' applied-stale') + '">' +
      'Calls are going to <b>' + h(live || 'nowhere set') + '</b>' +
      (d.current && d.current.name ? ' (' + h(d.current.name) + ')' : '') +
      (matches ? '' : ' — the schedule has changed and is being applied') + '.</div>';
  }

  function renderDests(host) {
    var row = host.querySelector('#destRow');
    var cur = sched.data.current;
    if (!sched.data.destinations.length) {
      row.innerHTML = '<div class="empty" style="padding:8px 0">No one added yet.</div>';
      return;
    }
    row.innerHTML = sched.data.destinations.map(function (x) {
      var on = cur && cur.target === x.target;
      return '<span class="dest' + (on ? ' dest-on' : '') + '">' +
        '<span class="dest-dot" style="background:' + h(x.colour) + '"></span>' +
        '<span><b>' + h(x.name) + '</b><span class="dest-target num">' + h(x.target) + '</span></span>' +
        (on ? '<span class="tag tag-live">on now</span>' : '') +
        '<button class="dest-x" data-del="' + h(x.id) + '" title="Remove">&times;</button>' +
      '</span>';
    }).join('');
  }

  /* ----------------------------------------------------------- wiring */

  function wire(host, api, onError) {
    var saveBtn = host.querySelector('#schSave');

    function markDirty() {
      sched.dirty = true;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }

    function fail(sel, err) {
      host.querySelector(sel).innerHTML =
        '<div class="alert alert-err" style="margin-top:10px">' + h(err.message) + '</div>';
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
        fail('#destErr', err);
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
          fail('#destErr', err);
        }
      });
    });

    // ---- overrides ----
    var oAdd = host.querySelector('#oAdd');
    if (oAdd) {
      host.querySelectorAll('.quick').forEach(function (b) {
        b.addEventListener('click', function () {
          var tz = sched.data.timezone;
          var from = wallToInstant(host.querySelector('#oFrom').value, tz) || new Date(nowMs());
          var to;
          if (b.dataset.hours) {
            to = new Date(from.getTime() + Number(b.dataset.hours) * 3600_000);
          } else {
            // End of today or tomorrow means midnight on the customer's clock,
            // not on the browser's.
            var day = instantToWall(from, tz).slice(0, 10);
            var midnight = wallToInstant(day + 'T00:00', tz);
            to = new Date(midnight.getTime() + Number(b.dataset.eod) * 86400_000);
            // Re-anchor across a DST change so it is still midnight.
            to = wallToInstant(instantToWall(to, tz).slice(0, 10) + 'T00:00', tz);
          }
          host.querySelector('#oTo').value = instantToWall(to, tz);
        });
      });

      oAdd.addEventListener('click', async function () {
        var tz = sched.data.timezone;
        var from = wallToInstant(host.querySelector('#oFrom').value, tz);
        var to = wallToInstant(host.querySelector('#oTo').value, tz);
        if (!from || !to) return fail('#ovrErr', { message: 'Pick a start and an end.' });
        if (to <= from) return fail('#ovrErr', { message: 'The override has to end after it starts.' });

        oAdd.disabled = true;
        try {
          await api('/api/schedule/overrides', { method: 'POST', body: {
            destinationId: host.querySelector('#oDest').value || null,
            startsAt: from.toISOString(),
            endsAt: to.toISOString(),
            note: host.querySelector('#oNote').value.trim() || undefined,
          } });
          window.renderSchedule(host, api, onError);
        } catch (err) {
          fail('#ovrErr', err);
          oAdd.disabled = false;
        }
      });
    }

    host.querySelectorAll('[data-ovrdel]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Cancel this override?\n\nThe week takes over again straight away.')) return;
        try {
          await api('/api/schedule/overrides/' + b.dataset.ovrdel, { method: 'DELETE' });
          window.renderSchedule(host, api, onError);
        } catch (err) {
          fail('#ovrErr', err);
        }
      });
    });

    // ---- saving ----
    saveBtn.addEventListener('click', async function () {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api('/api/schedule/grid', { method: 'PUT', body: { grid: sched.data.grid } });
        sched.dirty = false;
        saveBtn.textContent = 'Saved';
        // Reload so the "calls are going to" line reflects what was applied.
        setTimeout(function () { window.renderSchedule(host, api, onError); }, 700);
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
        fail('#schErr', err);
      }
    });

    // Leaving with unsaved paint loses it, which is worth one interruption.
    window.onbeforeunload = function () {
      if (sched.dirty) return 'Your schedule has not been saved.';
    };
  }
})();
