const $ = (selector) => document.querySelector(selector);
let job = null;
let processing = false;
const video = $('#video');
const toast = (message, error = false) => {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  setTimeout(() => { el.className = 'toast'; }, 4200);
};
const time = (seconds) => {
  seconds = Math.max(0, Math.round(seconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

$('#choose').onclick = () => { if (!processing) video.click(); };
$('#liveStart').onclick = () => startLiveCapture($('#liveUrl').value);
$('#stopLive').onclick = async () => {
  if (!job?.isLive) return;
  $('#stopLive').disabled = true;
  try {
    const response = await fetch(`/api/jobs/${job.id}/stop-live`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop live capture.');
    toast('Stopping capture and finishing the current segment…');
  } catch (error) { toast(error instanceof Error ? error.message : 'Could not stop live capture.', true); $('#stopLive').disabled = false; }
};
video.onchange = () => {
  const file = video.files[0];
  video.value = ''; // Allows choosing the same file again after an error.
  if (file) processVideo(file);
};

const drop = $('#upload');
for (const event of ['dragenter', 'dragover']) {
  drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.add('drag'); });
}
for (const event of ['dragleave', 'drop']) {
  drop.addEventListener(event, (e) => { e.preventDefault(); drop.classList.remove('drag'); });
}
drop.addEventListener('drop', (e) => {
  if (processing) return;
  const file = e.dataTransfer.files[0];
  if (file) {
    $('#filename').textContent = file.name;
    processVideo(file);
  }
});

function setProcessing(active) {
  processing = active;
  $('#choose').disabled = active;
  $('#video').disabled = active;
  $('#liveUrl').disabled = active;
  $('#liveStart').disabled = active;
  $('#choose').textContent = active ? 'Processing video...' : 'Select video';
  $('#whisperModel').disabled = active;
  $('#whisperLanguage').disabled = active;
  drop.classList.toggle('processing', active);
  drop.setAttribute('aria-busy', String(active));
}

async function presentJob(result) {
  job = result;
  if (job.isLive) { $('#preview').removeAttribute('src'); $('#preview').dataset.source = ''; }
  else { $('#preview').src = `/api/jobs/${job.id}/stream`; $('#preview').dataset.source = ''; }
  $('#videoTitle').textContent = job.filename;
  $('#videoDuration').textContent = time(job.duration);
  $('#workspace').classList.remove('hidden');
  const status = await fetch('/api/status').then((response) => response.json());
  const refreshMeta = () => {
    $('#videoDuration').textContent = time(job.duration || 0);
    $('#wordCount').textContent = job.transcriptAvailable ? (job.wordCount ?? job.words?.length ?? 0).toLocaleString() : 'Audio scan';
    $('#wordLabel').textContent = job.transcriptAvailable ? 'TRANSCRIPT WORDS' : 'MOMENT DETECTION';
    $('#transcriptionMeta').textContent = job.transcriptAvailable
      ? `Whisper ${job.whisperModel || 'local'} | ${job.whisperDevice || 'CPU'} | language: ${job.detectedLanguage || job.whisperLanguage || 'unknown'}`
      : `Whisper unavailable${job.transcriptionError ? `: ${job.transcriptionError}` : '; using audio-only suggestions'}`;
    const waiting = ['transcribing', 'live', 'stopping'].includes(job.status);
    $('#rank').disabled = !status.aiEnabled || !job.transcriptAvailable || waiting;
    $('#aiStatus').textContent = waiting ? 'waiting for transcript' : job.transcriptAvailable ? (status.aiEnabled ? 'enabled' : 'optional') : 'needs transcript';
    $('#aiHint').textContent = waiting ? 'AI ranking will be available when transcription finishes.' : !job.transcriptAvailable
      ? 'Whisper unavailable; candidates use audio energy.'
      : (status.aiEnabled ? `Model: ${status.model}` : 'Add an OpenRouter key in .env to enable');
  };
  const update = (preserve = false) => {
    refreshMeta();
    render(job.candidates || [], { preserve, transcribing: ['transcribing', 'live', 'stopping'].includes(job.status) });
    const working = ['transcribing', 'live', 'stopping'].includes(job.status);
    $('#progress').classList.toggle('hidden', !working);
    $('#stopLive').classList.toggle('hidden', !job.isLive || !['live', 'stopping'].includes(job.status));
    $('#stopLive').disabled = job.status === 'stopping';
    if (working) {
      $('#progressTitle').textContent = job.status === 'stopping' ? 'Finishing live capture' : job.isLive ? 'Live stream capture is running' : 'Finding moments as Whisper listens';
      $('#progressText').textContent = job.isLive
        ? `${time(job.captureSeconds ?? job.duration ?? 0)} captured · ${time(job.processedSeconds || 0)} analyzed · ${job.candidates.length} suggestions ready${job.whisperDevice ? ` · ${job.whisperDevice}` : ''}`
        : `${time(job.processedSeconds || 0)} / ${time(job.duration)} analyzed · ${job.candidates.length} suggestions ready${job.whisperDevice ? ` · ${job.whisperDevice}` : ''}`;
    }
  };
  let revision = job.revision || 0;
  update();
  while (['transcribing', 'live', 'stopping'].includes(job.status)) {
    await new Promise(resolve => setTimeout(resolve, 1300));
    const response = await fetch(`/api/jobs/${job.id}/progress`);
    if (!response.ok) throw new Error('Could not read transcription progress.');
    const next = await response.json();
    Object.assign(job, next);
    const reset = revision !== (job.revision || 0);
    revision = job.revision || 0;
    update(!reset);
  }
  update(true);
  if (job.status === 'failed') toast(job.transcriptionError || 'Video processing failed.', true);
}

async function startLiveCapture(url) {
  if (processing) return;
  if (!url.trim()) return toast('Enter a public Twitch channel link first.', true);
  setProcessing(true);
  $('#progress').classList.remove('hidden');
  $('#workspace').classList.add('hidden');
  $('#progressTitle').textContent = 'Starting live capture';
  $('#progressText').textContent = 'Streamlink is connecting and the local Whisper model is loading.';
  try {
    const response = await fetch('/api/live', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim(), model: $('#whisperModel').value, language: $('#whisperLanguage').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not start live capture.');
    await presentJob(result);
  } catch (error) {
    $('#progress').classList.add('hidden');
    toast(error instanceof Error ? error.message : 'Could not start live capture.', true);
  } finally { setProcessing(false); }
}

async function processVideo(file) {
  if (processing) return;
  setProcessing(true);
  $('#filename').textContent = file.name;
  $('#progress').classList.remove('hidden');
  $('#workspace').classList.add('hidden');
  $('#progressTitle').textContent = 'Uploading and transcribing locally';
  const sizeMb = Math.max(1, Math.round(file.size / 1024 / 1024));
  const model = $('#whisperModel').value;
  const language = $('#whisperLanguage').value;
  $('#progressText').textContent = `${sizeMb} MB · ${model} · ${language === 'auto' ? 'automatic language detection' : language}. Long videos can take a while, especially when Whisper falls back to CPU. Keep this page open; it will ignore repeat uploads while processing.`;
  try {
    const query = new URLSearchParams({ filename: file.name, model, language });
    const response = await fetch(`/api/process?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Video processing failed.');
    await presentJob(result);
  } catch (error) {
    $('#progress').classList.add('hidden');
    toast(error instanceof Error ? error.message : 'Video processing failed.', true);
  } finally {
    setProcessing(false);
  }
}

function render(candidates, { preserve = false, transcribing = false } = {}) {
  $('#candidateCount').textContent = `${candidates.length}${transcribing ? ' FOUND SO FAR' : ' SUGGESTIONS'}`;
  const host = $('#candidates');
  if (!preserve) host.innerHTML = '';
  if (!candidates.length) {
    if (!host.children.length) host.innerHTML = `<p>${transcribing ? 'Listening for potential moments…' : 'No likely moments found. Try another video or inspect the source.'}</p>`;
    return;
  }
  for (const candidate of candidates) {
    if (preserve && host.querySelector(`[data-candidate-id="${candidate.id}"]`)) continue;
    if (!preserve && host.querySelector(`[data-candidate-id="${candidate.id}"]`)) continue;
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.candidateId = candidate.id;
    if (candidate.sourceFile) card.dataset.sourceFile = candidate.sourceFile;
    card.dataset.sourceOffset = candidate.sourceOffsetSeconds || 0;
    card.innerHTML = `<div class="cardtop"><span>${time(candidate.start)} — ${time(candidate.end)}</span><span class="score">${candidate.score} match</span></div><blockquote></blockquote><div class="reason"></div><textarea class="caption" rows="2" placeholder="Optional on-screen caption"></textarea><div class="cardactions"><label>In <input class="start" type="number" step="0.5" value="${candidate.start.toFixed(1)}"></label><label>Out <input class="end" type="number" step="0.5" value="${candidate.end.toFixed(1)}"></label><button class="export">Export clip ↓</button></div>`;
    card.querySelector('blockquote').textContent = candidate.text || 'Listen and review the visual context around this audio peak.';
    card.querySelector('.reason').textContent = candidate.reason;
    card.querySelector('.caption').value = candidate.text || '';
    card.querySelector('.caption').hidden = Boolean(job?.transcriptAvailable);
    if (job?.transcriptAvailable) card.querySelector('.reason').textContent += ' Word-timed captions are added on export.';
    card.querySelector('.cardtop').onclick = () => {
      const player = $('#preview');
      const sourceUrl = candidate.sourceFile
        ? `/api/jobs/${job.id}/stream?source=${encodeURIComponent(candidate.sourceFile)}`
        : `/api/jobs/${job.id}/stream`;
      const seekTo = Math.max(0, candidate.start - (candidate.sourceOffsetSeconds || 0));
      const seekAndPlay = () => { player.currentTime = seekTo; player.play(); };
      if (player.dataset.source !== sourceUrl) {
        player.dataset.source = sourceUrl; player.src = sourceUrl; player.onloadedmetadata = seekAndPlay;
      } else seekAndPlay();
    };
    card.querySelector('.export').onclick = async () => {
      const start = Number(card.querySelector('.start').value);
      const end = Number(card.querySelector('.end').value);
      if (end <= start) return toast('End time must be after start time.', true);
      const button = card.querySelector('.export');
      button.disabled = true;
      button.textContent = 'Rendering…';
      try {
        const response = await fetch(`/api/jobs/${job.id}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start, end, text: card.querySelector('.caption').value, vertical: true, style: $('#captionStyle').value, layout: $('#exportLayout').value, sourceFile: candidate.sourceFile, sourceOffsetSeconds: candidate.sourceOffsetSeconds }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Clip export failed.');
        const anchor = document.createElement('a');
        anchor.href = result.url;
        anchor.download = 'clip.mp4';
        anchor.click();
        toast(result.layout === 'stack'
          ? 'Facecam + gameplay clip rendered and downloaded.'
          : result.layoutMessage
            ? `Facecam not detected; downloaded the blurred layout. ${result.layoutMessage}`
            : 'Clip rendered and downloaded.');
      } catch (error) {
        toast(error instanceof Error ? error.message : 'Clip export failed.', true);
      } finally {
        button.disabled = false;
        button.textContent = 'Export clip ↓';
      }
    };
    const empty = host.querySelector('p'); if (empty) empty.remove();
    host.append(card);
  }
}

$('#rank').onclick = async () => {
  const button = $('#rank');
  button.disabled = true;
  button.textContent = '✦ Ranking…';
  try {
    const response = await fetch(`/api/jobs/${job.id}/rank`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'AI ranking failed.');
    render(result.candidates);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'AI ranking failed.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = '✦ Rank with AI <span>optional</span>';
  }
};

const initialJob = new URLSearchParams(location.search).get('job');
if (initialJob) {
  fetch(`/api/jobs/${initialJob}`)
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Saved video job not found.');
      await presentJob(result);
    })
    .catch((error) => toast(error.message, true));
}

function matchWhisperLanguageAndModel() {
  const language = $('#whisperLanguage').value;
  const model = $('#whisperModel');
  const current = model.value;
  if (language === 'en' && !current.endsWith('.en') && ['small', 'medium'].includes(current)) model.value = `${current}.en`;
  else if (language !== 'en' && current.endsWith('.en')) model.value = current.slice(0, -3);
}
$('#whisperLanguage').addEventListener('change', matchWhisperLanguageAndModel);
$('#whisperModel').addEventListener('change', matchWhisperLanguageAndModel);
