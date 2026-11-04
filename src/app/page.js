'use client';

import React, { useState, useRef, useEffect } from 'react';

const WARP = 14;
const FRAMES = 4;
const FLASH_MS = 1500;
const CELL_W = 560, CELL_H = 420, PAD = 40, GAP = 24;

const MODES = [
  { shots: 1, title: 'Satu jepretan', desc: 'Satu foto untuk semua format: 1, 2, atau 3 susun' },
  { shots: 2, title: 'Dua jepretan', desc: 'Dua foto berbeda dalam format 2 susun' },
  { shots: 3, title: 'Tiga jepretan', desc: 'Tiga foto berbeda dalam format 3 susun' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeSeq = (len) => [
  ...Array.from({ length: len }, (_, i) => i),
  ...Array.from({ length: Math.max(0, len - 2) }, (_, i) => len - 2 - i),
];

function warpFrame(src, depth, w, h, t) {
  const out = new ImageData(w, h);
  const k = t * WARP;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = x;
      for (let n = 0; n < 3; n++) {
        const xi = Math.max(0, Math.min(w - 1, Math.round(sx)));
        sx = x + k * (depth[(y * w + xi) * 4] / 255 - 0.5);
      }
      const s = (y * w + Math.max(0, Math.min(w - 1, Math.round(sx)))) * 4;
      const i = (y * w + x) * 4;
      out.data[i] = src[s];
      out.data[i + 1] = src[s + 1];
      out.data[i + 2] = src[s + 2];
      out.data[i + 3] = 255;
    }
  }
  return out;
}

async function buildLayout(shots, n) {
  const W = CELL_W + PAD * 2;
  const H = n * CELL_H + (n - 1) * GAP + PAD * 2;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const imgs = await Promise.all(
    shots.map((fs) =>
      Promise.all(fs.map(async (src) => {
        const im = new Image();
        im.src = src;
        await im.decode();
        return im;
      }))
    )
  );
  const draw = (idx) => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < n; r++) {
      ctx.drawImage(imgs[r % imgs.length][idx], PAD, PAD + r * (CELL_H + GAP), CELL_W, CELL_H);
    }
  };
  return { canvas, ctx, draw, W, H };
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Slot({ frames, idx }) {
  const [p, setP] = useState({ from: idx, to: idx, n: 0 });
  useEffect(() => {
    setP((q) => ({ from: q.to, to: idx, n: q.n + 1 }));
  }, [idx]);
  const cls = 'absolute inset-0 h-full w-full object-cover';
  return (
    <div className="relative aspect-[4/3] w-full overflow-hidden bg-neutral-900">
      <img src={frames[p.from]} alt="" className={cls} />
      <img key={p.n} src={frames[p.to]} alt="" className={cls} style={{ animation: 'lensFade 60ms ease-out both' }} />
    </div>
  );
}

const chip = (on) =>
  `rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
    on ? 'bg-amber-400 text-neutral-900' : 'bg-white/10 text-white hover:bg-white/20'
  }`;

