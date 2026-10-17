/* Diario — journal → corrections → Anki cards. Everything is stored on this device (localStorage). */
(function () {
  "use strict";

  // ---------- storage ----------
  var KEY = "diario.v1";
  var DEFAULT_SETTINGS = { passcode: "", deckName: "Español", nCards: 5, level: "B1", feedbackLang: "en" };

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || "{}");
      return {
        entries: s.entries || [],
        settings: Object.assign({}, DEFAULT_SETTINGS, s.settings || {}),
        known: s.known || [],
        draft: s.draft || ""
      };
    } catch (e) {
      return { entries: [], settings: Object.assign({}, DEFAULT_SETTINGS), known: [], draft: "" };
    }
  }
  var state = load();
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { alert("No se pudo guardar: " + e.message); }
  }
  // Ask Safari not to clear our data
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function todayKey(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function niceDate(key) {
    var p = key.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var t = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
    return t.charAt(0).toUpperCase() + t.slice(1);
  }
  function countWords(t) { return (t.trim().match(/\S+/g) || []).length; }

  function streak() {
    var days = {};
    state.entries.forEach(function (e) { days[e.date] = true; });
    var n = 0, d = new Date();
    if (!days[todayKey(d)]) d.setDate(d.getDate() - 1); // streak still alive if you haven't written yet today
    while (days[todayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  // ---------- header ----------
  function renderHeader() {
    $("today").textContent = niceDate(todayKey());
    var s = streak();
    $("streak").textContent = s ? s + (s === 1 ? " día seguido" : " días seguidos") : "";
  }

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () { showView(btn.dataset.view); });
  });
  function showView(name) {
    document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b.dataset.view === name); });
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + name); });
    if (name === "history") renderHistory();
    if (name === "settings") renderSettings();
    if (name !== "write") hideExportBar();
    else if (currentEntry && currentStep === 3) showExportBar(currentEntry);
    window.scrollTo(0, 0);
  }

  // ---------- writing ----------
  var entryEl = $("entry");
  entryEl.value = state.draft;
  updateWordCount();
  entryEl.addEventListener("input", function () {
    state.draft = entryEl.value;
    save();
    updateWordCount();
  });
  function updateWordCount() {
    var n = countWords(entryEl.value);
    $("wordcount").textContent = n + (n === 1 ? " palabra" : " palabras");
  }

  $("btn-correct").addEventListener("click", submitEntry);

  function showError(msg) { var el = $("error"); el.textContent = msg; el.classList.remove("hidden"); }
  function clearError() { $("error").classList.add("hidden"); }

  async function submitEntry() {
    var text = entryEl.value.trim();
    clearError();
    if (countWords(text) < 5) { showError("Escribe un poco más primero."); return; }
    if (!state.settings.passcode) {
      showView("settings");
      $("settings-saved").textContent = "Primero pon tu código de acceso.";
      $("set-passcode").focus();
      return;
    }
    $("btn-correct").disabled = true;
    $("loading").classList.remove("hidden");
    $("result").innerHTML = "";
    try {
      var resp = await fetch("/api/correct", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-passcode": state.settings.passcode },
        body: JSON.stringify({
          text: text,
          nCards: state.settings.nCards,
          level: state.settings.level,
          feedbackLang: state.settings.feedbackLang,
          knownWords: state.known
        })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        if (resp.status === 401) throw new Error("Código de acceso incorrecto (Ajustes).");
        throw new Error(data.error || ("Error " + resp.status));
      }
      var entry = {
        id: Date.now(),
        date: todayKey(),
        text: text,
        result: data,
        selected: (data.cards || []).map(function () { return true; }),
        exportedAt: null
      };
      state.entries.push(entry);
      state.draft = "";
      save();
      entryEl.value = "";
      updateWordCount();
      renderHeader();
      openEntry(entry);
    } catch (e) {
      showError(e.message || String(e));
    } finally {
      $("btn-correct").disabled = false;
      $("loading").classList.add("hidden");
    }
  }

  // ---------- result: step 2 (review) and step 3 (cards) ----------
  var currentEntry = null;
  var currentStep = 1;

  function renderStepper() {
    var labels = ["Escribir", "Revisión", "Tarjetas"];
    var html = "";
    labels.forEach(function (label, i) {
      var n = i + 1;
      var cls = "step" + (n === currentStep ? " active" : "") + (n < currentStep ? " done" : "");
      var disabled = n > 1 && !currentEntry ? " disabled" : "";
      html += '<button class="' + cls + '" data-step="' + n + '"' + disabled + '><span class="n">' + (n < currentStep ? "✓" : n) +
        "</span>" + label + "</button>";
    });
    $("stepper").innerHTML = html;
    $("stepper").querySelectorAll(".step").forEach(function (b) {
      b.addEventListener("click", function () {
        var n = +b.dataset.step;
        if (n === 1) closeEntry();
        else if (currentEntry) goStep(n);
      });
    });
  }

  function openEntry(entry) {
    currentEntry = entry;
    showView("write");
    prepareApkg(entry);
    goStep(2);
  }

  function goStep(n) {
    currentStep = n;
    $("composer").classList.toggle("hidden", n !== 1);
    renderStepper();
    if (n === 2) { renderReview(currentEntry); hideExportBar(); }
    if (n === 3) { renderCards(currentEntry); showExportBar(currentEntry); }
    window.scrollTo(0, 0);
  }

  function closeEntry() {
    currentEntry = null;
    currentStep = 1;
    $("result").innerHTML = "";
    $("composer").classList.remove("hidden");
    hideExportBar();
    renderStepper();
  }

  function renderReview(entry) {
    var r = entry.result || {};
    var html = '<p class="muted" style="margin:0 0 12px">' + esc(niceDate(entry.date)) + "</p>";

    if (r.summary) html += '<div class="panel"><p class="summary" style="margin:0">' + esc(r.summary) + "</p></div>";

    html += '<div class="panel"><h2>Versión corregida</h2><div class="corrected">' + esc(r.corrected) + "</div>" +
      '<details style="margin-top:14px"><summary class="muted">Tu texto original</summary><div class="corrected" style="margin-top:8px;opacity:.8">' +
      esc(entry.text) + "</div></details></div>";

    var mistakes = r.mistakes || [];
    if (mistakes.length) {
      html += '<div class="panel"><h2>Errores (' + mistakes.length + ")</h2>";
      mistakes.forEach(function (m) {
        html += '<div class="mistake"><div class="pair"><del>' + esc(m.original) + "</del> → <ins>" + esc(m.correction) + "</ins>" +
          (m.category ? '<span class="chip">' + esc(m.category) + "</span>" : "") +
          '</div><div class="why">' + esc(m.explanation) + "</div></div>";
      });
      html += "</div>";
    }

    var tips = r.improvements || [];
    if (tips.length) {
      html += '<div class="panel"><h2>Para mejorar</h2><ul class="tips">' +
        tips.map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") + "</ul></div>";
    }

    // Things to look up quickly: links are built here (search pages), never invented by the AI.
    var study = r.study || [];
    if (study.length) {
      html += '<div class="panel"><h2>Para repasar hoy</h2>';
      study.forEach(function (x) {
        var q = encodeURIComponent(x.query || x.topic);
        html += '<div class="study"><div class="t">' + esc(x.topic) + "</div>" +
          (x.why ? '<div class="w">' + esc(x.why) + "</div>" : "") +
          '<a href="https://www.google.com/search?q=' + q + '" target="_blank" rel="noopener">Buscar explicación ↗</a>' +
          '<a href="https://www.youtube.com/results?search_query=' + q + '" target="_blank" rel="noopener">Video ↗</a>' +
          "</div>";
      });
      html += "</div>";
    }

    var n = ((r.cards || []).length);
    html += '<button class="primary next" id="btn-next">Siguiente: ' + n + (n === 1 ? " tarjeta" : " tarjetas") + " de hoy →</button>";

    $("result").innerHTML = html;
    $("btn-next").addEventListener("click", function () { goStep(3); });
  }

  function renderCards(entry) {
    var r = entry.result || {};
    var cards = r.cards || [];
    var html = '<div class="panel"><h2>Tarjetas de hoy</h2>' +
      '<p class="muted" style="margin:0">Frente: la frase con el hueco, tú escribes la palabra. Desmarca las que no quieras.</p>';
    cards.forEach(function (c, i) {
      var on = entry.selected ? entry.selected[i] !== false : true;
      html += '<div class="fc' + (on ? "" : " off") + '" data-i="' + i + '">' +
        '<div class="fc-head"><input type="checkbox" ' + (on ? "checked" : "") + ' data-i="' + i + '">' +
        '<div style="flex:1"><div class="fc-front">' + esc(c.sentence).replace("____", "<b>____</b>") + "</div>" +
        '<button class="fc-reveal" data-i="' + i + '">Ver reverso</button>' +
        '<div class="fc-back hidden" id="back-' + i + '">' +
        '<div class="ans">' + esc(c.answer) + "</div>" +
        "<div>" + esc(c.pos) + (c.lemma ? " · <i>" + esc(c.lemma) + "</i>" : "") + " — " + esc(c.translation) + "</div>" +
        ((c.examples || []).length ? "<ul>" + c.examples.map(function (e) { return "<li>" + esc(e) + "</li>"; }).join("") + "</ul>" : "") +
        (c.note ? '<div class="note">' + esc(c.note) + "</div>" : "") +
        "</div></div></div></div>";
    });
    if (!cards.length) html += '<p class="muted">No llegaron tarjetas esta vez.</p>';
    html += "</div>";
    html += '<button class="next" id="btn-back">← Volver a la revisión</button>';

    $("result").innerHTML = html;
    $("btn-back").addEventListener("click", function () { goStep(2); });
    $("result").querySelectorAll(".fc-reveal").forEach(function (b) {
      b.addEventListener("click", function () {
        var back = $("back-" + b.dataset.i);
        back.classList.toggle("hidden");
        b.textContent = back.classList.contains("hidden") ? "Ver reverso" : "Ocultar reverso";
      });
    });
    $("result").querySelectorAll('.fc input[type="checkbox"]').forEach(function (cb) {
      cb.addEventListener("change", function () {
        var i = +cb.dataset.i;
        if (!entry.selected) entry.selected = cards.map(function () { return true; });
        entry.selected[i] = cb.checked;
        cb.closest(".fc").classList.toggle("off", !cb.checked);
        save();
        showExportBar(entry);
        prepareApkg(entry);
      });
    });
  }

  // ---------- Anki export ----------
  var SQL_PROMISE = null;
  function getSQL() {
    if (!SQL_PROMISE) {
      SQL_PROMISE = window.initSqlJs({
        locateFile: function (f) { return "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/" + f; }
      });
    }
    return SQL_PROMISE;
  }

  var prepared = { entryId: null, key: "", file: null, url: null };
  var prepareToken = 0;

  function selectedCards(entry) {
    var cards = (entry.result && entry.result.cards) || [];
    return cards.filter(function (_, i) { return !entry.selected || entry.selected[i] !== false; });
  }

  // Build the .apkg ahead of time, so the tap on the button can open the share sheet instantly
  // (Safari only allows sharing directly inside the tap).
  async function prepareApkg(entry) {
    var cards = selectedCards(entry);
    var key = entry.id + ":" + JSON.stringify(entry.selected) + ":" + state.settings.deckName;
    if (prepared.key === key && prepared.file) return;
    var token = ++prepareToken;
    setExportStatus("Preparando…");
    try {
      if (!cards.length) { prepared = { entryId: entry.id, key: key, file: null, url: null }; setExportStatus(""); if (currentStep === 3) showExportBar(entry); return; }
      var SQL = await getSQL();
      var bytes = await window.Apkg.buildApkg({
        SQL: SQL, JSZip: window.JSZip, deckName: state.settings.deckName || "Español",
        cards: cards, tags: ["diario", "diario_" + entry.date]
      });
      if (token !== prepareToken) return; // a newer build started
      var name = "diario-" + entry.date + ".apkg";
      var file = new File([bytes], name, { type: "application/octet-stream" });
      if (prepared.url) URL.revokeObjectURL(prepared.url);
      prepared = { entryId: entry.id, key: key, file: file, url: URL.createObjectURL(file) };
      setExportStatus("");
      if (currentStep === 3) showExportBar(entry);
    } catch (e) {
      setExportStatus("No se pudo preparar el archivo: " + e.message);
    }
  }

  var bar = null;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement("div");
    bar.className = "exportbar hidden";
    bar.innerHTML = '<div class="inner"><button class="primary" id="btn-anki">Añadir a Anki</button>' +
      '<a id="lnk-download" href="#">Descargar .apkg</a></div>' +
      '<div class="muted" id="export-status" style="text-align:center;max-width:820px;margin:6px auto 0"></div>';
    document.body.appendChild(bar);
    $("btn-anki").addEventListener("click", shareToAnki);
    $("lnk-download").addEventListener("click", function (ev) {
      ev.preventDefault();
      downloadApkg();
    });
    return bar;
  }
  function setExportStatus(msg) { ensureBar(); $("export-status").textContent = msg || ""; }

  function showExportBar(entry) {
    ensureBar();
    var n = selectedCards(entry).length;
    var ready = prepared.entryId === entry.id && prepared.file;
    var btn = $("btn-anki");
    btn.disabled = !n || !ready;
    btn.textContent = n ? "Añadir " + n + (n === 1 ? " tarjeta" : " tarjetas") + " a Anki" : "Ninguna tarjeta seleccionada";
    if (entry.exportedAt) btn.textContent += " ✓";
    bar.classList.remove("hidden");
  }
  function hideExportBar() { if (bar) bar.classList.add("hidden"); }

  function markExported(entry) {
    entry.exportedAt = Date.now();
    selectedCards(entry).forEach(function (c) {
      var w = (c.lemma || c.answer || "").toLowerCase();
      if (w && state.known.indexOf(w) < 0) state.known.push(w);
    });
    save();
    showExportBar(entry);
    setExportStatus("Listo: en AnkiMobile elige “Importar”. Las tarjetas entran en «" + state.settings.deckName + "».");
  }

  async function shareToAnki() {
    var entry = currentEntry;
    if (!entry || !prepared.file) return;
    var file = prepared.file;
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: file.name });
        markExported(entry);
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return; // user closed the share sheet
        // otherwise fall back to a download
      }
    }
    downloadApkg();
  }

  function downloadApkg() {
    var entry = currentEntry;
    if (!entry || !prepared.url) return;
    var a = document.createElement("a");
    a.href = prepared.url;
    a.download = prepared.file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    markExported(entry);
    setExportStatus("Descargado. Ábrelo desde Archivos → Descargas y elige AnkiMobile.");
  }

  // ---------- history ----------
  function renderHistory() {
    var list = $("history-list");
    if (!state.entries.length) { list.innerHTML = '<p class="empty">Todavía no hay entradas. Escribe la primera hoy.</p>'; return; }
    var html = "";
    state.entries.slice().reverse().forEach(function (e) {
      var r = e.result || {};
      html += '<button class="hitem" data-id="' + e.id + '"><div class="d">' + esc(niceDate(e.date)) + "</div>" +
        '<div class="ex">' + esc(e.text.slice(0, 140)) + "</div>" +
        '<div class="badges">' + (r.mistakes || []).length + " errores · " + (r.cards || []).length + " tarjetas" +
        (e.exportedAt ? ' · <span class="done">en Anki ✓</span>' : "") + "</div></button>";
    });
    list.innerHTML = html;
    list.querySelectorAll(".hitem").forEach(function (b) {
      b.addEventListener("click", function () {
        var entry = state.entries.find(function (x) { return String(x.id) === b.dataset.id; });
        if (entry) openEntry(entry);
      });
    });
  }

  // ---------- settings ----------
  function renderSettings() {
    var s = state.settings;
    $("set-passcode").value = s.passcode;
    $("set-deck").value = s.deckName;
    $("set-ncards").value = String(s.nCards);
    $("set-level").value = s.level;
    $("set-lang").value = s.feedbackLang;
    $("known-count").textContent = state.known.length + " palabras ya enviadas a Anki (no se repetirán).";
  }
  $("btn-save-settings").addEventListener("click", function () {
    state.settings = {
      passcode: $("set-passcode").value.trim(),
      deckName: $("set-deck").value.trim() || "Español",
      nCards: parseInt($("set-ncards").value, 10) || 5,
      level: $("set-level").value,
      feedbackLang: $("set-lang").value
    };
    save();
    prepared.key = ""; // deck name may have changed
    $("settings-saved").textContent = "Guardado ✓";
    setTimeout(function () { $("settings-saved").textContent = ""; }, 2000);
  });

  $("btn-export").addEventListener("click", function () {
    var blob = new Blob([JSON.stringify(state, null, 1)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "diario-copia-" + todayKey() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
  });
  $("file-import").addEventListener("change", function (ev) {
    var f = ev.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!Array.isArray(data.entries)) throw new Error("archivo no válido");
        if (!confirm("¿Reemplazar tu diario actual por esta copia (" + data.entries.length + " entradas)?")) return;
        state = {
          entries: data.entries,
          settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
          known: data.known || [],
          draft: data.draft || ""
        };
        save();
        renderHeader(); renderSettings();
        alert("Copia restaurada.");
      } catch (e) { alert("No se pudo leer la copia: " + e.message); }
    };
    reader.readAsText(f);
  });

  // ---------- start ----------
  renderHeader();
  renderStepper();
})();
