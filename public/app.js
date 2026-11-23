const $ = (selector) => document.querySelector(selector);
let job = null;
let processing = false;
let instagramAccounts = [];
let youtubeAccounts = [];
let currentPublishContext = null;
let previewRenderedFilename = '';
const layoutCropCache = new Map();
let uploadAbortController = null;
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

async function refreshInstagramStatus() {
  const statusText = $('#instagramStatusText');
  const accountSelect = $('#instagramAccount');
  const pubBadge = $('#pubInstaBadge');
  try {
    const response = await fetch('/api/social/instagram/status');
    const result = await response.json();
    instagramAccounts = result.accounts || [];
    if (!result.configured) {
      statusText.textContent = 'Add ZERNIO_API_KEY to .env and restart to connect Instagram.';
      $('#connectInstagram').disabled = true;
      accountSelect.classList.add('hidden');
      $('#refreshInstagram').classList.add('hidden');
      if (pubBadge) pubBadge.textContent = 'Not configured';
      return;
    }
    $('#connectInstagram').disabled = false;
    $('#connectInstagram').textContent = instagramAccounts.length ? 'Connect account' : 'Connect Instagram';
    $('#refreshInstagram').classList.toggle('hidden', !instagramAccounts.length);
    accountSelect.replaceChildren();
    for (const account of instagramAccounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.username ? (account.username.startsWith('@') ? account.username : `@${account.username}`) : account.displayName;
      accountSelect.append(option);
    }
    accountSelect.classList.toggle('hidden', !instagramAccounts.length);
    if (result.selectedAccountId && instagramAccounts.some(account => account.id === result.selectedAccountId)) {
      accountSelect.value = result.selectedAccountId;
      const cur = instagramAccounts.find(a => a.id === result.selectedAccountId);
      if (pubBadge) pubBadge.textContent = cur?.username ? `@${cur.username}` : 'Connected';
    } else {
      accountSelect.selectedIndex = -1;
      if (pubBadge) pubBadge.textContent = instagramAccounts.length ? 'Select account' : 'Not connected';
    }
    statusText.textContent = result.error ? result.error : instagramAccounts.length
      ? 'Instagram connected. Select account for Reels.'
      : 'No Instagram account connected yet.';
  } catch { statusText.textContent = 'Could not load Instagram status.'; }
}

async function refreshYoutubeStatus() {
  const statusText = $('#youtubeStatusText');
  const accountSelect = $('#youtubeAccount');
  const pubBadge = $('#pubYtBadge');
  try {
    const response = await fetch('/api/social/youtube/status');
    const result = await response.json();
    youtubeAccounts = result.accounts || [];
    if (!result.configured) {
      statusText.textContent = 'Add ZERNIO_API_KEY to .env and restart to connect YouTube.';
      $('#connectYoutube').disabled = true;
      accountSelect.classList.add('hidden');
      $('#refreshYoutube').classList.add('hidden');
      if (pubBadge) pubBadge.textContent = 'Not configured';
      return;
    }
    $('#connectYoutube').disabled = false;
    $('#connectYoutube').textContent = youtubeAccounts.length ? 'Connect channel' : 'Connect YouTube';
    $('#refreshYoutube').classList.toggle('hidden', !youtubeAccounts.length);
    accountSelect.replaceChildren();
    for (const account of youtubeAccounts) {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.displayName || account.username || 'YouTube Channel';
      accountSelect.append(option);
    }
    accountSelect.classList.toggle('hidden', !youtubeAccounts.length);
    if (result.selectedAccountId && youtubeAccounts.some(account => account.id === result.selectedAccountId)) {
      accountSelect.value = result.selectedAccountId;
      const cur = youtubeAccounts.find(a => a.id === result.selectedAccountId);
      if (pubBadge) pubBadge.textContent = cur?.displayName || 'Connected';
    } else {
      accountSelect.selectedIndex = -1;
      if (pubBadge) pubBadge.textContent = youtubeAccounts.length ? 'Select channel' : 'Not connected';
    }
    statusText.textContent = result.error ? result.error : youtubeAccounts.length
      ? 'YouTube connected. Select channel for Shorts.'
      : 'No YouTube channel connected yet.';
  } catch { statusText.textContent = 'Could not load YouTube status.'; }
}

function updateCharCounts() {
  const pubTitle = $('#pubTitle');
  const pubInstagramCaption = $('#pubInstagramCaption');
  const pubYoutubeDescription = $('#pubYoutubeDescription');
  if (pubTitle) $('#pubTitleCount').textContent = `${pubTitle.value.length} / 100`;
  if (pubInstagramCaption) $('#pubInstaCount').textContent = `${pubInstagramCaption.value.length} / 2200`;
  if (pubYoutubeDescription) $('#pubYtCount').textContent = `${pubYoutubeDescription.value.length} / 5000`;
}