export default function Photobox() {
  const videoRef = useRef(null);
  const depthRef = useRef(null);
  const [isAiLoaded, setIsAiLoaded] = useState(false);
  const [device, setDevice] = useState('');
  const [portrait, setPortrait] = useState(false);

  const [phase, setPhase] = useState('menu'); // menu | shoot | result
  const [mode, setMode] = useState(1);
  const [shots, setShots] = useState([]);
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [facing, setFacing] = useState('user'); // user = depan, environment = belakang
  const [flash, setFlash] = useState(false);

  const [speed, setSpeed] = useState(100);
  const [activeIdx, setActiveIdx] = useState(0);
  const [layout, setLayout] = useState(1);
  const [format, setFormat] = useState('gif');
  const [duration, setDuration] = useState(15);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(orientation: portrait) and (pointer: coarse)');
    const on = () => setPortrait(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const load = (d) =>
        pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', {
          device: d,
          ...(d === 'wasm' && { dtype: 'q8' }),
        });
      let est, dev = isIOS ? 'wasm' : 'webgpu';
      try { est = await load(dev); } catch { dev = 'wasm'; est = await load('wasm'); }
      if (cancelled) return;
      depthRef.current = est;
      setDevice(dev);
      setIsAiLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (phase !== 'shoot') return;
    let stream, dead = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: 1280, height: 720 } })
      .then((s) => {
        if (dead) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (videoRef.current) videoRef.current.srcObject = s;
      })
      .catch((err) => console.error('Gagal akses kamera:', err));
    return () => { dead = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [phase, facing]);

  useEffect(() => {
    if (phase !== 'result') return;
    const seq = makeSeq(FRAMES);
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % seq.length;
      setActiveIdx(seq[i]);
    }, speed);
    return () => clearInterval(id);
  }, [phase, speed]);

  const lockLandscape = () => {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    Promise.resolve(document.documentElement.requestFullscreen?.())
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {});
  };

  const startMode = (m) => {
    lockLandscape();
    setMode(m);
    setShots([]);
    setLayout(m);
    setActiveIdx(0);
    setPhase('shoot');
  };

  const snap = async () => {
    if (busy || !depthRef.current) return;
    setBusy(true);
    for (let c = 3; c > 0; c--) { setCount(c); await sleep(1000); }
    setCount(null);
    setFlash(facing === 'user');

    const width = 640, height = 480;
    try {
      await sleep(facing === 'user' ? FLASH_MS : 300);
      const v = videoRef.current;
      const cw = (v.videoHeight * 4) / 3;
      const frozen = document.createElement('canvas');
      frozen.width = width; frozen.height = height;
      const fctx = frozen.getContext('2d', { willReadFrequently: true });
      if (facing === 'user') { fctx.translate(width, 0); fctx.scale(-1, 1); }
      fctx.drawImage(v, (v.videoWidth - cw) / 2, 0, cw, v.videoHeight, 0, 0, width, height);
      const src = fctx.getImageData(0, 0, width, height).data;

      setFlash(false);
      await sleep(50);

      const { depth } = await depthRef.current(frozen.toDataURL('image/jpeg', 0.9));
      const dCanvas = document.createElement('canvas');
      dCanvas.width = width; dCanvas.height = height;
      const dctx = dCanvas.getContext('2d', { willReadFrequently: true });
      dctx.filter = 'blur(1.5px)';
      dctx.drawImage(depth.toCanvas(), 0, 0, width, height);
      const dData = dctx.getImageData(0, 0, width, height).data;

      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      const generated = [];

      for (let i = 0; i < FRAMES; i++) {
        const t = ((i / (FRAMES - 1)) * 2 - 1) * 0.5;
        const img = warpFrame(src, dData, width, height, t);
        for (let k = 0; k < img.data.length; k += 4) {
          img.data[k] = Math.min(255, img.data[k] * 1.08 + 5);
          img.data[k + 2] = Math.max(0, img.data[k + 2] * 0.9 - 6);
        }
        ctx.putImageData(img, 0, 0);
        const g = ctx.createRadialGradient(width / 2, height / 2, width / 4, width / 2, height / 2, width / 1.05);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(30,10,5,0.45)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
        generated.push(canvas.toDataURL('image/jpeg', 0.92));
        await sleep(0);
      }

      const next = [...shots, generated];
      setShots(next);
      if (next.length >= mode) setPhase('result');
    } catch (error) {
      console.error('Gagal memproses foto:', error);
    } finally {
      setFlash(false);
      setBusy(false);
    }
  };

  const handleExport = async () => {
    if (isExporting || shots.length === 0) return;
    if (format === 'mp4' && !('VideoEncoder' in window)) {
      alert('Browser ini belum mendukung MP4. Pakai Chrome, Edge, atau Safari terbaru, atau pilih GIF.');
      return;
    }
    setIsExporting(true);
    try {
      const { canvas, ctx, draw, W, H } = await buildLayout(shots, layout);
      const seq = makeSeq(FRAMES);
      const name = `photobox-${layout}-susun.${format}`;

      if (format === 'gif') {
        const m = await import('gifenc');
        const { GIFEncoder, quantize, applyPalette } = { ...m, ...m.default };
        const gif = GIFEncoder();
        const cache = {};
        for (const idx of seq) {
          if (!cache[idx]) {
            draw(idx);
            const { data } = ctx.getImageData(0, 0, W, H);
            const palette = quantize(data, 256);
            cache[idx] = { palette, index: applyPalette(data, palette) };
          }
          gif.writeFrame(cache[idx].index, W, H, { palette: cache[idx].palette, delay: speed });
        }
        gif.finish();
        downloadBlob(new Blob([gif.bytes()], { type: 'image/gif' }), name);
      } else {
        const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
        const muxer = new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: 'avc', width: W, height: H },
          fastStart: 'in-memory',
        });
        const encoder = new VideoEncoder({
          output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
          error: (e) => console.error('Encoder error:', e),
        });
        encoder.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 6_000_000 });

        const FPS = 30;
        const hold = Math.max(1, Math.round((speed * FPS) / 1000));
        const LOOPS = Math.ceil((duration * FPS) / (seq.length * hold));
        const step = 1e6 / FPS;
        let n = 0;
        for (let l = 0; l < LOOPS; l++) {
          for (const idx of seq) {
            draw(idx);
            for (let h = 0; h < hold; h++) {
              const vf = new VideoFrame(canvas, { timestamp: Math.round(n * step), duration: Math.round(step) });
              encoder.encode(vf);
              vf.close();
              n++;
              if (encoder.encodeQueueSize > 30) await sleep(10);
            }
          }
        }
        await encoder.flush();
        muxer.finalize();
        downloadBlob(new Blob([muxer.target.buffer], { type: 'video/mp4' }), name);
      }
    } catch (error) {
      console.error('Gagal export:', error);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center bg-[#16213a] px-4 py-6 text-white">
      <style>{`
        @keyframes lensFade{from{opacity:0}to{opacity:1}}
        @keyframes tilt{0%,30%{transform:rotate(0)}70%,100%{transform:rotate(-90deg)}}
      `}</style>
      {flash && <div className="pointer-events-none fixed inset-0 z-50 bg-white" />}

      {portrait && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-[#16213a] p-8 text-center">
          <div className="h-20 w-12 rounded-xl border-4 border-white" style={{ animation: 'tilt 2.4s ease-in-out infinite' }} />
          <p className="text-xl font-bold">Putar perangkat ke mode horizontal</p>
          <p className="text-white/60">Photobox dirancang untuk layar landscape.</p>
        </div>
      )}

      <h1 className="text-3xl font-extrabold tracking-tight">Photobox</h1>

      {phase === 'menu' && (
        <section className="mt-6 flex w-full max-w-3xl flex-col items-center">
          <p className="mb-2 text-center text-white/70">
            {isAiLoaded ? 'Pilih berapa kali kamu mau menjepret.' : 'Menyiapkan model AI, tunggu sebentar...'}
          </p>
          <p className="mb-6 h-5 text-center text-sm text-white/40">
            {device === 'wasm' && 'Perangkat ini memproses foto lewat CPU, jadi tiap jepretan bisa butuh beberapa detik.'}
          </p>
          <div className="grid w-full gap-5 sm:grid-cols-3">
            {MODES.map((m) => (
              <button
                key={m.shots}
                disabled={!isAiLoaded}
                onClick={() => startMode(m.shots)}
                className="group flex flex-col items-center rounded-2xl bg-white/5 p-6 text-center ring-1 ring-white/15 transition hover:bg-white/10 hover:ring-amber-400 disabled:cursor-wait disabled:opacity-40"
              >
                <div className="mb-5 flex flex-col gap-1.5 rounded-sm bg-white p-1.5">
                  {Array.from({ length: m.shots }).map((_, i) => (
                    <div key={i} className="h-9 w-12 bg-neutral-300 group-hover:bg-amber-300" />
                  ))}
                </div>
                <span className="text-lg font-bold">{m.title}</span>
                <span className="mt-1 text-sm text-white/60">{m.desc}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {phase === 'shoot' && (
        <section className="mt-4 flex w-full max-w-5xl flex-col items-center gap-6 landscape:flex-row landscape:justify-center">
          <div className="relative aspect-[4/3] h-[min(62vh,480px)] shrink-0 overflow-hidden rounded-xl bg-black ring-4 ring-white">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className={`h-full w-full object-cover ${facing === 'user' ? 'scale-x-[-1]' : ''}`}
            />
            {count && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-9xl font-extrabold text-white">
                {count}
              </div>
            )}
            {busy && !count && (
              <div className="absolute inset-0 flex animate-pulse items-center justify-center bg-black/60 text-xl font-semibold">
                Memproses foto...
              </div>
            )}
          </div>

          <div className="flex flex-col items-center">
            <p className="mb-4 text-lg font-semibold">
              Foto {Math.min(shots.length + 1, mode)} dari {mode}
            </p>
            <button
              onClick={snap}
              disabled={busy}
              aria-label="Jepret"
              className="flex h-20 w-20 items-center justify-center rounded-full bg-white p-1.5 transition active:scale-95 disabled:opacity-50"
            >
              <span className="h-full w-full rounded-full bg-[#e5383b]" />
            </button>
            <p className="mt-3 h-5 text-sm text-white/60">
              {busy ? (count ? 'Bersiap...' : 'Mohon tunggu') : 'Tekan untuk mulai hitung mundur'}
            </p>

            {shots.length > 0 && (
              <div className="mt-4 flex gap-2">
                {shots.map((s, i) => (
                  <img key={i} src={s[1]} alt={`Foto ${i + 1}`} className="h-14 w-[75px] rounded object-cover ring-2 ring-white" />
                ))}
              </div>
            )}

            <button
              onClick={() => setFacing((f) => (f === 'user' ? 'environment' : 'user'))}
              disabled={busy}
              className="mt-4 rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold hover:bg-white/20 disabled:opacity-40 [@media(pointer:fine)]:hidden"
            >
              {facing === 'user' ? 'Pakai kamera belakang' : 'Pakai kamera depan'}
            </button>

            <button
              onClick={() => setPhase('menu')}
              disabled={busy}
              className="mt-6 text-sm text-white/60 underline-offset-4 hover:text-white hover:underline disabled:opacity-40"
            >
              Kembali ke menu
            </button>
          </div>
        </section>
      )}

      {phase === 'result' && (
        <section className="mt-6 flex w-full flex-col items-center gap-8 landscape:flex-row landscape:items-start landscape:justify-center md:flex-row md:items-start md:justify-center">
          <div className="flex w-[260px] flex-col gap-3 bg-white p-4 shadow-2xl">
            {Array.from({ length: layout }).map((_, r) => (
              <Slot key={r} frames={shots[r % shots.length]} idx={activeIdx} />
            ))}
          </div>

          <div className="flex w-full max-w-xs flex-col gap-6">
            {mode === 1 && (
              <div>
                <p className="mb-2 text-sm text-white/60">Susunan</p>
                <div className="flex gap-2">
                  {[1, 2, 3].map((n) => (
                    <button key={n} onClick={() => setLayout(n)} className={chip(layout === n)}>
                      {n === 1 ? '1 tengah' : `${n} susun`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm text-white/60">Format file</p>
              <div className="flex gap-2">
                {['gif', 'mp4'].map((f) => (
                  <button key={f} onClick={() => setFormat(f)} className={chip(format === f)}>
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            {format === 'mp4' && (
              <div>
                <p className="mb-2 text-sm text-white/60">Durasi video</p>
                <div className="flex gap-2">
                  {[15, 20].map((d) => (
                    <button key={d} onClick={() => setDuration(d)} className={chip(duration === d)}>
                      {d} detik
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm text-white/60">Kecepatan</p>
              <div className="flex gap-2">
                {[
                  { label: 'Cepat', s: 60 },
                  { label: 'Normal', s: 100 },
                  { label: 'Santai', s: 200 },
                ].map((o) => (
                  <button key={o.s} onClick={() => setSpeed(o.s)} className={chip(speed === o.s)}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={handleExport}
              disabled={isExporting}
              className="rounded-full bg-[#e5383b] px-6 py-3 text-lg font-bold transition hover:bg-[#f05154] disabled:opacity-50"
            >
              {isExporting ? 'Memproses...' : 'Unduh'}
            </button>
            <button
              onClick={() => setPhase('menu')}
              className="text-sm text-white/60 underline-offset-4 hover:text-white hover:underline"
            >
              Ulangi dari awal
            </button>
          </div>
        </section>
      )}
    </main>
  );
}