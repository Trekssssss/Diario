/*
 * apkg.js — builds an Anki deck file (.apkg) entirely in the browser.
 *
 * An .apkg is a zip with two files:
 *   - "collection.anki2": a small SQLite database (Anki schema v11)
 *   - "media": a JSON list of media files (empty here)
 *
 * When AnkiMobile imports the file, it MERGES the cards into your existing
 * deck with the same name, and reuses the same note type every day, because
 * the note-type id and deck id below are stable.
 *
 * Works in the browser (uses window.initSqlJs + window.JSZip)
 * and in Node for testing (pass SQL and JSZip in).
 */
(function (root) {
  // Never change this id: it ties every day's cards to the same note type.
  var MODEL_ID = 1734567890123;
  var MODEL_NAME = "Diario ES (escribir la palabra)";

  var FIELDS = ["Frase", "Respuesta", "Tipo", "Lema", "Traduccion", "Ejemplos", "Nota"];

  // Front: the sentence with a blank + a box to type the missing word. No hint.
  var FRONT =
    '<div class="frase">{{Frase}}</div>\n' +
    '<div class="typebox">{{type:Respuesta}}</div>';

  // Back: what you typed vs the answer, then everything useful to learn it.
  var BACK =
    '<div class="frase">{{Frase}}</div>\n' +
    '<div class="typebox">{{type:Respuesta}}</div>\n' +
    '<hr id="answer">\n' +
    '<div class="respuesta">{{Respuesta}}</div>\n' +
    '<div class="meta">{{Tipo}}{{#Lema}} · <i>{{Lema}}</i>{{/Lema}}</div>\n' +
    '<div class="trad">{{Traduccion}}</div>\n' +
    '{{#Ejemplos}}<div class="ejemplos">{{Ejemplos}}</div>{{/Ejemplos}}\n' +
    '{{#Nota}}<div class="nota">{{Nota}}</div>{{/Nota}}';

  var CSS =
    ".card{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:22px;" +
    "line-height:1.45;text-align:center;color:#1d1d1f;background:#fbfaf7;padding:12px}\n" +
    ".nightMode.card,.night_mode .card{color:#f2f2f2;background:#1c1c1e}\n" +
    ".frase{font-size:24px;margin:10px 0 16px}\n" +
    ".respuesta{font-size:30px;font-weight:700;color:#c2410c;margin-top:8px}\n" +
    ".meta{font-size:16px;opacity:.7;margin-top:2px}\n" +
    ".trad{font-size:18px;margin-top:8px}\n" +
    ".ejemplos{font-size:18px;text-align:left;margin:16px auto 0;max-width:34em}\n" +
    ".ejemplos li{margin:6px 0}\n" +
    ".nota{font-size:15px;opacity:.75;margin:14px auto 0;max-width:34em;font-style:italic}\n" +
    "input#typeans{font-size:22px;text-align:center}";

  var SCHEMA = [
    "CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);",
    "CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);",
    "CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);",
    "CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);",
    "CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);",
    "CREATE INDEX ix_notes_usn on notes (usn);",
    "CREATE INDEX ix_cards_usn on cards (usn);",
    "CREATE INDEX ix_revlog_usn on revlog (usn);",
    "CREATE INDEX ix_cards_nid on cards (nid);",
    "CREATE INDEX ix_cards_sched on cards (did, queue, due);",
    "CREATE INDEX ix_revlog_cid on revlog (cid);",
    "CREATE INDEX ix_notes_csum on notes (csum);"
  ].join("\n");

  var CONF = {
    activeDecks: [1], addToCur: true, collapseTime: 1200, curDeck: 1,
    curModel: String(MODEL_ID), dueCounts: true, estTimes: true, newBury: true,
    newSpread: 0, nextPos: 1, sortBackwards: false, sortType: "noteFld", timeLim: 0
  };

  var DCONF = {
    "1": {
      autoplay: true, id: 1,
      lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
      maxTaken: 60, mod: 0, name: "Default",
      "new": { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
      replayq: true,
      rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 100 },
      timer: 0, usn: 0
    }
  };

  // Small stable 32-bit hash (FNV-1a) used to derive ids from text.
  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  // The deck id comes from the deck name, so the same name = the same deck every day.
  function deckIdFromName(name) {
    return 1500000000000 + (hash32("deck:" + name) % 100000000000);
  }

  // Anki's guid: a short stable string. Same word + same sentence => same note (no duplicates).
  function guidFor(card) {
    var a = hash32("g1:" + card.answer + "|" + card.sentence).toString(36);
    var b = hash32("g2:" + card.sentence + "|" + card.answer).toString(36);
    return (a + b).slice(0, 10);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function fieldsFor(card) {
    var examples = (card.examples || []).filter(Boolean);
    var examplesHtml = examples.length
      ? "<ul>" + examples.map(function (e) { return "<li>" + escapeHtml(e) + "</li>"; }).join("") + "</ul>"
      : "";
    return [
      escapeHtml(card.sentence).replace("____", "<b>____</b>"),
      escapeHtml(card.answer),         // plain text: this is what {{type:}} compares against
      escapeHtml(card.pos),
      escapeHtml(card.lemma),
      escapeHtml(card.translation),
      examplesHtml,
      escapeHtml(card.note)
    ];
  }

  function buildModel(deckId, nowSec) {
    var flds = FIELDS.map(function (name, ord) {
      return { name: name, ord: ord, font: "Arial", media: [], rtl: false, size: 20, sticky: false };
    });
    var model = {};
    model[String(MODEL_ID)] = {
      css: CSS, did: deckId, flds: flds, id: String(MODEL_ID),
      latexPost: "\\end{document}",
      latexPre: "\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n",
      latexsvg: false, mod: nowSec, name: MODEL_NAME,
      req: [[0, "all", [0]]], sortf: 1, tags: [],
      tmpls: [{
        name: "Escribir", qfmt: FRONT, afmt: BACK, ord: 0,
        bafmt: "", bqfmt: "", bfont: "", bsize: 0, did: null
      }],
      type: 0, usn: -1, vers: []
    };
    return model;
  }

  function buildDecks(deckId, deckName, nowSec) {
    function deck(id, name) {
      return {
        collapsed: false, conf: 1, desc: "", dyn: 0, extendNew: 10, extendRev: 50,
        id: id, lrnToday: [0, 0], mod: nowSec, name: name, newToday: [0, 0],
        revToday: [0, 0], timeToday: [0, 0], usn: -1
      };
    }
    var decks = { "1": deck(1, "Default") };
    decks[String(deckId)] = deck(deckId, deckName);
    return decks;
  }

  /**
   * buildApkg({ SQL, JSZip, deckName, cards, tags }) -> Promise<Uint8Array>
   * cards: [{ sentence, answer, pos, lemma, translation, examples[], note }]
   */
  async function buildApkg(opts) {
    var SQL = opts.SQL, JSZipLib = opts.JSZip;
    var deckName = opts.deckName || "Español";
    var cards = opts.cards || [];
    var tags = (opts.tags || ["diario"]).map(function (t) { return String(t).replace(/\s+/g, "_"); }).join(" ");
    var nowMs = Date.now();
    var nowSec = Math.floor(nowMs / 1000);
    var deckId = deckIdFromName(deckName);

    var db = new SQL.Database();
    db.run(SCHEMA);
    db.run(
      "INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')",
      [nowSec, nowMs, nowMs,
        JSON.stringify(CONF),
        JSON.stringify(buildModel(deckId, nowSec)),
        JSON.stringify(buildDecks(deckId, deckName, nowSec)),
        JSON.stringify(DCONF)]
    );

    cards.forEach(function (card, i) {
      var noteId = nowMs + i * 2;      // unique per export
      var cardId = noteId + 1;
      var flds = fieldsFor(card);
      db.run("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, 0, 0, '')",
        [noteId, guidFor(card), MODEL_ID, nowSec, " " + tags + " ", flds.join("\x1f"), flds[1]]);
      // type 0 / queue 0 = new card; "due" is its position in the new-card queue.
      db.run("INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, '')",
        [cardId, noteId, deckId, nowSec, i]);
    });

    var dbBytes = db.export();
    db.close();

    var zip = new JSZipLib();
    zip.file("collection.anki2", dbBytes);
    zip.file("media", "{}");
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  }

  var api = { buildApkg: buildApkg, deckIdFromName: deckIdFromName, MODEL_ID: MODEL_ID };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Apkg = api;
})(typeof window !== "undefined" ? window : this);
