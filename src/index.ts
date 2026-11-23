import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, extname, resolve, isAbsolute } from 'node:path';

type Word = { start: number; end: number; text: string };
type Candidate = { id: number; start: number; end: number; text: string; score: number; reason: string; sourceFile?: string; sourceOffsetSeconds?: number };
type LayoutCrop = { hasCam: boolean; cam?: number[]; game?: number[]; width?: number; height?: number; error?: string };
type Job = { id: string; filename: string; words: Word[]; candidates: Candidate[]; duration: number; transcriptAvailable: boolean; whisperModel: string; whisperLanguage: string; whisperDevice?: string; detectedLanguage?: string; transcriptionError?: string; status?: 'live' | 'stopping' | 'transcribing' | 'cancelling' | 'cancelled' | 'complete' | 'failed' | 'interrupted'; progress?: number; processedSeconds?: number; revision?: number; isLive?: boolean; streamUrl?: string; captureStartedAt?: number; layoutCrop?: LayoutCrop };
type CaptionStyle = 'pop' | 'clean' | 'neon' | 'classic';
const app = new Hono();
const root = process.cwd();
const dataRoot = join(root, 'data');
await mkdir(dataRoot, { recursive: true });
const savedClipsRoot = join(dataRoot, 'saved-clips');
await mkdir(savedClipsRoot, { recursive: true });
const zernioSettingsPath = join(dataRoot, 'zernio-settings.json');
const jobs = new Map<string, Job>();
const layoutProbeCache = new Map<string, LayoutCrop>();
let transcriptionBusy = false;
const liveControls = new Map<string, { stop: () => void }>();
const liveStopRequests = new Set<string>();
const transcriptionControls = new Map<string, { stop: () => void }>();
const transcriptionStopRequests = new Set<string>();
let savingClip = false;

