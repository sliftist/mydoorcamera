// Self-contained activity-gated recorder (Rust). ONE V4L2 capture, per-frame activity, and a
// persistent hardware H.264 encoder that is fed ONLY the GOPs that contain activity — static GOPs
// are never encoded, just recorded as no-change index entries. This is the spec the JS/ffmpeg
// versions couldn't satisfy: gating the encode (not just the storage) while keeping up under
// motion. The heavy work (capture, JPEG decode for activity, feeding/parsing the encoder) is in
// native threads, so nothing blocks the capture loop.
//
// Pipeline:
//   capture thread  : V4L2 MJPEG -> per-frame activity (1/8 decode) -> 30-frame GOPs.
//                     active GOP  -> feed encoder + emit an Active job; static GOP -> Static job.
//   feeder  thread  : writes active-GOP JPEGs to the persistent ffmpeg encoder's stdin.
//   reader  thread  : parses the encoder's H.264 stdout into GOPs (one per active GOP, in order).
//   storage thread  : consumes jobs IN ORDER; Active -> wait for the matching encoded GOP + store;
//                     Static -> write a no-change record. Single writer keeps the index ordered.

mod activity;
mod storage;

use activity::{ActivityModel, FRAME, H as GH, W as GW};
use jpeg_decoder::PixelFormat;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use storage::Writer;

use v4l::buffer::Type;
use v4l::io::traits::CaptureStream;
use v4l::prelude::*;
use v4l::video::Capture;
use v4l::{Format, FourCC};

const VIDEO_DEVICE: &str = "/dev/video0";
const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const BITRATE: u32 = 5_000_000;
const GOP: usize = 30;
const DATA_DIR: &str = "/var/lib/mydoorcamera/video";
const STATS_FILE: &str = "/var/lib/mydoorcamera/encoder-stats.json";
const ACTIVITY_THRESHOLD: f64 = 0.0001; // GOP max activity below this -> no encode

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64 }
fn act_to_u16(a: f32) -> u16 { (a.max(0.0).min(1.0) * 65535.0).round() as u16 }

// --- shared stats counters ---
static FRAMES: AtomicU64 = AtomicU64::new(0);
static ACT_SUM_US: AtomicU64 = AtomicU64::new(0);
static ACT_CNT: AtomicU64 = AtomicU64::new(0);
static ENC_SUM_MS: AtomicU64 = AtomicU64::new(0);
static ENC_CNT: AtomicU64 = AtomicU64::new(0);
static ENC_PID: AtomicU32 = AtomicU32::new(0); // current encoder ffmpeg pid (0 when idle)

enum GopMsg {
    Active { t: i64, acts: Vec<u16>, jpegs: Vec<Vec<u8>> },
    Static { t: i64, acts: Vec<u16> },
}

// A per-burst persistent ffmpeg HW encoder. Spawned when activity starts, fed every active GOP
// (continuous input lets the HW encoder flush and keep up), and CLOSED when activity stops — the
// close drains the buffered tail. Static periods run no encoder, so they cost ~0 CPU.
struct Encoder {
    child: Child,
    stdin: std::process::ChildStdin,
    rx: mpsc::Receiver<(Vec<Vec<u8>>, usize)>,
}

impl Encoder {
    fn spawn() -> std::io::Result<Encoder> {
        let mut child = Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error",
                "-f", "mjpeg", "-i", "pipe:0",
                "-vf", "format=yuv420p",
                "-c:v", "h264_v4l2m2m", "-b:v", &BITRATE.to_string(), "-g", &GOP.to_string(),
                "-force_key_frames", &format!("expr:gte(n,n_forced*{})", GOP),
                "-flush_packets", "1", "-f", "h264", "pipe:1",
            ])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .spawn()?;
        ENC_PID.store(child.id(), Ordering::Relaxed);
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || reader_loop(stdout, tx));
        Ok(Encoder { child, stdin, rx })
    }
    fn feed(&mut self, jpegs: &[Vec<u8>]) {
        for j in jpegs { if self.stdin.write_all(j).is_err() { return; } }
        let _ = self.stdin.flush();
    }
    // GOPs the encoder has already emitted (non-blocking).
    fn drain_available(&self) -> Vec<(Vec<Vec<u8>>, usize)> { self.rx.try_iter().collect() }
    // Close stdin -> ffmpeg flushes its buffered frames and exits -> read the rest (blocking).
    fn close(self) -> Vec<(Vec<Vec<u8>>, usize)> {
        let Encoder { mut child, stdin, rx } = self;
        ENC_PID.store(0, Ordering::Relaxed);
        drop(stdin);
        let rest: Vec<_> = rx.iter().collect();
        let _ = child.wait();
        rest
    }
}

