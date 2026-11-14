/* Diario — journal → corrections → Anki cards. Everything is stored on this device (localStorage).
   Screens: home (Escribir / Hablar + streak) → entry flow (Entrada → Revisión → Tarjetas),
   plus a calendar of past entries and settings. */
(function () {
  "use strict";

  // ---------- storage ----------
  var KEY = "diario.v1";
  var DEFAULT_FOCUS = { grammar: true, verbs: true, spelling: true, vocabulary: true, style: true };
  var DEFAULT_SETTINGS = {
    passcode: "", deckName: "Español", nCards: 5, level: "B1", feedbackLang: "en",
    country: "mx", focus: Object.assign({}, DEFAULT_FOCUS)
  };

  function load() {
    try {
      var stored = JSON.parse(localStorage.getItem(KEY) || "{}");
      var settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
      // "focus" is an object, so merge it key by key (Object.assign above is shallow)
      settings.focus = Object.assign({}, DEFAULT_FOCUS, (stored.settings && stored.settings.focus) || {});
      return {
        entries: stored.entries || [],
        settings: settings,
        known: stored.known || [],
        draft: stored.draft || ""
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
    var parts = key.split("-");
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    var text = d.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  function countWords(text) { return (text.trim().match(/\S+/g) || []).length; }
  function formatClock(totalSeconds) {
    var m = Math.floor(totalSeconds / 60);
    var s = Math.floor(totalSeconds % 60);
    return m + ":" + String(s).padStart(2, "0");
  }

  // ---------- streak math ----------
  // A map "2026-11-14" -> how many entries that day. Everything streak-related reads from this.
  function entryCountByDay() {
    var days = {};
    state.entries.forEach(function (entry) { days[entry.date] = (days[entry.date] || 0) + 1; });
    return days;
  }
  function currentStreak(days) {
    var n = 0, d = new Date();
    if (!days[todayKey(d)]) d.setDate(d.getDate() - 1); // streak still alive if you haven't written yet today
    while (days[todayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function bestStreak(days) {
    var best = 0, run = 0, previous = null;
    Object.keys(days).sort().forEach(function (key) {
      var parts = key.split("-");
      var date = new Date(+parts[0], +parts[1] - 1, +parts[2]);
      var isNextDay = previous && (date - previous === 24 * 60 * 60 * 1000);
      run = isNextDay ? run + 1 : 1;
      if (run > best) best = run;
      previous = date;
    });
    return best;
  }

  // ---------- header ----------
  function renderHeader() {
    $("today").textContent = niceDate(todayKey());
    var n = currentStreak(entryCountByDay());
    $("streak").textContent = n ? n + (n === 1 ? " día seguido" : " días seguidos") : "";
  }

  // ---------- tabs ----------
  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () { showView(btn.dataset.view); });
  });
  function showView(name) {
    document.querySelectorAll(".tab").forEach(function (b) { b.classList.toggle("active", b.dataset.view === name); });
    document.querySelectorAll(".view").forEach(function (v) { v.classList.toggle("active", v.id === "view-" + name); });
    if (name === "calendar") renderCalendar();
    if (name === "settings") renderSettings();
    if (name === "today" && !flowOpen) renderStreakBoard();
    // the export bar only makes sense on the cards step of today's flow
    if (name === "today" && flowOpen && currentEntry && currentStep === 3) showExportBar(currentEntry);
    else hideExportBar();
    window.scrollTo(0, 0);
  }

  // ---------- home (two doors + streak board) ----------
  var flowOpen = false;

  function renderStreakBoard() {
    var days = entryCountByDay();
    var current = currentStreak(days);
    var best = bestStreak(days);
    var total = state.entries.length;
    var wroteToday = !!days[todayKey()];

    // one small square per day, the last 14 days, today on the right
    var dots = "";
    for (var i = 13; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      var key = todayKey(d);
      dots += '<span class="dot' + (days[key] ? " on" : "") + '" title="' + esc(key) + '"></span>';
    }

    var note = wroteToday
      ? '<div class="sb-note done">Hoy ya escribiste ✓</div>'
      : '<div class="sb-note">Aún nada hoy — una entrada mantiene la racha.</div>';

    $("streakboard").innerHTML =
      '<div class="panel sb">' +
        '<div class="sb-row">' +
          '<div class="sb-big"><span class="sb-num">' + current + '</span><span class="sb-cap">' +
            (current === 1 ? "día seguido" : "días seguidos") + '</span></div>' +
          '<div class="sb-stats">Mejor racha: ' + best + '<br>Entradas: ' + total + '</div>' +
        '</div>' +
        '<div class="sb-dots">' + dots + '</div>' + note +
      '</div>';
  }

  function showHome() {
    flowOpen = false;
    stopRecordingIfAny();
    $("home").classList.remove("hidden");
    $("flow").classList.add("hidden");
    hideExportBar();
    renderStreakBoard();
    window.scrollTo(0, 0);
  }

  // mode is "write" or "speak"; both lead to the same textarea and the same correction flow
  function openFlow(mode) {
    flowOpen = true;
    currentEntry = null;
    currentStep = 1;
    $("home").classList.add("hidden");
    $("flow").classList.remove("hidden");
    $("result").innerHTML = "";
    clearError();
    $("composer").classList.remove("hidden");
    $("micpanel").classList.toggle("hidden", mode !== "speak");
    renderStepper();
    if (mode === "write") entryEl.focus();
    window.scrollTo(0, 0);
  }

  $("btn-go-write").addEventListener("click", function () { openFlow("write"); });
  $("btn-go-speak").addEventListener("click", function () { openFlow("speak"); });
  $("btn-flow-back").addEventListener("click", showHome);

  // ---------- writing ----------
  var entryEl = $("entry");
  entryEl.value = state.draft;
  entryEl.addEventListener("input", function () {
    state.draft = entryEl.value;
    save();
    updateWordCount();
  });
  function updateWordCount() {
    var n = countWords(entryEl.value);
    $("wordcount").textContent = n + (n === 1 ? " palabra" : " palabras");
  }
  updateWordCount();

  function showError(msg) { var el = $("error"); el.textContent = msg; el.classList.remove("hidden"); }
  function clearError() { $("error").classList.add("hidden"); }

  // Settings must contain the passcode before any server call (correct or transcribe).
  function requirePasscode() {
    if (state.settings.passcode) return true;
    showView("settings");
    $("settings-saved").textContent = "Primero pon tu código de acceso.";
    $("set-passcode").focus();
    return false;
  }

  // The focus keys the student keeps switched on; an empty selection means "everything".
  function selectedFocusKeys() {
    var keys = Object.keys(DEFAULT_FOCUS).filter(function (k) { return state.settings.focus[k]; });
    return keys.length ? keys : Object.keys(DEFAULT_FOCUS);
  }

  $("btn-correct").addEventListener("click", submitEntry);

  async function submitEntry() {
    var text = entryEl.value.trim();
    clearError();
    if (countWords(text) < 5) { showError("Escribe o dicta un poco más primero."); return; }
    if (!requirePasscode()) return;
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
          country: state.settings.country,
          focus: selectedFocusKeys(),
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

  // ---------- voice recording (the "Hablar" door) ----------
  // recordingPhase: "idle" → "recording" → "busy" (encoding + transcribing) → "idle"
  var recordingPhase = "idle";
  var recordButton = $("btn-rec");

  function setRecStatus(msg) { $("rec-status").textContent = msg; }

  recordButton.addEventListener("click", function () {
    if (recordingPhase === "idle") startRecording();
    else if (recordingPhase === "recording") finishRecording();
    // "busy": ignore taps while encoding/transcribing
  });

  async function startRecording() {
    if (!requirePasscode()) return;
    recordingPhase = "busy";
    setRecStatus("Preparando el micrófono…");
    try {
      await Recorder.start({
        onTick: function (seconds) { $("rec-time").textContent = formatClock(seconds); },
        onAutoStop: finishRecording
      });
      recordingPhase = "recording";
      recordButton.classList.add("recording");
      setRecStatus("Grabando… toca otra vez para terminar (máx. 5 min).");
    } catch (e) {
      recordingPhase = "idle";
      if (e && (e.name === "NotAllowedError" || e.name === "NotFoundError")) {
        setRecStatus("Safari no dejó usar el micrófono. Revisa los permisos del sitio y vuelve a intentar.");
      } else {
        setRecStatus("No se pudo grabar: " + (e.message || e));
      }
    }
  }

  async function finishRecording() {
    if (recordingPhase !== "recording") return;
    recordingPhase = "busy";
    recordButton.classList.remove("recording");
    recordButton.disabled = true;
    setRecStatus("Transcribiendo…");
    try {
      var recorded = await Recorder.stop();
      if (recorded.seconds < 2) {
        setRecStatus("Demasiado corto. Toca el botón y cuenta tu día.");
        return;
      }
      var resp = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-passcode": state.settings.passcode },
        body: JSON.stringify({ audio: recorded.base64, format: "mp3", seconds: Math.round(recorded.seconds) })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        if (resp.status === 401) throw new Error("Código de acceso incorrecto (Ajustes).");
        throw new Error(data.error || ("Error " + resp.status));
      }
      var transcript = String(data.text || "").trim();
      if (!transcript) throw new Error("No se oyó nada claro. Prueba otra vez.");
      // append, so you can record in several takes
      entryEl.value = entryEl.value.trim() ? entryEl.value.trim() + "\n\n" + transcript : transcript;
      state.draft = entryEl.value;
      save();
      updateWordCount();
      setRecStatus("Listo ✓ Revisa el texto abajo, corrige lo que quieras y pulsa Corregir.");
    } catch (e) {
      setRecStatus(e.message || String(e));
    } finally {
      recordingPhase = "idle";
      recordButton.disabled = false;
      $("rec-time").textContent = "0:00";
    }
  }

  function stopRecordingIfAny() {
    if (recordingPhase === "recording") {
      Recorder.cancel();
      recordingPhase = "idle";
      recordButton.classList.remove("recording");
      $("rec-time").textContent = "0:00";
      setRecStatus("Grabación descartada.");
    }
  }

  // ---------- result: step 2 (review) and step 3 (cards) ----------
  var currentEntry = null;
  var currentStep = 1;

  function renderStepper() {
    var labels = ["Entrada", "Revisión", "Tarjetas"];
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
    flowOpen = true;
    showView("today");
    $("home").classList.add("hidden");
    $("flow").classList.remove("hidden");
    $("micpanel").classList.add("hidden");
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

  // "Más información" under a mistake: the rule in more depth + examples. Older entries have no "more".
  function renderMore(more) {
    if (!more || (!more.rule && !(more.examples || []).length)) return "";
    var h = '<details class="more"><summary>Más información</summary><div class="more-body">';
    if (more.rule) h += '<p class="rule">' + esc(more.rule) + "</p>";
    var examples = Array.isArray(more.examples) ? more.examples : [];
    if (examples.length) {
      h += '<ul class="examples">' + examples.map(function (e) {
        if (typeof e === "string") return '<li><span class="es">' + esc(e) + "</span></li>";
        return '<li><span class="es">' + esc(e.es || "") + "</span>" +
          (e.fr ? '<span class="tr">' + esc(e.fr) + "</span>" : "") + "</li>";
      }).join("") + "</ul>";
    }
    if (more.tip) h += '<p class="tip">💡 ' + esc(more.tip) + "</p>";
    return h + "</div></details>";
  }

  // ----- follow-up questions on one mistake -----
  function followupsHtml(mistake, index) {
    var h = '<div class="fu" id="fu-' + index + '">';
    (mistake.followups || []).forEach(function (qa) {
      h += '<div class="fu-qa"><div class="fu-q">' + esc(qa.q) + '</div><div class="fu-a">' + esc(qa.a) + "</div></div>";
    });
    h += '<button class="fu-ask">Preguntar sobre este error</button>' +
      '<div class="fu-form hidden">' +
        '<textarea rows="2" placeholder="¿Qué no te quedó claro?"></textarea>' +
        '<button class="primary fu-send">Enviar</button>' +
      '</div><div class="fu-err"></div></div>';
    return h;
  }

  function bindFollowupBox(entry, index, box) {
    var askButton = box.querySelector(".fu-ask");
    var form = box.querySelector(".fu-form");
    askButton.addEventListener("click", function () {
      form.classList.toggle("hidden");
      if (!form.classList.contains("hidden")) form.querySelector("textarea").focus();
    });
    box.querySelector(".fu-send").addEventListener("click", function () {
      sendFollowup(entry, index, box);
    });
  }

  async function sendFollowup(entry, index, box) {
    var textarea = box.querySelector("textarea");
    var errorEl = box.querySelector(".fu-err");
    var sendButton = box.querySelector(".fu-send");
    var question = textarea.value.trim();
    errorEl.textContent = "";
    if (question.length < 3) return;
    if (!requirePasscode()) return;
    sendButton.disabled = true;
    sendButton.textContent = "Pensando…";
    try {
      var mistake = entry.result.mistakes[index];
      var resp = await fetch("/api/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-passcode": state.settings.passcode },
        body: JSON.stringify({
          question: question,
          mistake: {
            original: mistake.original, correction: mistake.correction,
            explanation: mistake.explanation, category: mistake.category
          },
          previous: mistake.followups || [],
          entryText: entry.text,
          feedbackLang: state.settings.feedbackLang,
          country: state.settings.country,
          level: state.settings.level
        })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        if (resp.status === 401) throw new Error("Código de acceso incorrecto (Ajustes).");
        throw new Error(data.error || ("Error " + resp.status));
      }
      mistake.followups = mistake.followups || [];
      mistake.followups.push({ q: question, a: String(data.answer || "") });
      save();
      // re-render only this box, so open <details> elsewhere stay open
      var wrapper = document.createElement("div");
      wrapper.innerHTML = followupsHtml(mistake, index);
      var fresh = wrapper.firstChild;
      box.replaceWith(fresh);
      bindFollowupBox(entry, index, fresh);
    } catch (e) {
      errorEl.textContent = e.message || String(e);
      sendButton.disabled = false;
      sendButton.textContent = "Enviar";
    }
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
      mistakes.forEach(function (m, i) {
        html += '<div class="mistake"><div class="pair"><del>' + esc(m.original) + "</del> → <ins>" + esc(m.correction) + "</ins>" +
          (m.category ? '<span class="chip">' + esc(m.category) + "</span>" : "") +
          '</div><div class="why">' + esc(m.explanation) + "</div>" + renderMore(m.more) + followupsHtml(m, i) + "</div>";
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
    $("result").querySelectorAll(".fu").forEach(function (box) {
      var index = +box.id.split("-")[1];
      bindFollowupBox(entry, index, box);
    });
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

  // ---------- calendar ----------
  var calendarCursor = null; // a Date pinned to the 1st of the month being shown
  var selectedDayKey = null;

  function renderCalendar() {
    if (!calendarCursor) calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    var days = entryCountByDay();
    var year = calendarCursor.getFullYear();
    var month = calendarCursor.getMonth();
    var todaysKey = todayKey();

    var monthTitle = calendarCursor.toLocaleDateString("es-MX", { month: "long", year: "numeric" });
    monthTitle = monthTitle.charAt(0).toUpperCase() + monthTitle.slice(1);

    var current = currentStreak(days);
    var html =
      '<div class="panel sb"><div class="sb-row">' +
        '<div class="sb-big"><span class="sb-num">' + current + '</span><span class="sb-cap">' +
          (current === 1 ? "día seguido" : "días seguidos") + '</span></div>' +
        '<div class="sb-stats">Mejor racha: ' + bestStreak(days) + '<br>Entradas: ' + state.entries.length + '</div>' +
      '</div></div>';

    html += '<div class="panel">' +
      '<div class="cal-head"><div class="cal-title">' + esc(monthTitle) + '</div>' +
      '<div class="cal-nav"><button id="cal-prev" aria-label="Mes anterior">‹</button>' +
      '<button id="cal-next" aria-label="Mes siguiente">›</button></div></div>';

    html += '<div class="cal-grid">';
    ["L", "M", "X", "J", "V", "S", "D"].forEach(function (wd) { html += '<div class="cal-wd">' + wd + "</div>"; });

    var mondayOffset = (new Date(year, month, 1).getDay() + 6) % 7; // week starts on Monday
    for (var blank = 0; blank < mondayOffset; blank++) html += "<div></div>";

    var daysInMonth = new Date(year, month + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var key = todayKey(new Date(year, month, day));
      var classes = "cal-day" +
        (days[key] ? " has" : "") +
        (key === todaysKey ? " today" : "") +
        (key === selectedDayKey ? " sel" : "");
      html += '<button class="' + classes + '" data-key="' + key + '"' + (days[key] ? "" : " disabled") + ">" + day + "</button>";
    }
    html += "</div></div>";

    $("calendar").innerHTML = html;
    $("cal-prev").addEventListener("click", function () {
      calendarCursor = new Date(year, month - 1, 1);
      renderCalendar();
    });
    $("cal-next").addEventListener("click", function () {
      calendarCursor = new Date(year, month + 1, 1);
      renderCalendar();
    });
    $("calendar").querySelectorAll(".cal-day.has").forEach(function (b) {
      b.addEventListener("click", function () {
        selectedDayKey = b.dataset.key;
        renderCalendar();
        renderDayEntries(selectedDayKey);
      });
    });

    renderDayEntries(selectedDayKey);
  }

  function renderDayEntries(key) {
    var container = $("day-entries");
    if (!key) {
      container.innerHTML = state.entries.length
        ? '<p class="empty">Toca un día con punto para releer lo que escribiste.</p>'
        : '<p class="empty">Todavía no hay entradas. Escribe la primera hoy.</p>';
      return;
    }
    var dayEntries = state.entries.filter(function (e) { return e.date === key; });
    if (!dayEntries.length) { container.innerHTML = ""; return; }
    var html = '<h3 class="day-title">' + esc(niceDate(key)) + "</h3>";
    dayEntries.slice().reverse().forEach(function (e) {
      var r = e.result || {};
      html += '<button class="hitem" data-id="' + e.id + '"><div class="ex">' + esc(e.text.slice(0, 160)) + "</div>" +
        '<div class="badges">' + (r.mistakes || []).length + " errores · " + (r.cards || []).length + " tarjetas" +
        (e.exportedAt ? ' · <span class="done">en Anki ✓</span>' : "") + "</div></button>";
    });
    container.innerHTML = html;
    container.querySelectorAll(".hitem").forEach(function (b) {
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
    $("set-country").value = s.country;
    $("set-deck").value = s.deckName;
    $("set-ncards").value = String(s.nCards);
    $("set-level").value = s.level;
    $("set-lang").value = s.feedbackLang;
    Object.keys(DEFAULT_FOCUS).forEach(function (k) { $("chk-" + k).checked = !!s.focus[k]; });
    $("known-count").textContent = state.known.length + " palabras ya enviadas a Anki (no se repetirán).";
  }
  $("btn-save-settings").addEventListener("click", function () {
    var focus = {};
    Object.keys(DEFAULT_FOCUS).forEach(function (k) { focus[k] = $("chk-" + k).checked; });
    var noneChecked = Object.keys(focus).every(function (k) { return !focus[k]; });
    if (noneChecked) Object.keys(focus).forEach(function (k) { focus[k] = true; });

    state.settings = {
      passcode: $("set-passcode").value.trim(),
      deckName: $("set-deck").value.trim() || "Español",
      nCards: parseInt($("set-ncards").value, 10) || 5,
      level: $("set-level").value,
      feedbackLang: $("set-lang").value,
      country: $("set-country").value,
      focus: focus
    };
    save();
    prepared.key = ""; // deck name may have changed
    renderSettings();
    $("settings-saved").textContent = noneChecked ? "Guardado ✓ (sin áreas elegidas, se corrige todo)" : "Guardado ✓";
    setTimeout(function () { $("settings-saved").textContent = ""; }, 2500);
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
        var settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
        settings.focus = Object.assign({}, DEFAULT_FOCUS, (data.settings && data.settings.focus) || {});
        state = {
          entries: data.entries,
          settings: settings,
          known: data.known || [],
          draft: data.draft || ""
        };
        save();
        renderHeader(); renderSettings(); renderStreakBoard();
        alert("Copia restaurada.");
      } catch (e) { alert("No se pudo leer la copia: " + e.message); }
    };
    reader.readAsText(f);
  });

  // ---------- start ----------
  renderHeader();
  renderStreakBoard();
  renderStepper();
})();
