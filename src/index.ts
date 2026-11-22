import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, extname, resolve, isAbsolute } from 'node:path';

type Word = { start: number; end: number; text: string };
type Candidate = { id: number; start: number; end: number; text: string; score: number; reason: string; sourceFile?: string; sourceOffsetSeconds?: number };
type Job = { id: string; filename: string; words: Word[]; candidates: Candidate[]; duration: number; transcriptAvailable: boolean; whisperModel: string; whisperLanguage: string; whisperDevice?: string; detectedLanguage?: string; transcriptionError?: string; status?: 'live' | 'stopping' | 'transcribing' | 'complete' | 'failed' | 'interrupted'; progress?: number; processedSeconds?: number; revision?: number; isLive?: boolean; streamUrl?: string; captureStartedAt?: number };
type CaptionStyle = 'pop' | 'clean' | 'neon' | 'classic';
const app = new Hono();
const root = process.cwd();
const dataRoot = join(root, 'data');
await mkdir(dataRoot, { recursive: true });
const jobs = new Map<string, Job>();
let transcriptionBusy = false;
const liveControls = new Map<string, { stop: () => void }>();
const liveStopRequests = new Set<string>();

function run(command: string, args: string[], timeout = 60 * 60 * 1000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const executable = isAbsolute(command) ? command : command.includes('/') || command.includes('\\') ? resolve(root, command) : Bun.which(command) || command;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn([executable, ...args], { windowsHide: true, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    } catch (e) {
      reject(new Error(`Could not start ${command}. Check the setup instructions. ${e instanceof Error ? e.message : e}`));
      return;
    }
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
    if (['live', 'stopping', 'transcribing'].includes(job.status || '')) { job.status = 'interrupted'; job.transcriptionError = 'Server restarted while processing. Please start the live capture again.'; await writeFile(join(dataRoot, id, 'job.json'), JSON.stringify(job)); }
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
async function transcribeJob(job: Job, videoPath: string) {
  try {
    const executable = resolve(root, '.venv/Scripts/python.exe');
    const child = Bun.spawn([executable, 'scripts/transcribe.py', videoPath, job.whisperModel, job.whisperLanguage], { windowsHide: true, cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
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
    job.transcriptionError = error instanceof Error ? error.message.split('\n')[0] : 'Whisper transcription did not complete.';
    try {
      job.words = []; job.candidates = []; job.revision = (job.revision || 0) + 1; job.transcriptAvailable = false;
      const audioPath = join(dataRoot, job.id, 'analysis.wav');
      await run('ffmpeg', ['-y','-i',videoPath,'-vn','-ac','1','-ar','8000','-c:a','pcm_s16le',audioPath], 60 * 60 * 1000);
      const ranked = await run(resolve(root, '.venv/Scripts/python.exe'), ['scripts/rank_audio.py', audioPath]);
      job.candidates = JSON.parse(ranked.stdout) as Candidate[]; job.status = 'complete'; job.progress = 100; job.processedSeconds = job.duration;
    } catch (fallbackError) { job.status = 'failed'; job.transcriptionError += `; audio fallback failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`; }
    await saveJob(job);
  } finally { transcriptionBusy = false; }
}

const wait = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
function streamlinkHostAllowed(input: string) {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && (url.hostname === 'twitch.tv' || url.hostname.endsWith('.twitch.tv'))
      && !url.username && !url.password && (url.port === '' || url.port === '443')
      && /^\/(?:[\w-]+)\/?$/.test(url.pathname);
  } catch { return false; }
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
  if (!streamlinkHostAllowed(url)) return c.json({ error: 'For this MVP, enter a public Twitch channel URL such as https://www.twitch.tv/channelname.' }, 400);
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
    const channel = new URL(url).pathname.split('/').filter(Boolean)[0] || 'Twitch stream';
    const job: Job = { id, filename: `Live: ${channel}`, words: [], candidates: [], duration: 0, transcriptAvailable: true, whisperModel, whisperLanguage, status: 'live', progress: 0, processedSeconds: 0, revision: 0, isLive: true, streamUrl: url, captureStartedAt: Date.now() };
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
app.get('/api/jobs/:id/progress', async c => {
  const job = await loadJob(c.req.param('id'));
  if (!job) return c.json({ error: 'Job not found.' }, 404);
  const captureSeconds = job.isLive && job.status !== 'complete' && job.captureStartedAt ? Math.max(job.duration, (Date.now() - job.captureStartedAt) / 1000) : job.duration;
  return c.json({ id: job.id, status: job.status || 'complete', progress: job.progress ?? 100, processedSeconds: job.processedSeconds ?? job.duration, duration: job.duration, captureSeconds, candidates: job.candidates, transcriptAvailable: job.transcriptAvailable, whisperModel: job.whisperModel, whisperLanguage: job.whisperLanguage, whisperDevice: job.whisperDevice, detectedLanguage: job.detectedLanguage, transcriptionError: job.transcriptionError, wordCount: job.words.length, revision: job.revision || 0, isLive: job.isLive });
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
    const output = join(dir, `clip-${Math.round(body.start)}-${Math.round(body.end)}.mp4`);
    const caption = body.text.replace(/\s+/g, ' ').trim().replace(/[{}]/g, '');
    const style: CaptionStyle = body.style && body.style in assStyles ? body.style : 'pop';
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
    const requestedLayout = body.vertical ? (body.layout || 'auto') : 'blur';
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
      ? `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:12,eq=brightness=-0.25[bgblur];[fg]scale=1080:-2:force_original_aspect_ratio=decrease[fgfit];[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2[base]`
      : '[0:v]scale=1920:-2:force_original_aspect_ratio=decrease[base]';
    const fallbackCaption = caption ? `drawtext=fontfile='C\\:/Windows/Fonts/arialbd.ttf':textfile='${captionFile}':fontcolor=white:fontsize=48:borderw=3:bordercolor=black:box=1:boxcolor=${style === 'neon' ? '0xC900FF@0.92' : style === 'clean' ? 'black@0.42' : '0xD9A500@0.94'}:boxborderw=14:x=(w-text_w)/2:y=h*0.72` : 'null';
    const overlay = ass ? `subtitles=filename='${captionFile}':fontsdir='assets/fonts'` : fallbackCaption;
    const filters = renderedLayout === 'stack'
      ? `[0:v]${overlay}[outv]`
      : `${graph};[base]${overlay}[outv]`;
    ffmpegArgs = renderedLayout === 'stack'
      ? ['-y','-i',videoInput,'-ss',String(localStart),'-i',source,'-t',String(clipDuration),'-filter_complex',filters,'-map','[outv]','-map','1:a:0?','-c:v','libx264','-preset','veryfast','-crf','22','-c:a','aac','-b:a','160k','-movflags','+faststart',output]
      : ['-y','-ss',String(localStart),'-i',source,'-t',String(clipDuration),'-filter_complex',filters,'-map','[outv]','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','160k','-movflags','+faststart',output];
    try { await run('ffmpeg', ffmpegArgs, 30 * 60 * 1000); }
    finally { if (renderedLayout === 'stack') await unlink(videoInput).catch(() => {}); }
    return c.json({ url: `/api/jobs/${job.id}/download/${encodeURIComponent(output.split(/[\\/]/).at(-1)!)}`, layout: renderedLayout, layoutMessage });
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
    if (requested && (/^source\.[\w.-]+$/.test(requested) || /^chunk-\d{5}\.mp4$/.test(requested))) name = requested;
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