// Read the encoder's H.264 stdout, split into GOPs (one per active GOP, in order), send them out.
fn reader_loop(mut stdout: ChildStdout, tx: mpsc::Sender<(Vec<Vec<u8>>, usize)>) {
    let mut split = AnnexB::new();
    let mut sps: Option<Vec<u8>> = None;
    let mut pps: Option<Vec<u8>> = None;
    let mut cur: Option<Vec<Vec<u8>>> = None;
    let mut buf = [0u8; 65536];
    loop {
        let n = match stdout.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
        for nal in split.push(&buf[..n]) {
            match nal[0] & 0x1f {
                7 => sps = Some(nal),
                8 => pps = Some(nal),
                5 => { finalize_gop(&mut cur, &sps, &pps, &tx); cur = Some(vec![nal]); }
                1 => { if let Some(c) = cur.as_mut() { c.push(nal); } }
                _ => {}
            }
            if cur.as_ref().map_or(false, |c| c.len() >= GOP) { finalize_gop(&mut cur, &sps, &pps, &tx); }
        }
    }
    finalize_gop(&mut cur, &sps, &pps, &tx); // flush the final GOP on EOF
}

// MJPEG frame -> GW×GH grayscale for the activity detector (1/8-scale DCT decode, then box-down).
fn decode_gray(jpeg: &[u8]) -> Option<Vec<u8>> {
    let mut d = jpeg_decoder::Decoder::new(std::io::Cursor::new(jpeg));
    d.scale((WIDTH / 8) as u16, (HEIGHT / 8) as u16).ok()?;
    let px = d.decode().ok()?;
    let info = d.info()?;
    let (sw, sh) = (info.width as usize, info.height as usize);
    if sw == 0 || sh == 0 { return None; }
    let gsrc: Vec<u8> = match info.pixel_format {
        PixelFormat::L8 => px,
        PixelFormat::RGB24 => px.chunks_exact(3)
            .map(|c| ((c[0] as u32 * 77 + c[1] as u32 * 150 + c[2] as u32 * 29) >> 8) as u8).collect(),
        _ => return None,
    };
    if gsrc.len() < sw * sh { return None; }
    let mut out = vec![0u8; FRAME];
    for oy in 0..GH {
        let y0 = oy * sh / GH;
        let y1 = (((oy + 1) * sh / GH).max(y0 + 1)).min(sh);
        for ox in 0..GW {
            let x0 = ox * sw / GW;
            let x1 = (((ox + 1) * sw / GW).max(x0 + 1)).min(sw);
            let (mut sum, mut cnt) = (0u32, 0u32);
            for yy in y0..y1 { for xx in x0..x1 { sum += gsrc[yy * sw + xx] as u32; cnt += 1; } }
            out[oy * GW + ox] = if cnt > 0 { (sum / cnt) as u8 } else { 0 };
        }
    }
    Some(out)
}

// Streaming Annex-B splitter (mirror of src/annexb.ts): returns completed NAL payloads.
struct AnnexB { buf: Vec<u8> }
impl AnnexB {
    fn new() -> Self { AnnexB { buf: Vec::new() } }
    fn push(&mut self, chunk: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        let mut starts = Vec::new();
        let mut i = 0usize;
        while i + 2 < self.buf.len() {
            if self.buf[i] == 0 && self.buf[i + 1] == 0 && self.buf[i + 2] == 1 { starts.push(i); i += 3; }
            else { i += 1; }
        }
        if starts.len() < 2 { return out; }
        for s in 0..starts.len() - 1 {
            let ps = starts[s] + 3;
            let mut pe = starts[s + 1];
            while pe > ps && self.buf[pe - 1] == 0 { pe -= 1; }
            if pe > ps { out.push(self.buf[ps..pe].to_vec()); }
        }
        let keep = starts[starts.len() - 1];
        self.buf.drain(0..keep);
        out
    }
}