type SavedClipMetadata = { id: string; jobId: string; jobFilename: string; filename: string; caption: string; savedAt: string };
async function listSavedClipRecords(): Promise<Array<SavedClipMetadata & { size: number }>> {
  const result: Array<SavedClipMetadata & { size: number }> = [];
  for (const entry of await readdir(savedClipsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[\da-f-]{36}\.json$/i.test(entry.name)) continue;
    try {
      const metadata = JSON.parse(await readFile(join(savedClipsRoot, entry.name), 'utf8')) as SavedClipMetadata;
      if (!/^[\da-f-]{36}$/i.test(metadata.id) || !/^[\da-f-]{36}$/i.test(metadata.jobId) || !/^clip-[\w.-]+\.mp4$/.test(metadata.filename)) continue;
      const file = Bun.file(join(savedClipsRoot, `${metadata.id}.mp4`));
      if (!(await file.exists()) || file.size < 1000) continue;
      result.push({ ...metadata, size: file.size });
    } catch { /* Ignore incomplete metadata records. */ }
  }
  return result.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
async function removeSavedClip(id: string) {
  await unlink(join(savedClipsRoot, `${id}.mp4`));
  await unlink(join(savedClipsRoot, `${id}.json`)).catch(() => {});
}

function run(command: string, args: string[], timeout = 60 * 60 * 1000, onSpawn?: (stop: () => void) => void): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const executable = isAbsolute(command) ? command : command.includes('/') || command.includes('\\') ? resolve(root, command) : Bun.which(command) || command;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([executable, ...args], { windowsHide: true, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    } catch (e) {
      reject(new Error(`Could not start ${command}. Check the setup instructions. ${e instanceof Error ? e.message : e}`));
      return;
    }
    onSpawn?.(() => child.kill());
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    Promise.all([new Response(child.stdout as ReadableStream<Uint8Array>).text(), new Response(child.stderr as ReadableStream<Uint8Array>).text(), child.exited])
      .then(([stdout, stderr, code]) => {
        clearTimeout(timer);
        if (timedOut) reject(new Error(`${command} timed out`));
        else if (code === 0) resolvePromise({ stdout, stderr });
        else reject(new Error(stderr.slice(-2500) || `${command} exited ${code}`));
      })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}
async function loadJob(id: string): Promise<Job | undefined> {
  if (!/^[\da-f-]{36}$/i.test(id)) return undefined;
  const cached = jobs.get(id);
  if (cached) return cached;
  try {
    const job = JSON.parse(await readFile(join(dataRoot, id, 'job.json'), 'utf8')) as Job;
    if (['live', 'stopping', 'transcribing', 'cancelling'].includes(job.status || '')) { job.status = 'interrupted'; job.transcriptionError = 'Server restarted while processing. Please start processing again.'; await writeFile(join(dataRoot, id, 'job.json'), JSON.stringify(job)); }
    jobs.set(id, job);
    return job;
  } catch {
    return undefined;
  }
}
function mergeCandidates(job: Job, suggestions: Candidate[]) {
  const added: Candidate[] = [];
  for (const suggestion of suggestions) {
    const existing = job.candidates.find(candidate => Math.abs(candidate.start - suggestion.start) < 18);
    if (existing) { if (suggestion.score > existing.score) Object.assign(existing, suggestion, { id: existing.id }); continue; }
    const candidate = { ...suggestion, id: Math.max(0, ...job.candidates.map(item => item.id)) + 1 };
    job.candidates.push(candidate); added.push(candidate);
  }
  job.candidates.sort((a, b) => a.start - b.start);
  return added;
}
async function saveJob(job: Job) { await writeFile(join(dataRoot, job.id, 'job.json'), JSON.stringify(job)); }
type ZernioSettings = {
  profileId?: string;
  selectedInstagramAccountId?: string;
  selectedInstagramUsername?: string;
  selectedYoutubeAccountId?: string;
  selectedYoutubeChannelTitle?: string;
};
async function readZernioSettings(): Promise<ZernioSettings> {
  try { return JSON.parse(await readFile(zernioSettingsPath, 'utf8')) as ZernioSettings; }
  catch { return {}; }
}
async function saveZernioSettings(settings: ZernioSettings) {
  await writeFile(zernioSettingsPath, JSON.stringify(settings, null, 2), 'utf8');
}
async function zernioRequest(path: string, init: RequestInit = {}) {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) throw new Error('Add ZERNIO_API_KEY to .env and restart the app to enable social publishing.');
  const response = await fetch(`https://zernio.com/api${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${key}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const raw = await response.text();
  let data: any = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw.slice(0, 500) }; }
  if (!response.ok) throw new Error(data.error || data.message || `Zernio returned ${response.status}.`);
  return data;
}
async function zernioProfile(settings: ZernioSettings) {
  if (settings.profileId) return settings.profileId;
  const found = await zernioRequest('/v1/profiles?name=Clipmocha%20Local');
  let profileId = found.profiles?.[0]?._id || found.profiles?.[0]?.id;
  if (!profileId) {
    const created = await zernioRequest('/v1/profiles', { method: 'POST', body: JSON.stringify({ name: 'Clipmocha Local', description: 'Local Clipmocha Social publishing' }) });
    profileId = created.profile?._id || created.profile?.id;
  }
  if (!profileId) throw new Error('Zernio did not return a profile ID.');
  settings.profileId = profileId;
  await saveZernioSettings(settings);
  return profileId as string;
}
async function zernioAccounts(profileId: string, platform?: string) {
  const query = platform ? `&platform=${encodeURIComponent(platform)}` : '';
  const data = await zernioRequest(`/v1/accounts?profileId=${encodeURIComponent(profileId)}${query}`);
  return (data.accounts || []).filter((account: any) => (!platform || account.platform === platform) && account.status !== 'disconnected');
}
async function zernioInstagramAccounts(profileId: string) {
  return zernioAccounts(profileId, 'instagram');
}
async function zernioYoutubeAccounts(profileId: string) {
  return zernioAccounts(profileId, 'youtube');
}
async function transcribeJob(job: Job, videoPath: string) {
  const isCancelled = () => transcriptionStopRequests.has(job.id);
  const markCancelled = async () => {
    job.status = 'cancelled';
    job.transcriptionError = undefined;
    await saveJob(job);
  };
  const registerStop = (stop: () => void) => {
    transcriptionControls.set(job.id, { stop });
    if (isCancelled()) stop();
  };
  try {
    const executable = resolve(root, '.venv/Scripts/python.exe');
    const child = Bun.spawn([executable, 'scripts/transcribe.py', videoPath, job.whisperModel, job.whisperLanguage], { windowsHide: true, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    registerStop(() => child.kill());
    const stderrPromise = new Response(child.stderr).text();
    const reader = child.stdout.getReader(); const decoder = new TextDecoder(); let buffer = ''; let lastPersist = 0;
    const consume = async (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'started') job.whisperDevice = event.executionDevice;
      if (event.type === 'reset') { job.words = []; job.candidates = []; job.progress = 0; job.processedSeconds = 0; job.revision = (job.revision || 0) + 1; job.detectedLanguage = undefined; job.whisperDevice = event.executionDevice; }
      if (event.type === 'segment') {
        job.words.push(...event.words); job.processedSeconds = Math.min(job.duration, event.progressSeconds); job.progress = Math.min(99, Math.round(job.processedSeconds / job.duration * 100));
        job.detectedLanguage = event.detectedLanguage; job.whisperDevice = event.executionDevice;
        const finalized = suggest(job.words).filter(candidate => candidate.end <= job.processedSeconds! - 8);
        const added = mergeCandidates(job, finalized);
        if (added.length || job.processedSeconds! - lastPersist >= 3) { lastPersist = job.processedSeconds!; await saveJob(job); }
      }
      if (event.type === 'done') { mergeCandidates(job, suggest(job.words)); job.transcriptAvailable = true; job.status = 'complete'; job.progress = 100; job.processedSeconds = job.duration; await saveJob(job); }
    };
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) await consume(line);
    }
    buffer += decoder.decode(); if (buffer.trim()) await consume(buffer);
    const code = await child.exited; const stderr = await stderrPromise;
    if (code !== 0) throw new Error(stderr.slice(-2500) || `Whisper exited ${code}`);
  } catch (error) {
    if (isCancelled()) { await markCancelled(); return; }
    job.transcriptionError = error instanceof Error ? error.message.split('\n')[0] : 'Whisper transcription did not complete.';
    try {
      job.words = []; job.candidates = []; job.revision = (job.revision || 0) + 1; job.transcriptAvailable = false;
      const audioPath = join(dataRoot, job.id, 'analysis.wav');
      await run('ffmpeg', ['-y','-i',videoPath,'-vn','-ac','1','-ar','8000','-c:a','pcm_s16le',audioPath], 60 * 60 * 1000, registerStop);
      if (isCancelled()) { await markCancelled(); return; }
      const ranked = await run(resolve(root, '.venv/Scripts/python.exe'), ['scripts/rank_audio.py', audioPath], 60 * 60 * 1000, registerStop);
      if (isCancelled()) { await markCancelled(); return; }
      job.candidates = JSON.parse(ranked.stdout) as Candidate[]; job.status = 'complete'; job.progress = 100; job.processedSeconds = job.duration;
    } catch (fallbackError) {
      if (isCancelled()) await markCancelled();
      else { job.status = 'failed'; job.transcriptionError += `; audio fallback failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`; }
    }
    await saveJob(job);
  } finally {
    transcriptionControls.delete(job.id);
    transcriptionStopRequests.delete(job.id);
    transcriptionBusy = false;
  }
}

const wait = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
function streamlinkHostAllowed(input: string) {
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) return false;
    // Twitch: https://www.twitch.tv/channelname
    if (url.hostname === 'twitch.tv' || url.hostname.endsWith('.twitch.tv')) {
      return /^\/(?:[\w-]+)\/?$/.test(url.pathname);
    }
    // YouTube: https://www.youtube.com/watch?v=... or /live/... or /@channel/live or /channel/...
    if (url.hostname === 'youtube.com' || url.hostname === 'www.youtube.com' || url.hostname === 'm.youtube.com') {
      return /^\/(watch|live\/[\w-]+|@[\w.-]+\/live|channel\/[\w-]+\/live)\/?/.test(url.pathname)
        || (url.pathname === '/watch' && Boolean(url.searchParams.get('v')));
    }
    // youtu.be short links
    if (url.hostname === 'youtu.be') {
      return /^\/[\w-]+\/?$/.test(url.pathname);
    }
    return false;
  } catch { return false; }
}
function streamPlatformName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'twitch.tv' || parsed.hostname.endsWith('.twitch.tv')) return 'Twitch';
    if (parsed.hostname.includes('youtube.com') || parsed.hostname === 'youtu.be') return 'YouTube';
  } catch {}
  return 'Stream';
}
function streamChannelName(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'twitch.tv' || parsed.hostname.endsWith('.twitch.tv')) {
      return parsed.pathname.split('/').filter(Boolean)[0] || 'stream';
    }
    if (parsed.hostname.includes('youtube.com')) {
      const atMatch = parsed.pathname.match(/\/@([\w.-]+)/);
      if (atMatch) return atMatch[1];
      const liveMatch = parsed.pathname.match(/\/live\/([\w-]+)/);
      if (liveMatch) return liveMatch[1];
      return parsed.searchParams.get('v') || 'stream';
    }
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.split('/').filter(Boolean)[0] || 'stream';
    }
  } catch {}
  return 'stream';
}
async function processLiveChunk(job: Job, rawPath: string, chunkNumber: number, offset: number, transcribe: (path: string) => Promise<{ words: Word[]; language?: string }>) {
  const dir = join(dataRoot, job.id); const chunkName = `chunk-${String(chunkNumber).padStart(5, '0')}.mp4`; const chunkPath = join(dir, chunkName);
  await run('ffmpeg', ['-y','-hide_banner','-loglevel','error','-i',rawPath,'-map','0','-c','copy','-movflags','+faststart',chunkPath], 10 * 60 * 1000);
  await unlink(rawPath).catch(() => {});
  const probe = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',chunkPath]);
  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || duration < 8) { await unlink(chunkPath).catch(() => {}); return offset; }
  const result = await transcribe(chunkPath);
  const globalWords = result.words.map(word => ({ ...word, start: word.start + offset, end: word.end + offset }));
  job.words.push(...globalWords); job.duration = Math.max(job.duration, offset + duration); job.processedSeconds = job.duration;
  if (result.language) job.detectedLanguage = result.language;
  const suggestions = suggest(result.words).map(candidate => ({ ...candidate, start: candidate.start + offset, end: candidate.end + offset, sourceFile: chunkName, sourceOffsetSeconds: offset }));
  mergeCandidates(job, suggestions);
  await saveJob(job);
  return offset + duration;
}

async function captureLive(job: Job, url: string) {
  let streamlink: ReturnType<typeof Bun.spawn> | undefined; let ffmpeg: ReturnType<typeof Bun.spawn> | undefined; let worker: ReturnType<typeof Bun.spawn> | undefined;
  let workerStdin: { write: (chunk: string | Uint8Array) => number; flush?: () => number | Promise<number>; end?: () => void } | undefined;
  let workerRead: Promise<void> | undefined;
  let pipePump: Promise<void> | undefined;
  try {
    const python = resolve(root, '.venv/Scripts/python.exe');
    worker = Bun.spawn([python, 'scripts/transcribe_worker.py', job.whisperModel, job.whisperLanguage], { windowsHide: true, cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    workerStdin = worker.stdin as typeof workerStdin; const reader = (worker.stdout as ReadableStream<Uint8Array>).getReader(); const decoder = new TextDecoder();
    let buffer = ''; let readyResolve!: (value: string) => void; let readyReject!: (reason: Error) => void;
    const ready = new Promise<string>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
    const pending = new Map<string, { words: Word[]; resolve: (value: { words: Word[]; language?: string }) => void; reject: (reason: Error) => void }>();
    workerRead = (async () => {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === 'ready') { job.whisperDevice = event.executionDevice; readyResolve(event.executionDevice); continue; }
          if (event.type === 'fatal') { readyReject(new Error(event.error)); continue; }
          const item = pending.get(event.id); if (!item) continue;
          if (event.type === 'started') job.whisperDevice = event.executionDevice;
          if (event.type === 'reset') { item.words.length = 0; job.whisperDevice = event.executionDevice; }
          if (event.type === 'segment') { item.words.push(...event.words); job.detectedLanguage = event.detectedLanguage; job.whisperDevice = event.executionDevice; }
          if (event.type === 'done') { pending.delete(event.id); item.resolve({ words: item.words, language: job.detectedLanguage }); }
          if (event.type === 'error') { pending.delete(event.id); item.reject(new Error(event.error)); }
        }
      }
    })();
    streamlink = Bun.spawn([python, '-m', 'streamlink', '--loglevel','warning','--stdout',url,'best'], { windowsHide: true, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const rawPattern = join(dataRoot, job.id, 'raw-%05d.ts');
    ffmpeg = Bun.spawn(['ffmpeg','-y','-hide_banner','-loglevel','error','-i','pipe:0','-map','0','-c','copy','-f','segment','-segment_time','60','-reset_timestamps','1','-segment_format','mpegts',rawPattern], { windowsHide: true, cwd: root, stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
    const streamErr = new Response(streamlink.stderr as ReadableStream<Uint8Array>).text(); const ffmpegErr = new Response(ffmpeg.stderr as ReadableStream<Uint8Array>).text();
    let stopped = liveStopRequests.has(job.id); let streamEnded = false; let ffmpegEnded = false;
    const streamExit = streamlink.exited.then(code => { streamEnded = true; return code; });
    const ffmpegExit = ffmpeg.exited.then(code => { ffmpegEnded = true; return code; });
    const streamReader = (streamlink.stdout as ReadableStream<Uint8Array>).getReader();
    const ffmpegStdin = ffmpeg.stdin as { write: (chunk: Uint8Array) => number; flush?: () => number | Promise<number>; end?: () => void };
    liveControls.set(job.id, { stop: () => { stopped = true; streamlink?.kill(); } });
    if (stopped) streamlink.kill();
    pipePump = (async () => {
      try { while (true) { const { value, done } = await streamReader.read(); if (done) break; ffmpegStdin.write(value); await Promise.resolve(ffmpegStdin.flush?.()); } }
      catch { /* The pipeline may close when Streamlink or FFmpeg exits. */ }
      finally { try { ffmpegStdin.end?.(); } catch {} }
    })();
    await ready;
    const transcribe = (path: string) => new Promise<{ words: Word[]; language?: string }>((resolveResult, rejectResult) => {
      const id = randomUUID(); pending.set(id, { words: [], resolve: resolveResult, reject: rejectResult });
      try { workerStdin!.write(`${JSON.stringify({ id, path })}\n`); Promise.resolve(workerStdin!.flush?.()).catch(error => { pending.delete(id); rejectResult(error); }); }
      catch (error) { pending.delete(id); rejectResult(error instanceof Error ? error : new Error(String(error))); }
    });
    let offset = 0; let nextChunk = 0;
    while (!streamEnded && !ffmpegEnded && !stopped) {
      const chunks = (await Array.fromAsync(new Bun.Glob('raw-*.ts').scan({ cwd: join(dataRoot, job.id) }))).sort();
      const readyChunks = chunks.slice(0, Math.max(0, chunks.length - 1));
      for (const name of readyChunks) {
        if (Number(name.match(/raw-(\d+)\.ts/)?.[1]) !== nextChunk) continue;
        offset = await processLiveChunk(job, join(dataRoot, job.id, name), nextChunk, offset, transcribe); nextChunk++;
      }
      await wait(1200);
    }
    if (!streamEnded && (ffmpegEnded || stopped)) streamlink.kill();
    const streamCode = await streamExit; await pipePump; const ffmpegCode = await ffmpegExit;
    const [streamErrorText, ffmpegErrorText] = await Promise.all([streamErr, ffmpegErr]);
    if (ffmpegCode !== 0 && !stopped) throw new Error(ffmpegErrorText.slice(-1800) || `FFmpeg stream capture exited ${ffmpegCode}`);
    if (streamCode !== 0 && !stopped && !job.duration) throw new Error(streamErrorText.slice(-1800) || 'Streamlink could not open this live stream.');
    const finalChunks = (await Array.fromAsync(new Bun.Glob('raw-*.ts').scan({ cwd: join(dataRoot, job.id) }))).sort();
    for (const name of finalChunks) {
      if (Number(name.match(/raw-(\d+)\.ts/)?.[1]) !== nextChunk) continue;
      offset = await processLiveChunk(job, join(dataRoot, job.id, name), nextChunk, offset, transcribe); nextChunk++;
    }
    if (!job.duration) throw new Error('No video segments were captured. Check that the stream is live and publicly accessible.');
    job.status = 'complete'; job.progress = 100; job.processedSeconds = job.duration; await saveJob(job);
  } catch (error) {
    job.status = 'failed'; job.transcriptionError = error instanceof Error ? error.message.split('\n')[0] : 'Live capture failed.';
    await saveJob(job);
  } finally {
    liveControls.delete(job.id);
    liveStopRequests.delete(job.id);
    try { workerStdin?.end?.(); } catch {}
    if (worker) { worker.kill(); await worker.exited.catch(() => {}); }
    await workerRead?.catch(() => {});
    if (streamlink) { streamlink.kill(); await streamlink.exited.catch(() => {}); }
    if (ffmpeg) { ffmpeg.kill(); await ffmpeg.exited.catch(() => {}); }
    await pipePump?.catch(() => {});
    transcriptionBusy = false;
  }
}
function suggest(words: Word[]): Candidate[] {
  if (!words.length) return [];
  const groups: Word[][] = [];
  let group: Word[] = [];
  for (const word of words) {
    if (group.length && word.start - group[group.length - 1]!.end > 1.1) { groups.push(group); group = []; }
    group.push(word);
  }
  if (group.length) groups.push(group);
  const phrases: Candidate[] = [];
  const signals = /\b(wow|wait|what|why|how|insane|crazy|unbelievable|actually|secret|never|best|worst|mistake|truth|imagine|because|but|holy|damn|incredible|first time|no way)\b/i;
  for (const g of groups) {
    let a = 0;
    while (a < g.length) {
      let b = a;
      while (b + 1 < g.length && g[b + 1]!.end - g[a]!.start < 48) b++;
      if (b - a >= 11) {
        const span = g.slice(a, b + 1); const text = span.map(x => x.text).join(' ');
        const marks = (text.match(/[!?]/g) || []).length;
        const matches = (text.match(new RegExp(signals.source, 'gi')) || []).length;
        const duration = span.at(-1)!.end - span[0]!.start;
        let score = Math.min(55, 22 + matches * 7 + marks * 2 + Math.min(12, span.length / 3));
        if (duration < 12) score -= 10;
        phrases.push({ id: 0, start: Math.max(0, span[0]!.start - 1.5), end: span.at(-1)!.end + 1, text, score: Math.round(score), reason: matches ? 'Strong hook or emphasis in the transcript' : 'Self-contained speech segment to review' });
      }
      a = Math.max(a + 1, b - 7);
    }
  }
  const unique: Candidate[] = [];
  phrases.sort((x, y) => y.score - x.score);
  for (const p of phrases) if (!unique.some(x => Math.abs(x.start - p.start) < 18)) unique.push({ ...p, id: unique.length + 1 });
  return unique.slice(0, 20).sort((x, y) => x.start - y.start).map((x, i) => ({ ...x, id: i + 1 }));
}

const assStyles: Record<CaptionStyle, string> = {
  // ASS karaoke uses SecondaryColour for upcoming words, then fills to PrimaryColour as spoken.
  // Keep all presets white with a black outline and the active word in bright yellow.
  pop: 'Style: Pop,Arial,64,&H003BEBFF,&H00FFFFFF,&H00000000,&H66000000,-1,0,0,0,100,100,0,0,1,3,1,2,70,70,650,1',
  clean: 'Style: Clean,Arial,58,&H003BEBFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,2,70,70,650,1',
  neon: 'Style: Neon,Arial,60,&H003BEBFF,&H00FFFFFF,&H00000000,&H70090909,-1,0,0,0,100,100,0,0,1,3,1,2,70,70,650,1',
  classic: 'Style: Classic,Montserrat ExtraBold,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,7,3,5,60,60,0,1',
};
function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000); const m = Math.floor((cs % 360000) / 6000); const s = Math.floor((cs % 6000) / 100); const c = cs % 100;
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(c).padStart(2,'0')}`;
}
function makeAss(words: Word[], start: number, end: number, style: CaptionStyle): string {
  const selected = words.filter(w => w.end > start && w.start < end && w.text.trim());
  if (style === 'classic') {
    const groups: Word[][] = [];
    let line: Word[] = [];
    for (const word of selected) {
      const previous = line.at(-1);
      if (line.length >= 3 || (previous && /[.!?]$/.test(previous.text.trim()))
          || (previous && word.start - previous.end > 0.6)) {
        if (line.length) groups.push(line);
        line = [];
      }
      line.push(word);
    }
    if (line.length) groups.push(line);
    const events: string[] = [];
    groups.forEach((group, groupIndex) => {
      const nextGroupStart = groups[groupIndex + 1]?.[0]?.start ?? end;
      const groupEnd = Math.min(end, group.at(-1)!.end + 0.15, nextGroupStart);
      group.forEach((active, activeIndex) => {
        const cueStart = Math.max(0, active.start - start);
        const nextWordStart = group[activeIndex + 1]?.start;
        const cueEnd = Math.min(end - start, nextWordStart === undefined ? groupEnd - start : nextWordStart - start);
        let text = '';
        let plainLine = '';
        let lineCount = 1;
        group.forEach((word, wordIndex) => {
          const token = word.text.trim().toLocaleUpperCase().replace(/[{}]/g, '');
          const separator = /^[.,!?;:%)}\]]/.test(token) ? '' : (plainLine ? ' ' : '');
          if (plainLine && plainLine.length + separator.length + token.length > 22 && lineCount === 1) {
            text += '\\N';
            plainLine = '';
            lineCount++;
          }
          const gap = /^[.,!?;:%)}\]]/.test(token) ? '' : (plainLine ? ' ' : '');
          text += `${gap}${wordIndex === activeIndex ? '{\\c&H00E5FF&\\fscx112\\fscy112}' : ''}${token}${wordIndex === activeIndex ? '{\\r}' : ''}`;
          plainLine += gap + token;
        });
        events.push(`Dialogue: 0,${assTime(cueStart)},${assTime(Math.max(cueStart + 0.08, cueEnd))},Classic,,0,0,0,,{\\pos(540,1250)}${text}`);
      });
    });
    if (!events.length) return '';
    return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${assStyles.classic}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join('\n')}\n`;
  }
  const groups: Word[][] = []; let group: Word[] = [];
  const join = (items: Word[]) => items.reduce((out, word) => {
    const token = word.text.trim();
    return out + (/^[.,!?;:%)}\]]/.test(token) ? '' : (out ? ' ' : '')) + token;
  }, '');
  for (const word of selected) {
    const candidate = [...group, word];
    if (group.length && (candidate.length > 5 || word.end - group[0]!.start > 2.5 || join(candidate).length > 34)) { groups.push(group); group = []; }
    group.push(word);
    if (/[.!?]$/.test(word.text.trim()) && group.length >= 2) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  const events = groups.map(group => {
    let line = ''; let text = ''; let lineCount = 1;
    for (const word of group) {
      const token = word.text.trim().toLocaleUpperCase();
      const separator = /^[.,!?;:%)}\]]/.test(token) ? '' : (line ? ' ' : '');
      if (line && line.length + separator.length + token.length > 22 && lineCount === 1) { text += '\\N'; line = ''; lineCount++; }
      const gap = /^[.,!?;:%)}\]]/.test(token) ? '' : (line ? ' ' : '');
      const duration = Math.max(2, Math.round((word.end - word.start) * 100));
      text += `${gap}{\\kf${duration}}${token.replace(/[{}]/g, '')}`;
      line += gap + token;
    }
    const cueStart = Math.max(0, group[0]!.start - start); const cueEnd = Math.min(end, group.at(-1)!.end) - start;
    const styleName = `${style[0]!.toUpperCase()}${style.slice(1)}`;
    return `Dialogue: 0,${assTime(cueStart)},${assTime(Math.max(cueStart + 0.35, cueEnd))},${styleName},,0,0,0,,{\\fad(90,100)}${text}`;
  });
  if (!events.length) return '';
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\n${assStyles[style]}\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join('\n')}\n`;
}

