/* Diario — voice capture for "Hablar".
   Records the microphone, downsamples to 16 kHz mono (plenty for speech),
   then encodes a small mp3 with lamejs (loaded from the CDN only when needed).

   Usage from app.js:
     await Recorder.start({ onTick: fn(seconds), onAutoStop: fn })
     const { base64, seconds } = await Recorder.stop()
     Recorder.cancel()   // throw the recording away (e.g. leaving the screen)
*/
(function () {
  "use strict";

  var LAME_URL = "https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js";
  var TARGET_SAMPLE_RATE = 16000;
  var MP3_KBPS = 48;
  var MAX_SECONDS = 300; // 5 minutes

  // ---------- load the mp3 encoder once, on demand ----------
  var lamePromise = null;
  function loadLame() {
    if (window.lamejs) return Promise.resolve();
    if (lamePromise) return lamePromise;
    lamePromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = LAME_URL;
      script.onload = function () {
        if (window.lamejs) resolve();
        else reject(new Error("el codificador de audio no está disponible"));
      };
      script.onerror = function () {
        lamePromise = null; // allow a retry later
        reject(new Error("no se pudo cargar el codificador de audio (¿sin conexión?)"));
      };
      document.head.appendChild(script);
    });
    return lamePromise;
  }

  // ---------- the active recording (only one at a time) ----------
  var activeRecording = null;

  // Turn one chunk of Float32 mic samples into 16 kHz Int16 samples.
  function downsampleChunk(floatSamples, inputRate) {
    var ratio = inputRate / TARGET_SAMPLE_RATE;
    var outputLength = Math.floor(floatSamples.length / ratio);
    var output = new Int16Array(outputLength);
    for (var i = 0; i < outputLength; i++) {
      var position = i * ratio;
      var index = Math.floor(position);
      var nextIndex = Math.min(index + 1, floatSamples.length - 1);
      // linear interpolation between the two nearest input samples
      var sample = floatSamples[index] + (floatSamples[nextIndex] - floatSamples[index]) * (position - index);
      sample = Math.max(-1, Math.min(1, sample));
      output[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    return output;
  }

  async function start(options) {
    if (activeRecording) throw new Error("ya hay una grabación en curso");
    var onTick = (options && options.onTick) || function () {};
    var onAutoStop = (options && options.onAutoStop) || function () {};

    await loadLame(); // fail early, before asking for microphone permission

    var stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    var AudioContextClass = window.AudioContext || window.webkitAudioContext;
    var audioContext = new AudioContextClass();
    await audioContext.resume().catch(function () {});

    var micSource = audioContext.createMediaStreamSource(stream);
    var processor = audioContext.createScriptProcessor(4096, 1, 1);

    var recording = {
      stream: stream,
      audioContext: audioContext,
      micSource: micSource,
      processor: processor,
      chunks: [],      // Int16Array pieces, already at 16 kHz
      seconds: 0,
      autoStopped: false
    };

    processor.onaudioprocess = function (event) {
      if (activeRecording !== recording) return; // stopped or cancelled
      var floatSamples = event.inputBuffer.getChannelData(0);
      recording.chunks.push(downsampleChunk(floatSamples, audioContext.sampleRate));
      recording.seconds += floatSamples.length / audioContext.sampleRate;
      onTick(recording.seconds);
      if (recording.seconds >= MAX_SECONDS && !recording.autoStopped) {
        recording.autoStopped = true;
        onAutoStop(); // the app reacts by calling Recorder.stop()
      }
    };

    micSource.connect(processor);
    processor.connect(audioContext.destination); // Safari only runs the processor when connected
    activeRecording = recording;
  }

  function releaseHardware(recording) {
    try { recording.processor.disconnect(); recording.micSource.disconnect(); } catch (e) {}
    recording.stream.getTracks().forEach(function (track) { track.stop(); });
    recording.audioContext.close().catch(function () {});
  }

  function encodeMp3(chunks) {
    var encoder = new window.lamejs.Mp3Encoder(1, TARGET_SAMPLE_RATE, MP3_KBPS);
    var FRAME = 1152; // mp3 frame size in samples

    var totalSamples = 0;
    chunks.forEach(function (c) { totalSamples += c.length; });
    var allSamples = new Int16Array(totalSamples);
    var offset = 0;
    chunks.forEach(function (c) { allSamples.set(c, offset); offset += c.length; });

    var mp3Parts = [];
    for (var i = 0; i < allSamples.length; i += FRAME) {
      var encoded = encoder.encodeBuffer(allSamples.subarray(i, i + FRAME));
      if (encoded.length) mp3Parts.push(new Uint8Array(encoded));
    }
    var tail = encoder.flush();
    if (tail.length) mp3Parts.push(new Uint8Array(tail));
    return new Blob(mp3Parts, { type: "audio/mpeg" });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(",")[1] || ""); };
      reader.onerror = function () { reject(new Error("no se pudo leer el audio grabado")); };
      reader.readAsDataURL(blob);
    });
  }

  async function stop() {
    if (!activeRecording) throw new Error("no hay ninguna grabación");
    var recording = activeRecording;
    activeRecording = null;
    releaseHardware(recording);
    var mp3Blob = encodeMp3(recording.chunks);
    var base64 = await blobToBase64(mp3Blob);
    return { base64: base64, seconds: recording.seconds, bytes: mp3Blob.size };
  }

  function cancel() {
    if (!activeRecording) return;
    var recording = activeRecording;
    activeRecording = null;
    releaseHardware(recording);
  }

  window.Recorder = { start: start, stop: stop, cancel: cancel, MAX_SECONDS: MAX_SECONDS };
})();