fn finalize_gop(cur: &mut Option<Vec<Vec<u8>>>, sps: &Option<Vec<u8>>, pps: &Option<Vec<u8>>, nal_tx: &mpsc::Sender<(Vec<Vec<u8>>, usize)>) {
    if let Some(slices) = cur.take() {
        let mut nals = Vec::with_capacity(slices.len() + 2);
        if let Some(s) = sps { nals.push(s.clone()); }
        if let Some(p) = pps { nals.push(p.clone()); }
        let fc = slices.len();
        nals.extend(slices);
        let _ = nal_tx.send((nals, fc));
    }
}

fn main() {
    println!("[recorder] starting activity-gated recorder {}x{} (Rust)", WIDTH, HEIGHT);
    let session = now_ms() as u64;

    let (gop_tx, gop_rx) = mpsc::channel::<GopMsg>();

    // manager: owns the per-burst encoder + the single writer (keeps the index time-ordered).
    std::thread::spawn(move || manager_loop(session, gop_rx));

    // stats
    std::thread::spawn(stats_loop);

    // capture (this thread)
    if let Err(e) = capture_loop(gop_tx) {
        eprintln!("[recorder] capture failed: {}", e);
        std::process::exit(1);
    }
}

fn manager_loop(session: u64, gop_rx: mpsc::Receiver<GopMsg>) {
    let mut writer = Writer::new(DATA_DIR, session);
    let mut last_encoded_t: Option<f64> = None;
    let mut enc: Option<Encoder> = None;
    let mut pending: VecDeque<(i64, Vec<u16>, Instant)> = VecDeque::new();

    let write_gops = |writer: &mut Writer, last: &mut Option<f64>, pending: &mut VecDeque<(i64, Vec<u16>, Instant)>, gops: Vec<(Vec<Vec<u8>>, usize)>| {
        for (nals, fc) in gops {
            if let Some((pt, pacts, created)) = pending.pop_front() {
                if let Err(e) = writer.write_gop(&nals, pt, fc, &pacts) { eprintln!("[recorder] write_gop: {}", e); }
                *last = Some(pt as f64);
                ENC_SUM_MS.fetch_add(created.elapsed().as_millis() as u64, Ordering::Relaxed);
                ENC_CNT.fetch_add(1, Ordering::Relaxed);
            }
        }
    };

    for msg in gop_rx {
        match msg {
            GopMsg::Active { t, acts, jpegs } => {
                if enc.is_none() {
                    match Encoder::spawn() { Ok(e) => enc = Some(e), Err(e) => { eprintln!("[recorder] encoder spawn: {}", e); continue; } }
                }
                let e = enc.as_mut().unwrap();
                e.feed(&jpegs);
                pending.push_back((t, acts, Instant::now()));
                let ready = e.drain_available();
                write_gops(&mut writer, &mut last_encoded_t, &mut pending, ready);
            }
            GopMsg::Static { t, acts } => {
                if let Some(e) = enc.take() {
                    let rest = e.close(); // flush the burst tail
                    write_gops(&mut writer, &mut last_encoded_t, &mut pending, rest);
                    pending.clear();
                }
                if let Some(rt) = last_encoded_t {
                    if let Err(e) = writer.write_no_change(t, rt, &acts) { eprintln!("[recorder] write_no_change: {}", e); }
                }
            }
        }
    }
}