app.get('/api/status', c => c.json({ aiEnabled: Boolean(process.env.OPENROUTER_API_KEY), model: process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite' }));
app.get('/api/social/instagram/status', async c => {
  if (!process.env.ZERNIO_API_KEY) return c.json({ configured: false, accounts: [] });
  try {
    const settings = await readZernioSettings();
    if (!settings.profileId) return c.json({ configured: true, accounts: [], selectedAccountId: '' });
    const accounts = await zernioInstagramAccounts(settings.profileId);
    if (!settings.selectedInstagramAccountId && accounts.length === 1) {
      settings.selectedInstagramAccountId = accounts[0]._id || accounts[0].id;
      settings.selectedInstagramUsername = accounts[0].username || accounts[0].name || '';
      await saveZernioSettings(settings);
    }
    const listed = accounts.map((account: any) => ({ id: account._id || account.id, username: account.username || account.name || '', displayName: account.displayName || account.name || account.username || 'Instagram account' }));
    if (settings.selectedInstagramAccountId && !listed.some(account => account.id === settings.selectedInstagramAccountId)) {
      listed.push({ id: settings.selectedInstagramAccountId, username: settings.selectedInstagramUsername || '', displayName: settings.selectedInstagramUsername ? `@${settings.selectedInstagramUsername} (checking connection)` : 'Instagram account (checking connection)' });
    }
    return c.json({ configured: true, accounts: listed, selectedAccountId: settings.selectedInstagramAccountId || '' });
  } catch (error) {
    return c.json({ configured: true, accounts: [], error: error instanceof Error ? error.message : 'Could not load Instagram accounts.' });
  }
});
app.post('/api/social/instagram/connect', async c => {
  try {
    const settings = await readZernioSettings();
    const profileId = await zernioProfile(settings);
    const redirectUrl = new URL('/api/social/instagram/callback', c.req.url).toString();
    const data = await zernioRequest(`/v1/connect/instagram?profileId=${encodeURIComponent(profileId)}&loginMethod=instagram_login&scopes=posting&redirect_url=${encodeURIComponent(redirectUrl)}`);
    if (!data.authUrl) throw new Error('Zernio did not return an Instagram authorization link.');
    return c.json({ authUrl: data.authUrl });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not start Instagram connection.' }, 502);
  }
});
app.get('/api/social/instagram/callback', async c => {
  const query = c.req.query();
  const settings = await readZernioSettings();
  if (query.profileId && (!settings.profileId || settings.profileId === query.profileId)) settings.profileId = query.profileId;
  const connected = query.connected === 'instagram' || query.connected === 'true';
  if (connected && settings.profileId) {
    if (query.accountId) settings.selectedInstagramAccountId = query.accountId;
    if (query.username) settings.selectedInstagramUsername = query.username.replace(/^@/, '');
    if (query.accountId) {
      try {
        const accounts = await zernioInstagramAccounts(settings.profileId);
        const account = accounts.find((item: any) => (item._id || item.id) === query.accountId);
        if (account) settings.selectedInstagramUsername = account.username || account.name || settings.selectedInstagramUsername;
      } catch { /* The callback can arrive just before the account appears in the API list. */ }
    }
    await saveZernioSettings(settings);
    return c.redirect('/?instagram=connected');
  }
  await saveZernioSettings(settings);
  const reason = query.error_message || query.error || query.error_reason || query.stage || 'connection_incomplete';
  return c.redirect(`/?instagram_error=${encodeURIComponent(reason)}`);
});
app.get('/api/social/youtube/status', async c => {
  if (!process.env.ZERNIO_API_KEY) return c.json({ configured: false, accounts: [] });
  try {
    const settings = await readZernioSettings();
    if (!settings.profileId) return c.json({ configured: true, accounts: [], selectedAccountId: '', selectedChannelTitle: '' });
    const accounts = await zernioYoutubeAccounts(settings.profileId);
    if (!settings.selectedYoutubeAccountId && accounts.length === 1) {
      settings.selectedYoutubeAccountId = accounts[0]._id || accounts[0].id;
      settings.selectedYoutubeChannelTitle = accounts[0].displayName || accounts[0].title || accounts[0].name || accounts[0].username || '';
      await saveZernioSettings(settings);
    }
    const listed = accounts.map((account: any) => ({
      id: account._id || account.id,
      displayName: account.displayName || account.title || account.name || account.username || 'YouTube Channel',
      username: account.username || account.name || '',
    }));
    if (settings.selectedYoutubeAccountId && !listed.some(a => a.id === settings.selectedYoutubeAccountId)) {
      listed.push({
        id: settings.selectedYoutubeAccountId,
        displayName: settings.selectedYoutubeChannelTitle ? `${settings.selectedYoutubeChannelTitle} (checking connection)` : 'YouTube Channel (checking connection)',
        username: '',
      });
    }
    return c.json({ configured: true, accounts: listed, selectedAccountId: settings.selectedYoutubeAccountId || '', selectedChannelTitle: settings.selectedYoutubeChannelTitle || '' });
  } catch (error) {
    return c.json({ configured: true, accounts: [], error: error instanceof Error ? error.message : 'Could not load YouTube channels.' });
  }
});
app.post('/api/social/youtube/connect', async c => {
  try {
    const settings = await readZernioSettings();
    const profileId = await zernioProfile(settings);
    const redirectUrl = new URL('/api/social/youtube/callback', c.req.url).toString();
    const data = await zernioRequest(`/v1/connect/youtube?profileId=${encodeURIComponent(profileId)}&redirect_url=${encodeURIComponent(redirectUrl)}`);
    if (!data.authUrl) throw new Error('Zernio did not return a YouTube authorization link.');
    return c.json({ authUrl: data.authUrl });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not start YouTube connection.' }, 502);
  }
});
app.get('/api/social/youtube/callback', async c => {
  const query = c.req.query();
  const settings = await readZernioSettings();
  if (query.profileId && (!settings.profileId || settings.profileId === query.profileId)) settings.profileId = query.profileId;
  const connected = query.connected === 'youtube' || query.connected === 'true' || Boolean(query.accountId);
  if (connected && settings.profileId) {
    if (query.accountId) settings.selectedYoutubeAccountId = query.accountId;
    try {
      const accounts = await zernioYoutubeAccounts(settings.profileId);
      const account = accounts.find((item: any) => (item._id || item.id) === (query.accountId || settings.selectedYoutubeAccountId)) || accounts[0];
      if (account) {
        settings.selectedYoutubeAccountId = account._id || account.id;
        settings.selectedYoutubeChannelTitle = account.displayName || account.title || account.name || account.username || settings.selectedYoutubeChannelTitle || 'YouTube Channel';
      }
    } catch {}
    await saveZernioSettings(settings);
    return c.redirect('/?youtube=connected');
  }
  await saveZernioSettings(settings);
  const reason = query.error_message || query.error || query.error_reason || query.stage || 'connection_incomplete';
  return c.redirect(`/?youtube_error=${encodeURIComponent(reason)}`);
});
app.post('/api/social/youtube/select', async c => {
  try {
    const body = await c.req.json() as { accountId?: string };
    const settings = await readZernioSettings();
    if (!settings.profileId || !body.accountId) return c.json({ error: 'Connect a YouTube channel first.' }, 400);
    const accounts = await zernioYoutubeAccounts(settings.profileId);
    const account = accounts.find((item: any) => (item._id || item.id) === body.accountId);
    if (!account) return c.json({ error: 'That YouTube channel is not connected to this Zernio profile.' }, 400);
    settings.selectedYoutubeAccountId = body.accountId;
    settings.selectedYoutubeChannelTitle = account.displayName || account.title || account.name || account.username || '';
    await saveZernioSettings(settings);
    return c.json({ selectedAccountId: body.accountId, selectedChannelTitle: settings.selectedYoutubeChannelTitle });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not select YouTube channel.' }, 502);
  }
});
app.get('/api/clips', async c => {
  try {
    const clips = await listSavedClipRecords();
    return c.json({ limit: 10, count: clips.length, clips: clips.map(clip => ({
      ...clip,
      streamUrl: `/api/clips/${clip.id}/stream`,
      downloadUrl: `/api/clips/${clip.id}/download`,
    })) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not load saved clips.' }, 500);
  }
});
app.post('/api/clips/:jobId/:filename/save', async c => {
  const jobId = c.req.param('jobId');
  const filename = c.req.param('filename');
  if (!/^[\da-f-]{36}$/i.test(jobId) || !/^clip-[\w.-]+\.mp4$/.test(filename)) return c.json({ error: 'Invalid candidate clip.' }, 400);
  if (savingClip) return c.json({ error: 'Another clip is being saved. Try again in a moment.' }, 409);
  savingClip = true;
  try {
    const existingSaved = await listSavedClipRecords();
    const alreadySaved = existingSaved.find(clip => clip.jobId === jobId && clip.filename === filename);
    if (alreadySaved) {
      await unlink(join(dataRoot, jobId, filename)).catch(() => {});
      await unlink(join(dataRoot, jobId, `${filename}.json`)).catch(() => {});
      return c.json({ saved: true, id: alreadySaved.id, count: existingSaved.length, limit: 10 });
    }
    if (existingSaved.length >= 10) return c.json({ error: 'Your saved clips are full (10 of 10). Delete a saved clip before saving another.', count: 10, limit: 10 }, 409);
    const sourcePath = join(dataRoot, jobId, filename);
    const source = Bun.file(sourcePath);
    if (!(await source.exists()) || source.size < 1000) return c.json({ error: 'Render this candidate clip before saving it.' }, 404);
    const job = await loadJob(jobId);
    const sourceMetadata = await readFile(join(dataRoot, jobId, `${filename}.json`), 'utf8').then(JSON.parse).catch(() => ({}));
    const id = randomUUID();
    const metadata: SavedClipMetadata = { id, jobId, jobFilename: job?.filename || 'Saved clip', filename, caption: sourceMetadata.caption || '', savedAt: new Date().toISOString() };
    await writeFile(join(savedClipsRoot, `${id}.json`), JSON.stringify(metadata), 'utf8');
    try { await rename(sourcePath, join(savedClipsRoot, `${id}.mp4`)); }
    catch (error) { await unlink(join(savedClipsRoot, `${id}.json`)).catch(() => {}); throw error; }
    await unlink(join(dataRoot, jobId, `${filename}.json`)).catch(() => {});
    return c.json({ saved: true, id, count: existingSaved.length + 1, limit: 10 });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not save this clip.' }, 500);
  } finally {
    savingClip = false;
  }
});
app.get('/api/clips/:id/stream', async c => {
  const id = c.req.param('id');
  if (!/^[\da-f-]{36}$/i.test(id)) return c.text('Invalid saved clip.', 400);
  const file = Bun.file(join(savedClipsRoot, `${id}.mp4`));
  if (!(await file.exists())) return c.text('Saved clip not found.', 404);
  const size = file.size;
  const range = c.req.header('range');
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[2] && match[1] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    return new Response(file.slice(start, end + 1).stream(), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
  }
  return new Response(file.stream(), { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
});
app.get('/api/clips/:id/download', async c => {
  const id = c.req.param('id');
  if (!/^[\da-f-]{36}$/i.test(id)) return c.text('Invalid saved clip.', 400);
  try {
    const metadata = JSON.parse(await readFile(join(savedClipsRoot, `${id}.json`), 'utf8')) as SavedClipMetadata;
    const bytes = await readFile(join(savedClipsRoot, `${id}.mp4`));
    return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${metadata.filename}"` } });
  } catch { return c.text('Saved clip not found.', 404); }
});
app.delete('/api/clips/:id', async c => {
  const id = c.req.param('id');
  if (!/^[\da-f-]{36}$/i.test(id)) return c.json({ error: 'Invalid saved clip.' }, 400);
  try { await removeSavedClip(id); return c.json({ deleted: true }); }
  catch { return c.json({ error: 'Saved clip not found.' }, 404); }
});
app.delete('/api/clips', async c => {
  let body: { ids?: string[] };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Select saved clips to delete.' }, 400); }
  const ids = [...new Set(body.ids || [])];
  if (!ids.length || ids.some(id => !/^[\da-f-]{36}$/i.test(id))) return c.json({ error: 'Select one or more valid saved clips.' }, 400);
  if (ids.length > 10) return c.json({ error: 'A maximum of 10 saved clips can be deleted at once.' }, 400);
  let deletedCount = 0;
  for (const id of ids) {
    try { await removeSavedClip(id); deletedCount++; } catch { /* Continue deleting the rest of the selection. */ }
  }
  return c.json({ deletedCount, count: (await listSavedClipRecords()).length });
});
app.post('/api/social/instagram/select', async c => {
  try {
    const body = await c.req.json() as { accountId?: string };
    const settings = await readZernioSettings();
    if (!settings.profileId || !body.accountId) return c.json({ error: 'Connect an Instagram account first.' }, 400);
    const accounts = await zernioInstagramAccounts(settings.profileId);
    const account = accounts.find((item: any) => (item._id || item.id) === body.accountId);
    if (!account) return c.json({ error: 'That Instagram account is not connected to this Zernio profile.' }, 400);
    settings.selectedInstagramAccountId = body.accountId;
    settings.selectedInstagramUsername = account.username || account.name || '';
    await saveZernioSettings(settings);
    return c.json({ selectedAccountId: body.accountId });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Could not select Instagram account.' }, 502);
  }
});
async function publishClipSocial(jobId: string, options: {
  filename: string;
  platforms?: Array<'instagram' | 'youtube'>;
  title?: string;
  caption?: string;
  youtubeDescription?: string;
  visibility?: 'public' | 'unlisted' | 'private';
}) {
  const job = await loadJob(jobId);
  if (!job) throw new Error('Job not found.');
  if (!options.filename || !/^clip-[\w.-]+\.mp4$/.test(options.filename)) {
    throw new Error('Render a clip before publishing it.');
  }

  const requestedPlatforms = Array.isArray(options.platforms) && options.platforms.length > 0
    ? options.platforms.filter(p => ['instagram', 'youtube'].includes(p))
    : ['instagram'];
  if (!requestedPlatforms.length) {
    throw new Error('Select at least one platform (Instagram or YouTube) to publish to.');
  }

  const settings = await readZernioSettings();
  if (!settings.profileId) {
    throw new Error('Connect your social media account through Zernio first.');
  }

  if (requestedPlatforms.includes('instagram')) {
    if (!settings.selectedInstagramAccountId) throw new Error('Connect and select an Instagram account first.');
    const accounts = await zernioInstagramAccounts(settings.profileId);
    if (!accounts.some((a: any) => (a._id || a.id) === settings.selectedInstagramAccountId)) {
      throw new Error('The selected Instagram account is no longer connected. Refresh and select it again.');
    }
  }

  if (requestedPlatforms.includes('youtube')) {
    if (!settings.selectedYoutubeAccountId) throw new Error('Connect and select a YouTube channel first.');
    const accounts = await zernioYoutubeAccounts(settings.profileId);
    if (!accounts.some((a: any) => (a._id || a.id) === settings.selectedYoutubeAccountId)) {
      throw new Error('The selected YouTube channel is no longer connected. Refresh and select it again.');
    }
  }

  let file = Bun.file(join(dataRoot, job.id, options.filename));
  if (!(await file.exists())) {
    const saved = (await listSavedClipRecords()).find(clip => clip.jobId === job.id && clip.filename === options.filename);
    if (saved) file = Bun.file(join(savedClipsRoot, `${saved.id}.mp4`));
  }
  if (!(await file.exists())) throw new Error('Rendered clip not found. Render it again before publishing.');

  if (requestedPlatforms.includes('instagram') && file.size > 300 * 1024 * 1024) {
    throw new Error('Instagram Reels are limited to 300 MB. Export a shorter clip and try again.');
  }

  const caption = (options.caption || '').trim();
  if (requestedPlatforms.includes('instagram') && caption.length > 2200) {
    throw new Error('Instagram captions can be at most 2,200 characters.');
  }

  const ytTitle = (options.title || caption.slice(0, 95) || `${job.filename} #Shorts`).trim().slice(0, 100);
  const ytDesc = (options.youtubeDescription || caption || '').trim().slice(0, 5000);
  const visibility = options.visibility || 'public';

  const presigned = await zernioRequest('/v1/media/presign', {
    method: 'POST',
    body: JSON.stringify({ filename: options.filename, contentType: 'video/mp4', size: file.size }),
  });
  const uploaded = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: file,
  });
  if (!uploaded.ok) throw new Error(`Zernio media upload failed (${uploaded.status}).`);

  const postPlatforms: any[] = [];
  if (requestedPlatforms.includes('instagram')) {
    postPlatforms.push({
      platform: 'instagram',
      accountId: settings.selectedInstagramAccountId,
    });
  }
  if (requestedPlatforms.includes('youtube')) {
    postPlatforms.push({
      platform: 'youtube',
      accountId: settings.selectedYoutubeAccountId,
      platformSpecificData: {
        title: ytTitle,
        description: ytDesc,
        visibility,
      },
    });
  }

  const hashContent = `${requestedPlatforms.join('-')}:${ytTitle.slice(0, 30)}:${caption.slice(0, 30)}`;
  const hashKey = hashContent.split('').reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261).toString(36);

  const post = await zernioRequest('/v1/posts', {
    method: 'POST',
    headers: { 'Idempotency-Key': `${job.id}-${options.filename}-${hashKey}`.slice(0, 255) },
    body: JSON.stringify({
      content: caption || ytDesc || ytTitle,
      mediaItems: [{ type: 'video', url: presigned.publicUrl }],
      platforms: postPlatforms,
      publishNow: true,
    }),
  });

  const created = post.post || post;
  const instaResult = created.platforms?.find((item: any) => item.platform === 'instagram');
  const ytResult = created.platforms?.find((item: any) => item.platform === 'youtube');

  return {
    status: created.status || 'submitted',
    postId: created._id || created.id || '',
    results: {
      instagram: instaResult ? {
        status: instaResult.status || 'submitted',
        postUrl: instaResult.platformPostUrl || created.platformPostUrl || created.url || '',
      } : null,
      youtube: ytResult ? {
        status: ytResult.status || 'submitted',
        postUrl: ytResult.platformPostUrl || created.platformPostUrl || created.url || '',
      } : null,
    },
    postUrl: ytResult?.platformPostUrl || instaResult?.platformPostUrl || created.platformPostUrl || created.url || '',
  };
}

app.post('/api/jobs/:id/publish-social', async c => {
  try {
    const body = await c.req.json();
    const result = await publishClipSocial(c.req.param('id'), body);
    return c.json(result);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Social publishing failed.' }, 502);
  }
});

app.post('/api/jobs/:id/publish-instagram', async c => {
  try {
    const body = await c.req.json() as { filename?: string; caption?: string };
    const result = await publishClipSocial(c.req.param('id'), {
      filename: body.filename || '',
      platforms: ['instagram'],
      caption: body.caption,
    });
    return c.json({
      status: result.results.instagram?.status || result.status,
      postUrl: result.results.instagram?.postUrl || result.postUrl,
      postId: result.postId,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Instagram publishing failed.' }, 502);
  }
});

app.post('/api/jobs/:id/publish-youtube', async c => {
  try {
    const body = await c.req.json() as { filename?: string; title?: string; caption?: string; description?: string; visibility?: any };
    const result = await publishClipSocial(c.req.param('id'), {
      filename: body.filename || '',
      platforms: ['youtube'],
      title: body.title,
      caption: body.caption,
      youtubeDescription: body.description,
      visibility: body.visibility,
    });
    return c.json({
      status: result.results.youtube?.status || result.status,
      postUrl: result.results.youtube?.postUrl || result.postUrl,
      postId: result.postId,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'YouTube publishing failed.' }, 502);
  }
});
app.post('/api/process', async c => {
  if (transcriptionBusy) return c.json({ error: 'Another video is still processing. Wait for it to finish before selecting another.' }, 429);
  transcriptionBusy = true;
  let workerStarted = false;
  try {
    const file = c.req.raw.body; const size = Number(c.req.header('content-length') || 0);
    if (!file) return c.json({ error: 'Choose a video file first.' }, 400);
    if (size > 20 * 1024 * 1024 * 1024) return c.json({ error: 'The file exceeds the 20 GB MVP limit.' }, 413);
    const id = randomUUID(); const dir = join(dataRoot, id); await mkdir(dir, { recursive: true });
    // Hono has already decoded URL query values; decoding again breaks names containing a literal "%".
    const filename = (c.req.query('filename') || 'source.mp4').split(/[\\/]/).at(-1)!;
    const requestedModel = c.req.query('model') || 'large-v3';
    const requestedLanguage = c.req.query('language') || 'en';
    const whisperLanguage = /^[a-z]{2,3}$/.test(requestedLanguage) || requestedLanguage === 'auto' ? requestedLanguage : 'en';
    let whisperModel = ['small.en', 'medium.en', 'small', 'medium', 'large-v3'].includes(requestedModel) ? requestedModel : 'medium.en';
    if (whisperLanguage !== 'en' && whisperLanguage !== 'auto') {
      if (whisperModel === 'small.en') whisperModel = 'small';
      if (whisperModel === 'medium.en') whisperModel = 'medium';
    }
    const suffix = extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
    const videoPath = join(dir, `source${suffix}`); await Bun.write(videoPath, new Response(file));
    const probe = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',videoPath]);
    const duration = Number(probe.stdout.trim()); if (!Number.isFinite(duration)) throw new Error('Could not read video duration.');
    const job: Job = { id, filename, words: [], candidates: [], duration, transcriptAvailable: true, whisperModel, whisperLanguage, status: 'transcribing', progress: 0, processedSeconds: 0, revision: 0 };
    jobs.set(id, job); await saveJob(job);
    workerStarted = true;
    void transcribeJob(job, videoPath);
    return c.json(job);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Processing failed.' }, 500); }
  finally { if (!workerStarted) transcriptionBusy = false; }
});
app.post('/api/live', async c => {
  if (transcriptionBusy) return c.json({ error: 'Another video is still being processed. Stop it before starting a live stream.' }, 429);
  let body: { url?: string; model?: string; language?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: 'Provide the live stream URL as JSON.' }, 400); }
  const url = (body.url || '').trim();
  if (!streamlinkHostAllowed(url)) return c.json({ error: 'Enter a public Twitch or YouTube live stream URL, e.g. https://www.twitch.tv/channelname or https://www.youtube.com/watch?v=...' }, 400);
  transcriptionBusy = true;
  try {
    const id = randomUUID(); const dir = join(dataRoot, id); await mkdir(dir, { recursive: true });
    const requestedLanguage = body.language || 'en';
    const whisperLanguage = /^[a-z]{2,3}$/.test(requestedLanguage) || requestedLanguage === 'auto' ? requestedLanguage : 'en';
    let whisperModel = ['small.en', 'medium.en', 'small', 'medium', 'large-v3'].includes(body.model || '') ? body.model! : 'large-v3';
    if (whisperLanguage !== 'en' && whisperLanguage !== 'auto') {
      if (whisperModel === 'small.en') whisperModel = 'small';
      if (whisperModel === 'medium.en') whisperModel = 'medium';
    }
    const channel = streamChannelName(url);
    const platform = streamPlatformName(url);
    const job: Job = { id, filename: `Live: ${channel} (${platform})`, words: [], candidates: [], duration: 0, transcriptAvailable: true, whisperModel, whisperLanguage, status: 'live', progress: 0, processedSeconds: 0, revision: 0, isLive: true, streamUrl: url, captureStartedAt: Date.now() };
    jobs.set(id, job); await saveJob(job);
    void captureLive(job, url);
    return c.json(job);
  } catch (error) {
    transcriptionBusy = false;
    return c.json({ error: error instanceof Error ? error.message : 'Could not start live capture.' }, 500);
  }
});
app.post('/api/jobs/:id/stop-live', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job || !job.isLive) return c.json({ error: 'Live job not found.' }, 404);
  const control = liveControls.get(job.id);
  job.status = 'stopping'; await saveJob(job); liveStopRequests.add(job.id); control?.stop();
  return c.json({ status: 'stopping' });
});
app.post('/api/jobs/:id/stop-processing', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job || job.isLive) return c.json({ error: 'Video processing job not found.' }, 404);
  if (job.status === 'cancelled') return c.json({ status: 'cancelled' });
  if (job.status === 'cancelling') return c.json({ status: 'cancelling' });
  if (job.status !== 'transcribing') return c.json({ error: 'This video is not currently processing.' }, 409);
  transcriptionStopRequests.add(job.id);
  job.status = 'cancelling';
  await saveJob(job);
  transcriptionControls.get(job.id)?.stop();
  return c.json({ status: 'cancelling' });
});
app.get('/api/jobs/:id/progress', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found.' }, 404);
  const captureSeconds = job.isLive && job.status !== 'complete' && job.captureStartedAt ? Math.max(job.duration, (Date.now() - job.captureStartedAt) / 1000) : job.duration;
  let latestChunk: string | undefined;
  if (job.isLive) {
    try {
      const chunks = (await Array.fromAsync(new Bun.Glob('chunk-*.mp4').scan({ cwd: join(dataRoot, job.id) }))).sort();
      latestChunk = chunks.at(-1);
    } catch {}
  }
  return c.json({ id: job.id, status: job.status || 'complete', progress: job.progress ?? 100, processedSeconds: job.processedSeconds ?? job.duration, duration: job.duration, captureSeconds, candidates: job.candidates, transcriptAvailable: job.transcriptAvailable, whisperModel: job.whisperModel, whisperLanguage: job.whisperLanguage, whisperDevice: job.whisperDevice, detectedLanguage: job.detectedLanguage, transcriptionError: job.transcriptionError, wordCount: job.words.length, revision: job.revision || 0, isLive: job.isLive, latestChunk });
});
app.get('/api/jobs/:id/words', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found.' }, 404);
  const start = Number(c.req.query('start'));
  const end = Number(c.req.query('end'));
  let words = job.words || [];
  if (Number.isFinite(start) && Number.isFinite(end)) {
    words = words.filter(w => w.end >= start - 0.5 && w.start <= end + 0.5);
  }
  return c.json({ words, transcriptAvailable: job.transcriptAvailable });
});
app.get('/api/jobs/:id/layout-probe', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found.' }, 404);
  const start = Number(c.req.query('start')) || 0;
  const end = Number(c.req.query('end')) || (start + 15);
  const sourceOffset = Number(c.req.query('sourceOffsetSeconds')) || 0;
  const localStart = Math.max(0, start - sourceOffset);
  const localEnd = Math.max(localStart + 1, end - sourceOffset);
  const sourceFile = c.req.query('sourceFile');

  const dir = join(dataRoot, job.id);
  const files = await Array.fromAsync(new Bun.Glob('source.*').scan({ cwd: dir }));
  const sourceName = sourceFile && /^chunk-\d{5}\.mp4$/.test(sourceFile) ? sourceFile : files[0];
  if (!sourceName) return c.json({ hasCam: false, error: 'Source not found' });
  const sourcePath = join(dir, sourceName);

  const cacheKey = `${job.id}:${sourceName}`;
  if (layoutProbeCache.has(cacheKey)) {
    return c.json(layoutProbeCache.get(cacheKey)!);
  }
  if (job.layoutCrop?.hasCam && (!sourceFile || sourceFile === sourceName)) {
    layoutProbeCache.set(cacheKey, job.layoutCrop);
    return c.json(job.layoutCrop);
  }

  try {
    const python = resolve(root, '.venv/Scripts/python.exe');
    const model = join(root, 'assets/face_landmarker.task');
    const { stdout } = await run(python, ['scripts/facecam_stack.py', 'probe', sourcePath, String(localStart), String(localEnd), model], 15000);
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON output from probe: ' + stdout.slice(0, 200));
    const probe: LayoutCrop = JSON.parse(jsonMatch[0]);
    if (probe.hasCam) {
      layoutProbeCache.set(cacheKey, probe);
      job.layoutCrop = probe;
      await saveJob(job).catch(() => {});
    }
    return c.json(probe);
  } catch (e) {
    return c.json({ hasCam: false, error: e instanceof Error ? e.message : String(e) });
  }
});
app.get('/api/jobs/:id', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found.' }, 404);
  return c.json(job);
});
app.post('/api/jobs/:id/rank', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Process a video first.' }, 404);
  if (!process.env.OPENROUTER_API_KEY) return c.json({ error: 'Add OPENROUTER_API_KEY to .env to use AI ranking.' }, 400);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Clipmocha' }, body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite', temperature: 0.2, messages: [{ role: 'system', content: 'Rank candidate transcript moments for short-form clips. Prefer a compelling opening, coherent standalone context, emotion, surprise, humor, or useful insight. Do not claim virality. Return only JSON: {"order":[candidate ids],"notes":{"id":"short reason"}}.' }, { role: 'user', content: JSON.stringify(job.candidates.map(({id,start,end,text}) => ({id,start:Math.round(start),end:Math.round(end),text:text.slice(0,1400)}))) }] }) });
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const data = await response.json() as any; const raw = data.choices?.[0]?.message?.content || ''; const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const map = new Map(job.candidates.map(x => [x.id, x]));
    const ranked = (parsed.order as number[]).map(id => map.get(id)).filter(Boolean).map((x: any, i: number) => ({ ...x, score: Math.max(50, 99 - i * 4), reason: parsed.notes?.[x.id] || 'AI ranked this candidate highly' }));
    return c.json({ candidates: ranked });
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'AI ranking failed.' }, 502); }
});
app.post('/api/jobs/:id/export', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Process a video first.' }, 404);
  try {
    const body = await c.req.json() as { start: number; end: number; text: string; vertical: boolean; style?: CaptionStyle; layout?: 'auto' | 'blur'; sourceFile?: string; sourceOffsetSeconds?: number };
    const dir = join(dataRoot, job.id); const files = await Array.fromAsync(new Bun.Glob('source.*').scan({ cwd: dir }));
    const sourceName = body.sourceFile && /^chunk-\d{5}\.mp4$/.test(body.sourceFile) ? body.sourceFile : files[0];
    if (!sourceName) return c.json({ error: 'The source video for this clip is no longer available.' }, 404);
    const source = join(dir, sourceName); const sourceOffset = Number.isFinite(body.sourceOffsetSeconds) ? Math.max(0, body.sourceOffsetSeconds!) : 0;
    const sourceProbe = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',source]);
    const sourceDuration = Number(sourceProbe.stdout.trim());
    const localStart = Math.max(0, body.start - sourceOffset);
    if (!Number.isFinite(sourceDuration) || localStart >= sourceDuration) return c.json({ error: 'The selected clip start is outside its source segment.' }, 400);
    const localEnd = Math.min(sourceDuration, Math.max(localStart + 1, body.end - sourceOffset));
    const clipDuration = localEnd - localStart;
    const caption = body.text.replace(/\s+/g, ' ').trim().replace(/[{}]/g, '');
    const style: CaptionStyle = body.style && body.style in assStyles ? body.style : 'pop';
    const requestedLayout = body.vertical ? (body.layout || 'auto') : 'blur';
    const textHash = caption ? Math.abs(caption.split('').reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)).toString(36) : 'orig';
    const outputFilename = `clip-${Math.round(body.start)}-${Math.round(body.end)}-${style}-${requestedLayout}-${textHash}.mp4`;
    const output = join(dir, outputFilename);
    const clipMetadataPath = join(dir, `${outputFilename}.json`);
    const existing = Bun.file(output);
    if (await existing.exists() && existing.size > 1000) {
      await writeFile(clipMetadataPath, JSON.stringify({ caption }), 'utf8');
      return c.json({
        url: `/api/jobs/${job.id}/download/${encodeURIComponent(outputFilename)}`,
        streamUrl: `/api/jobs/${job.id}/stream?source=${encodeURIComponent(outputFilename)}`,
        filename: outputFilename,
        layout: requestedLayout === 'blur' ? 'blur' : 'stack',
        cached: true
      });
    }
    const ass = job.transcriptAvailable ? makeAss(job.words, body.start, body.end, style) : '';
    const captionPath = join(dir, ass ? 'captions.ass' : 'caption.txt');
    if (ass) await writeFile(captionPath, ass, 'utf8');
    else {
      const lines: string[] = []; let line = '';
      for (const word of caption.split(' ')) { if ((line + ' ' + word).trim().length > 28 && line) { lines.push(line); line = word; } else line = (line + ' ' + word).trim(); }
      if (line) lines.push(line);
      await writeFile(captionPath, lines.join('\n'), 'utf8');
    }
    const captionFile = `data/${job.id}/${ass ? 'captions.ass' : 'caption.txt'}`;
    let renderedLayout: 'blur' | 'stack' = 'blur';
    let layoutMessage: string | undefined;
    let videoInput = source;
    let ffmpegArgs: string[];
    if (body.vertical && requestedLayout !== 'blur') {
      const stacked = join(dir, `stacked-${Math.round(body.start)}-${Math.round(body.end)}.mp4`);
      try {
        await run('.venv/Scripts/python.exe', ['scripts/facecam_stack.py', source, String(localStart), String(localEnd), stacked, join(root, 'assets/face_landmarker.task')], 30 * 60 * 1000);
        videoInput = stacked;
        renderedLayout = 'stack';
      } catch (error) {
        layoutMessage = error instanceof Error
          ? error.message.split(/\r?\n/).filter(Boolean).at(-1)
          : 'No stable facecam was found.';
        console.warn(`Facecam stack unavailable; using blurred layout: ${layoutMessage}`);
        await unlink(stacked).catch(() => {});
      }
    }
    const graph = body.vertical
      ? `[0:v]split=2[bg][fg];[bg]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=8:2,eq=brightness=-0.25,scale=1080:1920:flags=fast_bilinear[bgblur];[fg]scale=1080:-2:force_original_aspect_ratio=decrease[fgfit];[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2[base]`
      : '[0:v]scale=1920:-2:force_original_aspect_ratio=decrease[base]';
    const fallbackCaption = caption ? `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':textfile='${captionFile}':fontcolor=white:fontsize=48:borderw=3:bordercolor=black:box=1:boxcolor=${style === 'neon' ? '0xC900FF@0.92' : style === 'clean' ? 'black@0.42' : '0xD9A500@0.94'}:boxborderw=14:x=(w-text_w)/2:y=h*0.72` : 'null';
    const overlay = ass ? `subtitles=filename='${captionFile}':fontsdir='assets/fonts'` : fallbackCaption;
    const filters = renderedLayout === 'stack'
      ? `[0:v]${overlay}[outv]`
      : `${graph};[base]${overlay}[outv]`;
    ffmpegArgs = renderedLayout === 'stack'
      ? ['-y','-threads','0','-i',videoInput,'-ss',String(localStart),'-i',source,'-t',String(clipDuration),'-filter_complex',filters,'-map','[outv]','-map','1:a:0?','-c:v','libx264','-preset','veryfast','-crf','22','-c:a','aac','-b:a','160k','-movflags','+faststart',output]
      : ['-y','-threads','0','-ss',String(localStart),'-i',source,'-t',String(clipDuration),'-filter_complex',filters,'-map','[outv]','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','160k','-movflags','+faststart',output];
    try { await run('ffmpeg', ffmpegArgs, 30 * 60 * 1000); }
    finally { if (renderedLayout === 'stack') await unlink(videoInput).catch(() => {}); }
    await writeFile(clipMetadataPath, JSON.stringify({ caption }), 'utf8');
    return c.json({
      url: `/api/jobs/${job.id}/download/${encodeURIComponent(outputFilename)}`,
      streamUrl: `/api/jobs/${job.id}/stream?source=${encodeURIComponent(outputFilename)}`,
      filename: outputFilename,
      layout: renderedLayout,
      layoutMessage
    });
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Export failed.' }, 500); }
});
app.get('/api/jobs/:id/download/:filename', async c => {
  const id = c.req.param('id'); const name = c.req.param('filename');
  if (!/^[\da-f-]{36}$/i.test(id) || !/^[\w.-]+\.mp4$/.test(name)) return c.text('Invalid filename', 400);
  try { const bytes = await readFile(join(dataRoot, id, name)); return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', 'Content-Disposition': `attachment; filename="${name}"` } }); } catch { return c.text('Clip not found.', 404); }
});
app.get('/api/jobs/:id/stream', async c => {
  const id = c.req.param('id');
  if (!/^[\da-f-]{36}$/i.test(id)) return c.text('Video not found.', 404);
  try {
    const dir = join(dataRoot, id); const requested = c.req.query('source');
    let name: string | undefined;
    if (requested && (/^source\.[\w.-]+$/.test(requested) || /^chunk-\d{5}\.mp4$/.test(requested) || /^clip-[\w.-]+\.mp4$/.test(requested))) name = requested;
    else if (requested) return c.text('Invalid source.', 400);
    if (!name) {
      const sources = await Array.fromAsync(new Bun.Glob('source.*').scan({ cwd: dir }));
      const chunks = (await Array.fromAsync(new Bun.Glob('chunk-*.mp4').scan({ cwd: dir }))).sort();
      name = sources[0] || chunks.at(-1);
    }
    if (!name) return c.text('Video segment is not ready yet.', 404);
    const path = join(dir,name); const file = Bun.file(path); if (!(await file.exists())) return c.text('Video segment not found.', 404); const size = file.size;
    const ext = extname(path).toLowerCase(); const type = ({ '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska' } as Record<string,string>)[ext] || 'application/octet-stream';
    const range = c.req.header('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range); if (!match) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
      const start = match[1] ? Number(match[1]) : Math.max(0,size-Number(match[2])); const end = match[2] && match[1] ? Math.min(size-1,Number(match[2])) : size-1;
      if (start >= size || end < start) return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
      return new Response(file.slice(start,end+1).stream(),{status:206,headers:{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':String(end-start+1),'Content-Range':`bytes ${start}-${end}/${size}`}});
    }
    return new Response(file.stream(),{headers:{'Content-Type':type,'Accept-Ranges':'bytes','Content-Length':String(size)}});
  } catch { return c.text('Video not found.', 404); }
});
app.use('/*', serveStatic({ root: './public' }));
const port = Number(process.env.PORT || 3000);
export default { port, maxRequestBodySize: 20 * 1024 * 1024 * 1024, fetch: app.fetch };