function openPublishDialog(context) {
  if (!context?.jobId || !context?.filename) {
    return toast('Render this clip before publishing it.', true);
  }
  currentPublishContext = context;
  const dialog = $('#publishDialog');
  const pubTitle = $('#pubTitle');
  const pubInstagramCaption = $('#pubInstagramCaption');
  const pubYoutubeDescription = $('#pubYoutubeDescription');
  const pubSyncDesc = $('#pubSyncDesc');
  const pubDestInstagram = $('#pubDestInstagram');
  const pubDestYoutube = $('#pubDestYoutube');
  const progress = $('#publishProgress');
  const status = $('#publishStatus');
  const confirmBtn = $('#executePublish');

  progress.classList.add('hidden');
  status.classList.add('hidden');
  status.textContent = '';
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'Publish Now 🚀';

  let initialTitle = (context.title || '').trim();
  if (!initialTitle) {
    const raw = (context.caption || context.candidate?.text || '').trim();
    if (raw) {
      initialTitle = raw.split(/[.?!]/)[0].trim().slice(0, 80);
      if (initialTitle && !initialTitle.toLowerCase().includes('#shorts')) {
        initialTitle += ' #Shorts';
      }
    } else {
      initialTitle = `${job?.filename?.replace(/\.[^/.]+$/, '') || 'Stream Clip'} #Shorts`;
    }
  }
  pubTitle.value = initialTitle.slice(0, 100);
  pubInstagramCaption.value = context.caption || context.candidate?.text || '';
  pubYoutubeDescription.value = context.caption || context.candidate?.text || '';

  pubSyncDesc.checked = true;
  pubYoutubeDescription.classList.add('hidden');

  pubDestInstagram.checked = instagramAccounts.length > 0;
  pubDestYoutube.checked = youtubeAccounts.length > 0;
  if (!instagramAccounts.length && !youtubeAccounts.length) {
    pubDestInstagram.checked = true;
    pubDestYoutube.checked = true;
  }

  updateCharCounts();
  dialog.showModal();
}

async function publishToInstagram(filename, caption, button, jobId = job?.id) {
  openPublishDialog({ jobId, filename, caption });
}

async function saveCandidateClip(jobId, filename, button) {
  if (!jobId || !filename) return toast('Render this candidate before saving it.', true);
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Saving…';
  try {
    const response = await fetch(`/api/clips/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}/save`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not save this clip.');
    button.textContent = 'Saved';
    button.title = `Saved locally (${result.count}/${result.limit})`;
    toast(`Clip saved locally (${result.count}/${result.limit}).`);
    await refreshSavedClips();
  } catch (error) {
    button.disabled = false;
    button.textContent = original;
    toast(error instanceof Error ? error.message : 'Could not save this clip.', true);
  }
}

async function refreshSavedClips() {
  const host = $('#savedClipList');
  if (!host) return;
  try {
    const response = await fetch('/api/clips');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load saved clips.');
    host.replaceChildren();
    $('#savedClipCount').textContent = `${result.count || 0} / ${result.limit || 10} saved`;
    if (!result.clips?.length) {
      const empty = document.createElement('p');
      empty.className = 'library-empty';
      empty.textContent = 'No clips saved yet. Export a candidate, then click Save to keep it here (maximum 10).';
      host.append(empty);
      updateSavedSelection();
      return;
    }
    for (const clip of result.clips) {
      const card = document.createElement('article');
      card.className = 'saved-clip-card';
      card.innerHTML = '<div class="saved-clip-head"><label class="saved-select-label"><input type="checkbox" class="saved-select"> Select</label><div class="saved-clip-title"></div><small class="saved-clip-meta"></small></div><video controls preload="metadata"></video><label class="saved-caption-label">Caption / Description<textarea class="saved-caption" maxlength="2200" rows="3"></textarea></label><div class="saved-clip-actions"><a class="secondary saved-download">Download</a><button class="secondary saved-publish">Publish 🚀</button><button class="secondary saved-delete">Delete</button></div>';
      card.querySelector('.saved-select').dataset.clipId = clip.id;
      card.querySelector('.saved-select').onchange = updateSavedSelection;
      card.querySelector('.saved-clip-title').textContent = clip.filename;
      card.querySelector('.saved-clip-meta').textContent = `${clip.jobFilename} · ${(clip.size / 1024 / 1024).toFixed(1)} MB · saved ${new Date(clip.savedAt).toLocaleString()}`;
      card.querySelector('video').src = clip.streamUrl;
      card.querySelector('.saved-caption').value = clip.caption || '';
      const download = card.querySelector('.saved-download');
      download.href = clip.downloadUrl;
      download.download = clip.filename;
      card.querySelector('.saved-publish').onclick = () => openPublishDialog({
        jobId: clip.jobId,
        filename: clip.filename,
        caption: card.querySelector('.saved-caption').value || clip.caption || '',
        title: clip.filename.replace(/^clip-/, '').replace(/\.mp4$/, ''),
      });
      card.querySelector('.saved-delete').onclick = async event => {
        if (!window.confirm(`Delete ${clip.filename} from local storage?`)) return;
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const deleted = await fetch(`/api/clips/${encodeURIComponent(clip.id)}`, { method: 'DELETE' });
          const data = await deleted.json();
          if (!deleted.ok) throw new Error(data.error || 'Could not delete this clip.');
          toast('Saved clip deleted from this machine.');
          await refreshSavedClips();
        } catch (error) {
          toast(error instanceof Error ? error.message : 'Could not delete this clip.', true);
          button.disabled = false;
        }
      };
      host.append(card);
    }
    updateSavedSelection();
  } catch (error) {
    host.textContent = error instanceof Error ? error.message : 'Could not load saved clips.';
  }
}