fn capture_loop(gop_tx: mpsc::Sender<GopMsg>) -> std::io::Result<()> {
    let dev = Device::with_path(VIDEO_DEVICE)?;
    let mut fmt: Format = Capture::format(&dev)?;
    fmt.width = WIDTH;
    fmt.height = HEIGHT;
    fmt.fourcc = FourCC::new(b"MJPG");
    Capture::set_format(&dev, &fmt)?;
    let mut stream = MmapStream::with_buffers(&dev, Type::VideoCapture, 8)?;

    let mut model = ActivityModel::new();
    let mut gop_jpegs: Vec<Vec<u8>> = Vec::with_capacity(GOP);
    let mut gop_acts: Vec<u16> = Vec::with_capacity(GOP);
    let mut gop_t: i64 = 0;
    let mut have_encoded = false;
    let mut errs = 0u32;

    loop {
        let (buf, _meta) = match stream.next() {
            Ok(v) => { errs = 0; v }
            Err(e) => {
                // Transient camera/USB hiccup: back off and retry rather than exiting (a fast
                // restart loop re-opening a flaky UVC device is worse). Give up only if it persists.
                eprintln!("[recorder] capture next() error: {}", e);
                errs += 1;
                if errs > 150 { return Err(e); }
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        let t = now_ms();
        if gop_jpegs.is_empty() { gop_t = t; }
        let jpeg = buf.to_vec();

        let a0 = Instant::now();
        let act = decode_gray(&jpeg).map(|g| model.compute(&g)).unwrap_or(0.0);
        ACT_SUM_US.fetch_add(a0.elapsed().as_micros() as u64, Ordering::Relaxed);
        ACT_CNT.fetch_add(1, Ordering::Relaxed);
        FRAMES.fetch_add(1, Ordering::Relaxed);

        gop_jpegs.push(jpeg);
        gop_acts.push(act_to_u16(act));

        if gop_jpegs.len() >= GOP {
            let mx = gop_acts.iter().copied().max().unwrap_or(0);
            let active = (mx as f64 / 65535.0) >= ACTIVITY_THRESHOLD || !have_encoded;
            let acts = std::mem::take(&mut gop_acts);
            let jpegs = std::mem::take(&mut gop_jpegs);
            if active {
                have_encoded = true;
                let _ = gop_tx.send(GopMsg::Active { t: gop_t, acts, jpegs });
            } else {
                drop(jpegs);
                let _ = gop_tx.send(GopMsg::Static { t: gop_t, acts });
            }
        }
    }
}

// --- stats: fps (5s), combined recorder+ffmpeg CPU, activity ms, encode latency ms ---
fn proc_jiffies(pid: u32) -> u64 {
    let s = match std::fs::read_to_string(format!("/proc/{}/stat", pid)) { Ok(s) => s, Err(_) => return 0 };
    let after = &s[s.rfind(')').map(|i| i + 1).unwrap_or(0)..];
    let f: Vec<&str> = after.split_whitespace().collect();
    let u: u64 = f.get(11).and_then(|x| x.parse().ok()).unwrap_or(0);
    let st: u64 = f.get(12).and_then(|x| x.parse().ok()).unwrap_or(0);
    u + st
}
fn cpu_total_jiffies() -> u64 {
    let s = std::fs::read_to_string("/proc/stat").unwrap_or_default();
    let line = s.lines().next().unwrap_or("");
    line.split_whitespace().skip(1).filter_map(|x| x.parse::<u64>().ok()).sum()
}

fn stats_loop() {
    let self_pid = std::process::id();
    let enc_jiffies = || { let p = ENC_PID.load(Ordering::Relaxed); if p != 0 { proc_jiffies(p) } else { 0 } };
    let mut last_frames = 0u64;
    let mut last_proc = proc_jiffies(self_pid) + enc_jiffies();
    let mut last_total = cpu_total_jiffies();
    let mut last = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let now = now_ms();
        let frames = FRAMES.load(Ordering::Relaxed);
        let dt = last.elapsed().as_secs_f64().max(0.001);
        let fps = (frames - last_frames) as f64 / dt;
        last_frames = frames; last = Instant::now();

        let proc = proc_jiffies(self_pid) + enc_jiffies();
        let total = cpu_total_jiffies();
        let cpu = if total > last_total { proc.saturating_sub(last_proc) as f64 / (total - last_total) as f64 * 100.0 } else { 0.0 };
        last_proc = proc; last_total = total;

        let ac = ACT_CNT.swap(0, Ordering::Relaxed);
        let asum = ACT_SUM_US.swap(0, Ordering::Relaxed);
        let ec = ENC_CNT.swap(0, Ordering::Relaxed);
        let esum = ENC_SUM_MS.swap(0, Ordering::Relaxed);
        let activity_ms = if ac > 0 { asum as f64 / ac as f64 / 1000.0 } else { 0.0 };
        let encode_ms = if ec > 0 { esum as f64 / ec as f64 } else { 0.0 };

        let json = format!(
            "{{\"fps\":{:.1},\"cpuPct\":{},\"updatedMs\":{},\"jpegDecodeMs\":0,\"activityMs\":{:.2},\"encodeMs\":{:.1}}}",
            (fps * 10.0).round() / 10.0, cpu.round() as i64, now, activity_ms, encode_ms
        );
        let _ = std::fs::write(STATS_FILE, json);
    }
}
