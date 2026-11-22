import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawn } from 'node:child_process';

type Word = { start: number; end: number; text: string };
type Candidate = { id: number; start: number; end: number; text: string; score: number; reason: string };
type Job = { id: string; filename: string; words: Word[]; candidates: Candidate[]; duration: number; transcriptAvailable: boolean };
const app = new Hono();
const root = process.cwd();
const dataRoot = join(root, 'data');
await mkdir(dataRoot, { recursive: true });
const jobs = new Map<string, Job>();

function run(command: string, args: string[], timeout = 60 * 60 * 1000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, cwd: root });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => stdout += b.toString()); child.stderr.on('data', b => stderr += b.toString());
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${command} timed out`)); }, timeout);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Could not start ${command}. Check the setup instructions. ${e.message}`)); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr.slice(-2500) || `${command} exited ${code}`)); });
  });
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

app.get('/api/status', c => c.json({ aiEnabled: Boolean(process.env.OPENROUTER_API_KEY), model: process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite' }));
app.post('/api/process', async c => {
  try {
    const file = c.req.raw.body; const size = Number(c.req.header('content-length') || 0);
    if (!file) return c.json({ error: 'Choose a video file first.' }, 400);
    if (size > 20 * 1024 * 1024 * 1024) return c.json({ error: 'The file exceeds the 20 GB MVP limit.' }, 413);
    const id = randomUUID(); const dir = join(dataRoot, id); await mkdir(dir, { recursive: true });
    const filename = decodeURIComponent(c.req.query('filename') || 'source.mp4').split(/[\\/]/).at(-1)!;
    const suffix = extname(filename).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp4';
    const videoPath = join(dir, `source${suffix}`); await Bun.write(videoPath, new Response(file));
    const probe = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',videoPath]);
    const duration = Number(probe.stdout.trim()); if (!Number.isFinite(duration)) throw new Error('Could not read video duration.');
    let words: Word[] = []; let candidates: Candidate[]; let transcriptAvailable = true;
    try {
      const transcript = await run('.venv/Scripts/python.exe', ['scripts/transcribe.py', videoPath], 12 * 60 * 60 * 1000);
      words = JSON.parse(transcript.stdout) as Word[]; candidates = suggest(words);
    } catch {
      // Keep the no-AI workflow usable on machines where Whisper is not installed yet.
      transcriptAvailable = false;
      const audioPath = join(dir, 'analysis.wav');
      await run('ffmpeg', ['-y','-i',videoPath,'-vn','-ac','1','-ar','8000','-c:a','pcm_s16le',audioPath], 60 * 60 * 1000);
      const ranked = await run('.venv/Scripts/python.exe', ['scripts/rank_audio.py', audioPath]);
      candidates = JSON.parse(ranked.stdout) as Candidate[];
    }
    const job = { id, filename, words, candidates, duration, transcriptAvailable };
    jobs.set(id, job); await writeFile(join(dir, 'job.json'), JSON.stringify(job));
    return c.json(job);
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'Processing failed.' }, 500); }
});
app.get('/api/jobs/:id', async c => {
  const id = c.req.param('id'); let job = jobs.get(id);
  if (!job) try { job = JSON.parse(await readFile(join(dataRoot, id, 'job.json'), 'utf8')); jobs.set(id, job!); } catch { return c.json({ error: 'Job not found.' }, 404); }
  return c.json(job);
});
app.post('/api/jobs/:id/rank', async c => {
  const job = jobs.get(c.req.param('id'));
  if (!job) return c.json({ error: 'Process a video first.' }, 404);
  if (!process.env.OPENROUTER_API_KEY) return c.json({ error: 'Add OPENROUTER_API_KEY to .env to use AI ranking.' }, 400);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Clipdhoot' }, body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || 'google/gemini-3.1-flash-lite', temperature: 0.2, messages: [{ role: 'system', content: 'Rank candidate transcript moments for short-form clips. Prefer a compelling opening, coherent standalone context, emotion, surprise, humor, or useful insight. Do not claim virality. Return only JSON: {"order":[candidate ids],"notes":{"id":"short reason"}}.' }, { role: 'user', content: JSON.stringify(job.candidates.map(({id,start,end,text}) => ({id,start:Math.round(start),end:Math.round(end),text:text.slice(0,1400)}))) }] }) });
    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const data = await response.json() as any; const raw = data.choices?.[0]?.message?.content || ''; const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    const map = new Map(job.candidates.map(x => [x.id, x]));
    const ranked = (parsed.order as number[]).map(id => map.get(id)).filter(Boolean).map((x: any, i: number) => ({ ...x, score: Math.max(50, 99 - i * 4), reason: parsed.notes?.[x.id] || 'AI ranked this candidate highly' }));
    return c.json({ candidates: ranked });
  } catch (e) { return c.json({ error: e instanceof Error ? e.message : 'AI ranking failed.' }, 502); }
});
app.post('/api/jobs/:id/export', async c => {
  const job = jobs.get(c.req.param('id'));
  if (!job) return c.json({ error: 'Process a video first.' }, 404);
  try {
    const body = await c.req.json() as { start: number; end: number; text: string; vertical: boolean };
    const dir = join(dataRoot, job.id); const files = await Array.fromAsync(new Bun.Glob('source.*').scan({ cwd: dir }));
    const source = join(dir, files[0] || ''); const output = join(dir, `clip-${Math.round(body.start)}-${Math.round(body.end)}.mp4`);
    const caption = body.text.replace(/\s+/g, ' ').trim().replace(/[{}]/g, '');
    const lines: string[] = []; let line = '';
    for (const word of caption.split(' ')) { if ((line + ' ' + word).trim().length > 32 && line) { lines.push(line); line = word; } else line = (line + ' ' + word).trim(); }
    if (line) lines.push(line);
    const captionPath = join(dir, 'caption.txt'); await writeFile(captionPath, lines.join('\n'), 'utf8');
    const captionFile = `data/${job.id}/caption.txt`;
    const graph = body.vertical
      ? `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:12,eq=brightness=-0.25[bgblur];[fg]scale=1080:-2:force_original_aspect_ratio=decrease[fgfit];[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2[base]`
      : '[0:v]scale=1920:-2:force_original_aspect_ratio=decrease[base]';
    const filters = `${graph};[base]${caption ? `drawtext=textfile='${captionFile}':fontcolor=white:fontsize=42:borderw=3:bordercolor=black:box=1:boxcolor=black@0.48:boxborderw=12:x=(w-text_w)/2:y=h*0.76` : 'null'}[outv]`;
    await run('ffmpeg', ['-y','-ss',String(Math.max(0,body.start)),'-i',source,'-t',String(Math.max(1,body.end-body.start)),'-filter_complex',filters,'-map','[outv]','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','160k','-movflags','+faststart',output], 30 * 60 * 1000);
    return c.json({ url: `/api/jobs/${job.id}/download/${encodeURIComponent(output.split(/[\\/]/).at(-1)!)}` });
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
    const files = await Array.fromAsync(new Bun.Glob('source.*').scan({ cwd: join(dataRoot,id) }));
    const path = join(dataRoot,id,files[0]!); const file = Bun.file(path); const size = file.size;
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