function updateSavedSelection() {
  const selected = [...document.querySelectorAll('.saved-select:checked')];
  const total = document.querySelectorAll('.saved-select').length;
  $('#deleteSelectedClips').disabled = selected.length === 0;
  $('#selectAllClips').textContent = total > 0 && selected.length === total ? 'Deselect all' : 'Select all';
  $('#deleteSelectedClips').textContent = selected.length ? `Delete selected (${selected.length})` : 'Delete selected';
}

$('#selectAllClips').onclick = () => {
  const boxes = [...document.querySelectorAll('.saved-select')];
  const check = boxes.length > 0 && boxes.some(box => !box.checked);
  boxes.forEach(box => { box.checked = check; });
  updateSavedSelection();
};
$('#deleteSelectedClips').onclick = async () => {
  const ids = [...document.querySelectorAll('.saved-select:checked')].map(box => box.dataset.clipId);
  if (!ids.length || !window.confirm(`Delete ${ids.length} selected saved clip${ids.length === 1 ? '' : 's'} from this machine?`)) return;
  const button = $('#deleteSelectedClips');
  button.disabled = true;
  try {
    const response = await fetch('/api/clips', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not delete selected clips.');
    toast(`${result.deletedCount} saved clip${result.deletedCount === 1 ? '' : 's'} deleted.`);
    await refreshSavedClips();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not delete selected clips.', true);
    button.disabled = false;
  }
};
$('#refreshSavedClips').onclick = refreshSavedClips;

$('#connectInstagram').onclick = async () => {
  const button = $('#connectInstagram');
  button.disabled = true;
  try {
    const response = await fetch('/api/social/instagram/connect', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not connect Instagram.');
    window.location.assign(result.authUrl);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not connect Instagram.', true);
    button.disabled = false;
  }
};
$('#refreshInstagram').onclick = refreshInstagramStatus;
$('#instagramAccount').onchange = async (event) => {
  try {
    const response = await fetch('/api/social/instagram/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: event.target.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not select Instagram account.');
    toast('Instagram publishing account selected.');
    await refreshInstagramStatus();
  } catch (error) { toast(error instanceof Error ? error.message : 'Could not select Instagram account.', true); }
};

$('#connectYoutube').onclick = async () => {
  const button = $('#connectYoutube');
  button.disabled = true;
  try {
    const response = await fetch('/api/social/youtube/connect', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not connect YouTube.');
    window.location.assign(result.authUrl);
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not connect YouTube.', true);
    button.disabled = false;
  }
};
$('#refreshYoutube').onclick = refreshYoutubeStatus;
$('#youtubeAccount').onchange = async (event) => {
  try {
    const response = await fetch('/api/social/youtube/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: event.target.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not select YouTube channel.');
    toast('YouTube publishing channel selected.');
    await refreshYoutubeStatus();
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not select YouTube channel.', true);
  }
};

$('#pubSyncDesc').onchange = () => {
  const sync = $('#pubSyncDesc').checked;
  $('#pubYoutubeDescription').classList.toggle('hidden', sync);
  if (sync) {
    $('#pubYoutubeDescription').value = $('#pubInstagramCaption').value;
  }
  updateCharCounts();
};
$('#pubInstagramCaption').oninput = () => {
  if ($('#pubSyncDesc').checked) {
    $('#pubYoutubeDescription').value = $('#pubInstagramCaption').value;
  }
  updateCharCounts();
};
$('#pubTitle').oninput = updateCharCounts;
$('#pubYoutubeDescription').oninput = updateCharCounts;
$('#closePublishDialog').onclick = () => $('#publishDialog').close();
$('#cancelPublishDialog').onclick = () => $('#publishDialog').close();
$('#publishDialog').onclick = (e) => { if (e.target === $('#publishDialog')) $('#publishDialog').close(); };

$('#executePublish').onclick = async () => {
  if (!currentPublishContext) return;
  const destInstagram = $('#pubDestInstagram').checked;
  const destYoutube = $('#pubDestYoutube').checked;
  const platforms = [];
  if (destInstagram) platforms.push('instagram');
  if (destYoutube) platforms.push('youtube');

  if (!platforms.length) {
    return toast('Select at least one destination (Instagram or YouTube).', true);
  }
  if (destYoutube && !$('#pubTitle').value.trim()) {
    return toast('Please enter a title for your YouTube Short.', true);
  }

  const confirmBtn = $('#executePublish');
  const cancelBtn = $('#cancelPublishDialog');
  const progress = $('#publishProgress');
  const progressText = $('#publishProgressText');
  const status = $('#publishStatus');

  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  progress.classList.remove('hidden');
  status.classList.add('hidden');
  progressText.textContent = `Uploading clip to Zernio (${platforms.join(' & ')})...`;

  try {
    const title = $('#pubTitle').value.trim();
    const caption = $('#pubInstagramCaption').value.trim();
    const ytDesc = $('#pubSyncDesc').checked ? caption : $('#pubYoutubeDescription').value.trim();
    const visibility = $('#pubVisibility').value;

    const response = await fetch(`/api/jobs/${currentPublishContext.jobId}/publish-social`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: currentPublishContext.filename,
        platforms,
        title,
        caption,
        youtubeDescription: ytDesc,
        visibility,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Publishing failed.');

    progress.classList.add('hidden');
    status.className = 'publish-status success';

    const parts = [];
    if (result.results?.instagram) {
      const url = result.results.instagram.postUrl;
      parts.push(url ? `<a href="${url}" target="_blank" rel="noopener">Instagram Reel published ↗</a>` : `Instagram Reel submitted (${result.results.instagram.status})`);
    }
    if (result.results?.youtube) {
      const url = result.results.youtube.postUrl;
      parts.push(url ? `<a href="${url}" target="_blank" rel="noopener">YouTube Short published ↗</a>` : `YouTube Short submitted (${result.results.youtube.status})`);
    }
    status.innerHTML = `<strong>Published successfully!</strong><br>${parts.join('<br>')}`;
    status.classList.remove('hidden');
    confirmBtn.textContent = 'Published ✓';
    toast('Clip published successfully!');
  } catch (error) {
    progress.classList.add('hidden');
    status.className = 'publish-status error';
    status.textContent = error instanceof Error ? error.message : 'Social publishing failed.';
    status.classList.remove('hidden');
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Try Again';
    toast(error instanceof Error ? error.message : 'Social publishing failed.', true);
  } finally {
    cancelBtn.disabled = false;
  }
};

refreshInstagramStatus();
refreshYoutubeStatus();
refreshSavedClips();
const socialQuery = new URLSearchParams(location.search);
if (socialQuery.get('instagram') === 'connected') toast('Instagram account connected.');
if (socialQuery.has('instagram_error')) toast(`Instagram connection did not finish: ${socialQuery.get('instagram_error')}`, true);
if (socialQuery.get('youtube') === 'connected') toast('YouTube channel connected successfully.');
if (socialQuery.has('youtube_error')) toast(`YouTube connection did not finish: ${socialQuery.get('youtube_error')}`, true);

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
$('#stopProcessing').onclick = async () => {
  if (uploadAbortController) {
    $('#stopProcessing').disabled = true;
    uploadAbortController.abort();
    toast('Cancelling video upload…');
    return;
  }
  if (!job || job.isLive || !['transcribing', 'cancelling'].includes(job.status)) return;
  $('#stopProcessing').disabled = true;
  try {
    const response = await fetch(`/api/jobs/${job.id}/stop-processing`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop video processing.');
    toast('Stopping video processing…');
  } catch (error) {
    toast(error instanceof Error ? error.message : 'Could not stop video processing.', true);
    $('#stopProcessing').disabled = false;
  }
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

let livePreviewChunk = '';
function updateLivePreview(chunk) {
  if (!chunk || !job) return;
  const chunkUrl = `/api/jobs/${job.id}/stream?source=${encodeURIComponent(chunk)}`;
  if (livePreviewChunk === chunk) return;
  livePreviewChunk = chunk;
  const player = $('#preview');
  player.dataset.source = chunkUrl;
  player.src = chunkUrl;
  player.muted = true;
  player.onloadedmetadata = () => { player.play().catch(() => {}); };
}

async function presentJob(result) {
  job = result;
  livePreviewChunk = '';
  if (job.isLive) {
    $('#preview').removeAttribute('src');
    $('#preview').dataset.source = '';
    $('#liveBadge').classList.remove('hidden');
    if (job.latestChunk) updateLivePreview(job.latestChunk);
  }
  else { $('#preview').src = `/api/jobs/${job.id}/stream`; $('#preview').dataset.source = ''; $('#liveBadge').classList.add('hidden'); }
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
    const waiting = ['transcribing', 'cancelling', 'live', 'stopping'].includes(job.status);
    $('#rank').disabled = !status.aiEnabled || !job.transcriptAvailable || waiting;
    $('#aiStatus').textContent = waiting ? 'waiting for transcript' : job.transcriptAvailable ? (status.aiEnabled ? 'enabled' : 'optional') : 'needs transcript';
    $('#aiHint').textContent = waiting ? 'AI ranking will be available when transcription finishes.' : !job.transcriptAvailable
      ? 'Whisper unavailable; candidates use audio energy.'
      : (status.aiEnabled ? `Model: ${status.model}` : 'Add an OpenRouter key in .env to enable');
  };
  const update = (preserve = false) => {
    refreshMeta();
    render(job.candidates || [], { preserve, transcribing: ['transcribing', 'cancelling', 'live', 'stopping'].includes(job.status) });
    const working = ['transcribing', 'cancelling', 'live', 'stopping'].includes(job.status);
    $('#progress').classList.toggle('hidden', !working);
    $('#liveBadge').classList.toggle('hidden', !job.isLive || !['live', 'stopping'].includes(job.status));
    $('#stopLive').classList.toggle('hidden', !job.isLive || !['live', 'stopping'].includes(job.status));
    $('#stopLive').disabled = job.status === 'stopping';
    $('#stopProcessing').classList.toggle('hidden', job.isLive || !['transcribing', 'cancelling'].includes(job.status));
    $('#stopProcessing').disabled = job.status === 'cancelling';
    $('#stopProcessing').textContent = job.status === 'cancelling' ? 'Stopping…' : 'Stop processing';
    if (working) {
      $('#progressTitle').textContent = job.status === 'cancelling' ? 'Stopping video processing' : job.status === 'stopping' ? 'Finishing live capture' : job.isLive ? 'Live stream capture is running' : 'Finding moments as Whisper listens';
      $('#progressText').textContent = job.status === 'cancelling'
        ? 'Stopping Whisper and keeping the suggestions found so far…'
        : job.isLive
        ? `${time(job.captureSeconds ?? job.duration ?? 0)} captured · ${time(job.processedSeconds || 0)} analyzed · ${job.candidates.length} suggestions ready${job.whisperDevice ? ` · ${job.whisperDevice}` : ''}`
        : `${time(job.processedSeconds || 0)} / ${time(job.duration)} analyzed · ${job.candidates.length} suggestions ready${job.whisperDevice ? ` · ${job.whisperDevice}` : ''}`;
    }
  };
  let revision = job.revision || 0;
  update();
  while (['transcribing', 'cancelling', 'live', 'stopping'].includes(job.status)) {
    await new Promise(resolve => setTimeout(resolve, 1300));
    const response = await fetch(`/api/jobs/${job.id}/progress`);
    if (!response.ok) throw new Error('Could not read transcription progress.');
    const next = await response.json();
    Object.assign(job, next);
    const reset = revision !== (job.revision || 0);
    revision = job.revision || 0;
    if (job.isLive && next.latestChunk) updateLivePreview(next.latestChunk);
    update(!reset);
  }
  update(true);
  if (job.status === 'failed') toast(job.transcriptionError || 'Video processing failed.', true);
  if (job.status === 'cancelled') toast(`Processing stopped. ${job.candidates?.length || 0} suggestions found so far.`);
}

async function startLiveCapture(url) {
  if (processing) return;
  if (!url.trim()) return toast('Enter a public Twitch or YouTube live stream link first.', true);
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
  job = null;
  setProcessing(true);
  $('#filename').textContent = file.name;
  $('#progress').classList.remove('hidden');
  $('#workspace').classList.add('hidden');
  $('#progressTitle').textContent = 'Uploading and transcribing locally';
  const sizeMb = Math.max(1, Math.round(file.size / 1024 / 1024));
  const model = $('#whisperModel').value;
  const language = $('#whisperLanguage').value;
  uploadAbortController = new AbortController();
  $('#stopProcessing').classList.remove('hidden');
  $('#stopProcessing').disabled = false;
  $('#stopProcessing').textContent = 'Cancel upload';
  $('#progressText').textContent = `${sizeMb} MB · ${model} · ${language === 'auto' ? 'automatic language detection' : language}. Long videos can take a while, especially when Whisper falls back to CPU. Keep this page open; it will ignore repeat uploads while processing.`;
  try {
    const query = new URLSearchParams({ filename: file.name, model, language });
    const response = await fetch(`/api/process?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      signal: uploadAbortController.signal,
    });
    uploadAbortController = null;
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Video processing failed.');
    await presentJob(result);
  } catch (error) {
    $('#progress').classList.add('hidden');
    if (error instanceof Error && error.name === 'AbortError') toast('Video upload cancelled.');
    else toast(error instanceof Error ? error.message : 'Video processing failed.', true);
  } finally {
    uploadAbortController = null;
    $('#stopProcessing').classList.add('hidden');
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
  if (candidates.length && job && !job.layoutCrop) {
    const firstCand = candidates[0];
    const prefetchQuery = new URLSearchParams({
      start: String(firstCand.start),
      end: String(firstCand.end),
      sourceOffsetSeconds: String(firstCand.sourceOffsetSeconds || 0),
    });
    if (firstCand.sourceFile) prefetchQuery.set('sourceFile', firstCand.sourceFile);
    fetch(`/api/jobs/${job.id}/layout-probe?${prefetchQuery}`)
      .then(r => r.ok ? r.json() : null)
      .then(probe => {
        if (probe?.hasCam) {
          job.layoutCrop = probe;
          layoutCropCache.set(`${job.id}:${firstCand.sourceFile || ''}`, probe);
        }
      })
      .catch(() => {});
  }
  for (const candidate of candidates) {
    if (preserve && host.querySelector(`[data-candidate-id="${candidate.id}"]`)) continue;
    if (!preserve && host.querySelector(`[data-candidate-id="${candidate.id}"]`)) continue;
    const card = document.createElement('article');
    const candidateJobId = job.id;
    card.className = 'card';
    card.dataset.candidateId = candidate.id;
    if (candidate.sourceFile) card.dataset.sourceFile = candidate.sourceFile;
    card.dataset.sourceOffset = candidate.sourceOffsetSeconds || 0;
    card.innerHTML = `<div class="cardtop"><span>${time(candidate.start)} — ${time(candidate.end)}</span><span class="score">${candidate.score} match</span></div><blockquote></blockquote><div class="reason"></div><textarea class="caption" rows="2" placeholder="Optional on-screen caption"></textarea><div class="cardactions"><label>In <input class="start" type="number" step="0.5" value="${candidate.start.toFixed(1)}"></label><label>Out <input class="end" type="number" step="0.5" value="${candidate.end.toFixed(1)}"></label><button class="preview-btn secondary">Preview ▶</button><button class="export">Export clip ↓</button></div>`;
    card.querySelector('blockquote').textContent = candidate.text || 'Listen and review the visual context around this audio peak.';
    card.querySelector('.reason').textContent = candidate.reason;
    card.querySelector('.caption').value = candidate.text || '';
    const publishButton = document.createElement('button');
    publishButton.className = 'card-publish secondary';
    publishButton.textContent = 'Publish 🚀';
    publishButton.disabled = true;
    publishButton.title = 'Render this clip first';
    card.querySelector('.export').after(publishButton);
    let renderedFilename = '';
    publishButton.onclick = () => openPublishDialog({
      jobId: candidateJobId,
      filename: renderedFilename,
      caption: card.querySelector('.caption').value || candidate.text || '',
      candidate,
    });
    const saveButton = document.createElement('button');
    saveButton.className = 'card-save secondary';
    saveButton.textContent = 'Save';
    saveButton.disabled = true;
    saveButton.title = 'Render this candidate first';
    card.querySelector('.export').after(saveButton);
    saveButton.onclick = () => saveCandidateClip(candidateJobId, renderedFilename, saveButton);
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
    card.querySelector('.preview-btn').onclick = () => {
      const start = Number(card.querySelector('.start').value);
      const end = Number(card.querySelector('.end').value);
      if (end <= start) return toast('End time must be after start time.', true);
      openPreviewDialog(candidate, start, end, card.querySelector('.caption').value);
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
        renderedFilename = result.filename || '';
        publishButton.disabled = !renderedFilename;
        publishButton.title = renderedFilename ? 'Publish to Instagram or YouTube' : 'Render this clip first';
        saveButton.disabled = !renderedFilename;
        saveButton.title = renderedFilename ? 'Save this candidate locally' : 'Render this candidate first';
        downloadRenderedClip(result.url, result.filename || 'clip.mp4');
        void refreshSavedClips();
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

let previewExportCandidate = null;
let activeSubtitleCues = [];
let fallbackSubtitleText = '';
let subtitleAnimFrame = null;

function downloadRenderedClip(url, filename = 'clip.mp4') {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function buildSubtitleCues(words, start, end, style) {
  if (!words || !words.length) return [];
  const selected = words.filter(w => w.end > start && w.start < end && w.text && w.text.trim());
  if (!selected.length) return [];

  const groups = [];
  if (style === 'classic') {
    let line = [];
    for (const word of selected) {
      const prev = line.at(-1);
      if (line.length >= 3 || (prev && /[.!?]$/.test(prev.text.trim())) || (prev && word.start - prev.end > 0.6)) {
        if (line.length) groups.push(line);
        line = [];
      }
      line.push(word);
    }
    if (line.length) groups.push(line);
  } else {
    let group = [];
    const joinText = (items) => items.map(w => w.text.trim()).join(' ');
    for (const word of selected) {
      const candidate = [...group, word];
      if (group.length && (candidate.length > 5 || word.end - group[0].start > 2.5 || joinText(candidate).length > 34)) {
        groups.push(group);
        group = [];
      }
      group.push(word);
      if (/[.!?]$/.test(word.text.trim()) && group.length >= 2) {
        groups.push(group);
        group = [];
      }
    }
    if (group.length) groups.push(group);
  }

  return groups.map((grp, idx) => {
    const nextGroupStart = groups[idx + 1]?.[0]?.start ?? end;
    const groupEnd = Math.min(end, grp.at(-1).end + 0.25, nextGroupStart);
    return {
      start: Math.max(start, grp[0].start),
      end: groupEnd,
      words: grp.map((w, wIdx) => ({
        token: w.text.trim().toLocaleUpperCase().replace(/[{}]/g, ''),
        start: w.start,
        end: grp[wIdx + 1]?.start ?? Math.min(end, w.end + 0.15)
      }))
    };
  });
}

function renderSubtitlesAtTime(currentTime) {
  const el = $('#dialogCaption');
  if (!el) return;

  if (!activeSubtitleCues.length) {
    if (fallbackSubtitleText) {
      el.innerHTML = `<span class="fallback-caption">${fallbackSubtitleText}</span>`;
    } else {
      el.innerHTML = '';
    }
    return;
  }

  const currentCue = activeSubtitleCues.find(cue => currentTime >= cue.start - 0.05 && currentTime <= cue.end);
  if (!currentCue) {
    el.innerHTML = '';
    return;
  }

  const wordsHtml = currentCue.words.map((w) => {
    const isSpoken = currentTime >= w.start && currentTime < w.end;
    return `<span class="sub-word${isSpoken ? ' active' : ''}">${w.token}</span>`;
  }).join(' ');

  el.innerHTML = wordsHtml;
}

function applyBoxCrop(videoEl, box, videoWidth, videoHeight) {
  if (!box || !videoWidth || !videoHeight) return;
  const [x0, y0, x1, y1] = box;
  const bw = Math.max(1, x1 - x0);
  const bh = Math.max(1, y1 - y0);
  videoEl.style.width = `${(videoWidth / bw) * 100}%`;
  videoEl.style.height = `${(videoHeight / bh) * 100}%`;
  videoEl.style.left = `${-(x0 / bw) * 100}%`;
  videoEl.style.top = `${-(y0 / bh) * 100}%`;
  videoEl.style.objectFit = 'fill';
}

function applyDefaultCrops(topEl, bottomEl, initialCrop) {
  if (initialCrop?.hasCam && initialCrop.cam && initialCrop.game) {
    applyBoxCrop(topEl, initialCrop.cam, initialCrop.width, initialCrop.height);
    applyBoxCrop(bottomEl, initialCrop.game, initialCrop.width, initialCrop.height);
    return;
  }
  // Safe default: frame the upper-left creator zone without overshooting into the right
  topEl.style.width = '240%';
  topEl.style.height = '240%';
  topEl.style.left = '-15%';
  topEl.style.top = '-10%';
  topEl.style.objectFit = 'cover';

  bottomEl.style.width = '175%';
  bottomEl.style.height = '175%';
  bottomEl.style.left = '-35%';
  bottomEl.style.top = '-15%';
  bottomEl.style.objectFit = 'cover';
}

function openPreviewDialog(candidate, start, end, captionText) {
  const dialog = $('#previewDialog');
  const stackView = $('#stackView');
  const blurView = $('#blurView');
  const topVideo = $('#dialogVideoTop');
  const bottomVideo = $('#dialogVideoBottom');
  const blurBg = $('#dialogVideoBlurBg');
  const blurFg = $('#dialogVideoBlurFg');
  const captionEl = $('#dialogCaption');
  const dialogMessage = $('#dialogMessage');
  const exportBtn = $('#dialogExport');
  const requestedLayout = $('#exportLayout').value;
  const style = $('#captionStyle').value;

  captionEl.className = `preview-caption style-${style}`;
  dialogMessage.classList.add('hidden');
  dialogMessage.textContent = '';
  exportBtn.disabled = false;
  previewRenderedFilename = '';
  const pubBtn = $('#dialogPublishSocial') || $('#dialogInstagram');
  if (pubBtn) {
    pubBtn.disabled = true;
    pubBtn.textContent = 'Render clip first';
  }
  $('#dialogSave').disabled = true;
  $('#dialogSave').textContent = 'Render clip first';
  $('#instagramCaption').value = captionText || candidate.text || '';
  exportBtn.textContent = 'Export clip ↓';

  const sourceUrl = candidate.sourceFile
    ? `/api/jobs/${job.id}/stream?source=${encodeURIComponent(candidate.sourceFile)}`
    : `/api/jobs/${job.id}/stream`;
  const seekTo = Math.max(0, start - (candidate.sourceOffsetSeconds || 0));
  const seekEnd = Math.max(seekTo + 0.5, end - (candidate.sourceOffsetSeconds || 0));

  fallbackSubtitleText = captionText || candidate.text || '';
  activeSubtitleCues = [];
  captionEl.innerHTML = '';
  previewExportCandidate = { candidate, start, end, captionText };

  $('#dialogTime').textContent = `${time(start)} — ${time(end)} (${(end - start).toFixed(1)}s)`;
  $('#dialogLayout').textContent = `${requestedLayout === 'blur' ? 'Blurred layout' : 'Facecam + gameplay'} · ${style}`;

  // Fetch word timestamps asynchronously for real-time captions
  fetch(`/api/jobs/${job.id}/words?start=${start}&end=${end}`)
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data?.words?.length) {
        activeSubtitleCues = buildSubtitleCues(data.words, start, end, style);
      }
    })
    .catch(() => {});

  let masterVideo, slaveVideo;

  if (requestedLayout === 'blur') {
    stackView.classList.add('hidden');
    blurView.classList.remove('hidden');
    masterVideo = blurFg;
    slaveVideo = blurBg;
  } else {
    stackView.classList.remove('hidden');
    blurView.classList.add('hidden');
    masterVideo = bottomVideo;
    slaveVideo = topVideo;

    const cacheKey = `${job.id}:${candidate.sourceFile || ''}`;
    const cachedCrop = layoutCropCache.get(cacheKey) || job?.layoutCrop;
    applyDefaultCrops(topVideo, bottomVideo, cachedCrop);

    if (cachedCrop?.hasCam) {
      $('#dialogLayout').textContent = `Facecam + gameplay (calibrated) · ${style}`;
    } else {
      $('#dialogLayout').textContent = `Facecam + gameplay (calibrating...) · ${style}`;
    }

    // Run quick facecam probe asynchronously to calibrate exact crop boxes
    const probeQuery = new URLSearchParams({
      start: String(start),
      end: String(end),
      sourceOffsetSeconds: String(candidate.sourceOffsetSeconds || 0),
    });
    if (candidate.sourceFile) probeQuery.set('sourceFile', candidate.sourceFile);

    fetch(`/api/jobs/${job.id}/layout-probe?${probeQuery}`)
      .then(r => r.ok ? r.json() : null)
      .then(probe => {
        if (!dialog.open) return;
        if (probe?.hasCam) {
          layoutCropCache.set(cacheKey, probe);
          job.layoutCrop = probe;
          applyBoxCrop(topVideo, probe.cam, probe.width, probe.height);
          applyBoxCrop(bottomVideo, probe.game, probe.width, probe.height);
          $('#dialogLayout').textContent = `Facecam + gameplay (calibrated) · ${style}`;
        } else if (probe && !probe.hasCam && !cachedCrop?.hasCam) {
          // Fall back visually to blur layout only if facecam couldn't be detected and no cached crop
          stackView.classList.add('hidden');
          blurView.classList.remove('hidden');
          blurBg.src = sourceUrl;
          blurFg.src = sourceUrl;
          blurBg.currentTime = masterVideo.currentTime;
          blurFg.currentTime = masterVideo.currentTime;
          blurFg.play().catch(() => {});
          blurBg.play().catch(() => {});
          masterVideo = blurFg;
          slaveVideo = blurBg;
          $('#dialogLayout').textContent = `Blurred layout (Facecam not detected) · ${style}`;
          dialogMessage.textContent = 'Facecam not detected on this clip; showing blurred background layout.';
          dialogMessage.classList.remove('hidden');
        }
      })
      .catch(() => {});
  }

  // Set up both video players instantly
  masterVideo.src = sourceUrl;
  slaveVideo.src = sourceUrl;

  const seekAndSync = () => {
    masterVideo.currentTime = seekTo;
    slaveVideo.currentTime = seekTo;
    masterVideo.play().catch(() => {});
    slaveVideo.play().catch(() => {});
  };

  masterVideo.onloadedmetadata = seekAndSync;

  masterVideo.onplay = () => {
    slaveVideo.currentTime = masterVideo.currentTime;
    slaveVideo.play().catch(() => {});
    cancelAnimationFrame(subtitleAnimFrame);
    subtitleAnimFrame = requestAnimationFrame(tick);
  };
  masterVideo.onpause = () => {
    slaveVideo.pause();
    cancelAnimationFrame(subtitleAnimFrame);
  };
  masterVideo.onseeking = () => {
    slaveVideo.currentTime = masterVideo.currentTime;
  };

  const tick = () => {
    if (masterVideo.paused || masterVideo.ended) return;
    const offset = candidate.sourceOffsetSeconds || 0;
    const globalTime = masterVideo.currentTime + offset;
    if (masterVideo.currentTime >= seekEnd) {
      masterVideo.currentTime = seekTo;
      slaveVideo.currentTime = seekTo;
    }
    if (Math.abs(slaveVideo.currentTime - masterVideo.currentTime) > 0.2) {
      slaveVideo.currentTime = masterVideo.currentTime;
    }
    renderSubtitlesAtTime(globalTime);
    subtitleAnimFrame = requestAnimationFrame(tick);
  };

  masterVideo.ontimeupdate = () => {
    const offset = candidate.sourceOffsetSeconds || 0;
    renderSubtitlesAtTime(masterVideo.currentTime + offset);
  };

  dialog.showModal();
}

function closePreviewDialog() {
  cancelAnimationFrame(subtitleAnimFrame);
  for (const id of ['dialogVideoTop', 'dialogVideoBottom', 'dialogVideoBlurBg', 'dialogVideoBlurFg']) {
    const v = $(`#${id}`);
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.onloadedmetadata = null;
      v.onplay = null;
      v.onpause = null;
      v.onseeking = null;
      v.ontimeupdate = null;
    }
  }
  $('#dialogCaption').innerHTML = '';
  $('#dialogMessage').classList.add('hidden');
  activeSubtitleCues = [];
  previewExportCandidate = null;
  $('#previewDialog').close();
}

$('#closePreview').onclick = closePreviewDialog;
$('#dialogCancel').onclick = closePreviewDialog;
$('#previewDialog').onclick = (e) => { if (e.target === $('#previewDialog')) closePreviewDialog(); };

$('#captionStyle').addEventListener('change', () => {
  if (previewExportCandidate && $('#previewDialog').open) {
    const style = $('#captionStyle').value;
    $('#dialogCaption').className = `preview-caption style-${style}`;
    const layout = $('#exportLayout').value === 'blur' ? 'Blurred layout' : 'Facecam + gameplay';
    $('#dialogLayout').textContent = `${layout} · ${style}`;
    if (job?.words) {
      activeSubtitleCues = buildSubtitleCues(job.words, previewExportCandidate.start, previewExportCandidate.end, style);
    }
  }
});

$('#dialogExport').onclick = async () => {
  if (!previewExportCandidate || !job) return;
  const { candidate, start, end, captionText } = previewExportCandidate;
  const button = $('#dialogExport');
  button.disabled = true;
  button.textContent = 'Rendering…';
  try {
    const response = await fetch(`/api/jobs/${job.id}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start,
        end,
        text: captionText,
        vertical: true,
        style: $('#captionStyle').value,
        layout: $('#exportLayout').value,
        sourceFile: candidate.sourceFile,
        sourceOffsetSeconds: candidate.sourceOffsetSeconds
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Clip export failed.');
    previewRenderedFilename = result.filename || '';
    const pubBtn = $('#dialogPublishSocial') || $('#dialogInstagram');
    if (pubBtn) {
      pubBtn.disabled = !previewRenderedFilename;
      pubBtn.textContent = 'Publish Social 🚀';
    }
    $('#dialogSave').disabled = !previewRenderedFilename;
    $('#dialogSave').textContent = 'Save candidate';
    downloadRenderedClip(result.url, result.filename || 'clip.mp4');
    void refreshSavedClips();
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

const triggerPublishDialogFromPreview = () => openPublishDialog({
  jobId: job?.id,
  filename: previewRenderedFilename,
  caption: $('#instagramCaption')?.value || fallbackSubtitleText || '',
  candidate: previewExportCandidate?.candidate,
});
if ($('#dialogPublishSocial')) $('#dialogPublishSocial').onclick = triggerPublishDialogFromPreview;
if ($('#dialogInstagram')) $('#dialogInstagram').onclick = triggerPublishDialogFromPreview;
$('#dialogSave').onclick = () => saveCandidateClip(job?.id, previewRenderedFilename, $('#dialogSave'));

function matchWhisperLanguageAndModel() {
  const language = $('#whisperLanguage').value;
  const model = $('#whisperModel');
  const current = model.value;
  if (language === 'en' && !current.endsWith('.en') && ['small', 'medium'].includes(current)) model.value = `${current}.en`;
  else if (language !== 'en' && current.endsWith('.en')) model.value = current.slice(0, -3);
}
$('#whisperLanguage').addEventListener('change', matchWhisperLanguageAndModel);
$('#whisperModel').addEventListener('change', matchWhisperLanguageAndModel);
