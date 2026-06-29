// Self-contained activity-gated recorder (Rust). V4L2 capture -> per-frame activity (1/8 decode)
// -> activity-gated hardware H.264 encode. Static GOPs are never encoded (no-change records);
// only GOPs with activity are encoded, by a per-burst persistent ffmpeg h264_v4l2m2m process.
//
// ADAPTIVE FRAME-DROPPING LADDER: under pressure (when the encoder can't keep up and GOPs would
// pile up) the recorder climbs a ladder that does LESS work, so it degrades gracefully instead of
// buffering to an out-of-memory hard-hang:
//   rung 0-2 : decode every frame (30fps), encode the N highest-activity frames per GOP (30->15).
//   rung 3-5 : decode fewer frames too (15->5 fps), encoding all decoded.
//   rung 6-7 : below 5fps — expand the GOP window (up to 5s) so each GOP still has >=5 frames.
// The ladder is driven by drops: if the bounded GOP channel is full (encoder behind) we drop the
// GOP AND climb a rung; after a calm period we descend. The bounded channel is the hard floor
// (memory can't run away), and a memory guard kills the encoder if RAM still gets critical.

mod activity;
mod storage;
mod thin;

use activity::{ActivityModel, FRAME, H as GH, W as GW};
use jpeg_decoder::PixelFormat;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use storage::Writer;

use chrono::{Datelike, Local, TimeZone, Timelike};
use v4l::buffer::Type;
use v4l::io::traits::CaptureStream;
use v4l::prelude::*;
use v4l::video::Capture;
use v4l::{Format, FourCC};

const VIDEO_DEVICE: &str = "/dev/video0";
const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const BITRATE: u32 = 5_000_000;
const STATS_FILE: &str = "/var/lib/mydoorcamera/encoder-stats.json";
const CONTROL_FILE: &str = "/var/lib/mydoorcamera/control.json";
const ACTIVITY_THRESHOLD: f64 = 0.0001; // GOP max activity below this -> no encode

const CHAN_CAP: usize = 3;              // bounded GOP channel: at most this many GOPs (~MBs) buffered
const MAX_RUNG: usize = 7;
const RECOVER_SECS: u64 = 8;           // descend a rung after this long with no drops
const MEM_CRIT_KB: u64 = 350_000;      // < this much MemAvailable -> kill the encoder, max degrade

// Ladder rung -> (decode_stride, decode_target, encode_budget).
//   decode_stride  : process activity on every Nth captured frame (others skipped).
//   decode_target  : finalize a GOP after this many DECODED frames (sets the GOP's wall span).
//   encode_budget  : how many of the decoded frames to actually encode (the highest-activity ones).
// encode_budget <= decode_target always, so each GOP feeds the encoder exactly encode_budget frames.
fn rung_params(r: usize) -> (usize, usize, usize) {
    match r {
        0 => (1, 30, 30),  // decode 30, encode 30   (~1s GOP)
        1 => (1, 30, 22),  // decode 30, encode 22
        2 => (1, 30, 15),  // decode 30, encode 15 (most active)
        3 => (2, 15, 15),  // decode 15, encode 15
        4 => (3, 10, 10),  // decode 10, encode 10
        5 => (6, 5, 5),    // decode 5,  encode 5    (~1s GOP)
        6 => (15, 5, 5),   // decode 2fps -> 5 frames over ~2.5s
        _ => (30, 5, 5),   // decode 1fps -> 5 frames over ~5s (floor)
    }
}

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64 }
// A key that changes whenever the storage hour-file rolls over (local Y/day-of-year/hour). The
// first GOP of each new file must be encoded so the file is self-contained (its no-change records
// reference a baseline within the same file, not one in a previous file the player won't load).
fn file_hour_key(ms: i64) -> i64 {
    let dt = Local.timestamp_millis_opt(ms).single().unwrap_or_else(|| Local.timestamp_opt(0, 0).unwrap());
    dt.year() as i64 * 1_000_000 + dt.ordinal() as i64 * 100 + dt.hour() as i64
}
fn act_to_u16(a: f32) -> u16 { (a.max(0.0).min(1.0) * 65535.0).round() as u16 }

static FRAMES: AtomicU64 = AtomicU64::new(0);   // raw frames received (capture rate)
static DEC_SUM_US: AtomicU64 = AtomicU64::new(0);
static DEC_CNT: AtomicU64 = AtomicU64::new(0);
static ACT_SUM_US: AtomicU64 = AtomicU64::new(0);
static ACT_CNT: AtomicU64 = AtomicU64::new(0);
static ENC_SUM_MS: AtomicU64 = AtomicU64::new(0);
static ENC_CNT: AtomicU64 = AtomicU64::new(0);
static ENC_PID: AtomicU32 = AtomicU32::new(0);  // current encoder ffmpeg pid (0 when idle)
static DROPS: AtomicU64 = AtomicU64::new(0);    // GOPs dropped because the encoder couldn't keep up
static RUNG: AtomicUsize = AtomicUsize::new(0); // current ladder rung

enum GopMsg {
    Active { t: i64, acts: Vec<u16>, jpegs: Vec<Vec<u8>> },
    Static { t: i64, acts: Vec<u16> },
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

fn finalize_gop(cur: &mut Option<Vec<Vec<u8>>>, sps: &Option<Vec<u8>>, pps: &Option<Vec<u8>>, tx: &mpsc::Sender<(Vec<Vec<u8>>, usize)>) {
    if let Some(slices) = cur.take() {
        let mut nals = Vec::with_capacity(slices.len() + 2);
        if let Some(s) = sps { nals.push(s.clone()); }
        if let Some(p) = pps { nals.push(p.clone()); }
        let fc = slices.len();
        nals.extend(slices);
        let _ = tx.send((nals, fc));
    }
}

// A per-burst persistent encoder. `period` = frames per GOP (forces an IDR every `period` frames),
// so the continuous H.264 stream splits into GOPs that map 1:1 to the GOPs we feed.
struct Encoder { child: Child, stdin: std::process::ChildStdin, rx: mpsc::Receiver<(Vec<Vec<u8>>, usize)> }

impl Encoder {
    fn spawn(period: usize) -> std::io::Result<Encoder> {
        let g = period.max(1).to_string();
        let mut child = Command::new("ffmpeg")
            .args([
                "-hide_banner", "-loglevel", "error",
                "-f", "mjpeg", "-i", "pipe:0",
                "-vf", "format=yuv420p",
                "-c:v", "h264_v4l2m2m", "-b:v", &BITRATE.to_string(), "-g", &g,
                "-force_key_frames", &format!("expr:gte(n,n_forced*{})", g),
                "-flush_packets", "1", "-f", "h264", "pipe:1",
            ])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .spawn()?;
        ENC_PID.store(child.id(), Ordering::Relaxed);
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let p = period.max(1);
        std::thread::spawn(move || reader_loop(stdout, tx, p));
        Ok(Encoder { child, stdin, rx })
    }
    fn feed(&mut self, jpegs: &[Vec<u8>]) -> std::io::Result<()> {
        for j in jpegs { self.stdin.write_all(j)?; }
        self.stdin.flush()
    }
    fn drain_available(&self) -> Vec<(Vec<Vec<u8>>, usize)> { self.rx.try_iter().collect() }
    fn close(self) -> Vec<(Vec<Vec<u8>>, usize)> {
        let Encoder { mut child, stdin, rx } = self;
        ENC_PID.store(0, Ordering::Relaxed);
        drop(stdin);
        let rest: Vec<_> = rx.iter().collect();
        let _ = child.wait();
        rest
    }
}

fn reader_loop(mut stdout: ChildStdout, tx: mpsc::Sender<(Vec<Vec<u8>>, usize)>, period: usize) {
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
            if cur.as_ref().map_or(false, |c| c.len() >= period) { finalize_gop(&mut cur, &sps, &pps, &tx); }
        }
    }
    finalize_gop(&mut cur, &sps, &pps, &tx);
}

// Client-settable: encode EVERY GOP (bypass activity-gating) — a stress test. Trivial parse.
fn always_encode() -> bool {
    std::fs::read_to_string(CONTROL_FILE).map(|s| s.contains("\"alwaysEncode\":true")).unwrap_or(false)
}

fn mem_available_kb() -> u64 {
    if let Ok(s) = std::fs::read_to_string("/proc/meminfo") {
        for line in s.lines() {
            if let Some(rest) = line.strip_prefix("MemAvailable:") {
                return rest.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(u64::MAX);
            }
        }
    }
    u64::MAX
}

fn main() {
    println!("[recorder] starting activity-gated recorder {}x{} (Rust, adaptive)", WIDTH, HEIGHT);
    let session = now_ms() as u64;

    let (gop_tx, gop_rx) = mpsc::sync_channel::<GopMsg>(CHAN_CAP);
    // Thinning runs off-thread on its own (best-effort) bounded channel — dropping thinning input
    // under load is fine (it only coarsens the overview), and it must never stall capture.
    let (thin_tx, thin_rx) = mpsc::sync_channel::<thin::Frame>(60);

    std::thread::spawn(move || manager_loop(session, gop_rx));
    std::thread::spawn(move || thin::run(session, thin_rx));
    std::thread::spawn(stats_loop);
    std::thread::spawn(mem_guard);

    if let Err(e) = capture_loop(gop_tx, thin_tx) {
        eprintln!("[recorder] capture failed: {}", e);
        std::process::exit(1);
    }
}

// If RAM gets critical, drop to the lowest-work rung and kill the encoder (frees its memory; the
// manager respawns it on the next active GOP). Belt-and-suspenders against an OOM hard-hang.
fn mem_guard() {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if mem_available_kb() < MEM_CRIT_KB {
            RUNG.store(MAX_RUNG, Ordering::Relaxed);
            let pid = ENC_PID.swap(0, Ordering::Relaxed);
            if pid != 0 {
                let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
                eprintln!("[recorder] MEM GUARD: low memory, killed encoder pid {}", pid);
            }
        }
    }
}

fn manager_loop(session: u64, gop_rx: mpsc::Receiver<GopMsg>) {
    let mut writer = Writer::new(0, session);
    let mut last_encoded_t: Option<f64> = None;
    let mut enc: Option<Encoder> = None;
    let mut cur_period: usize = 0;
    let mut pending: VecDeque<(i64, Vec<u16>, Instant)> = VecDeque::new();

    let write_gops = |writer: &mut Writer, last: &mut Option<f64>, pending: &mut VecDeque<(i64, Vec<u16>, Instant)>, gops: Vec<(Vec<Vec<u8>>, usize)>| {
        for (nals, fc) in gops {
            if let Some((pt, pacts, created)) = pending.pop_front() {
                let e = pt + ((fc as f64 / 30.0) * 1000.0).round() as i64;
                if let Err(err) = writer.write_gop(&nals, pt, e, fc, &pacts) { eprintln!("[recorder] write_gop: {}", err); }
                *last = Some(pt as f64);
                ENC_SUM_MS.fetch_add(created.elapsed().as_millis() as u64, Ordering::Relaxed);
                ENC_CNT.fetch_add(1, Ordering::Relaxed);
            }
        }
    };

    for msg in gop_rx {
        match msg {
            GopMsg::Active { t, acts, jpegs } => {
                let period = jpegs.len();
                if period == 0 { continue; }
                let need_respawn = match &enc { None => true, Some(_) => cur_period != period };
                if need_respawn {
                    if let Some(e) = enc.take() { let rest = e.close(); write_gops(&mut writer, &mut last_encoded_t, &mut pending, rest); pending.clear(); }
                    match Encoder::spawn(period) { Ok(e) => { enc = Some(e); cur_period = period; } Err(err) => { eprintln!("[recorder] encoder spawn: {}", err); continue; } }
                }
                let (fed_ok, ready) = {
                    let e = enc.as_mut().unwrap();
                    let ok = e.feed(&jpegs).is_ok();
                    (ok, if ok { e.drain_available() } else { Vec::new() })
                };
                if fed_ok {
                    pending.push_back((t, acts, Instant::now()));
                    write_gops(&mut writer, &mut last_encoded_t, &mut pending, ready);
                } else {
                    // encoder died (e.g. mem guard killed it) -> drain + respawn next time
                    if let Some(e) = enc.take() { let rest = e.close(); write_gops(&mut writer, &mut last_encoded_t, &mut pending, rest); }
                    pending.clear();
                }
            }
            GopMsg::Static { t, acts } => {
                if let Some(e) = enc.take() { let rest = e.close(); write_gops(&mut writer, &mut last_encoded_t, &mut pending, rest); pending.clear(); }
                if let Some(rt) = last_encoded_t {
                    let e = t + ((acts.len() as f64 / 30.0) * 1000.0).round() as i64;
                    if let Err(err) = writer.write_no_change(t, e, rt, &acts) { eprintln!("[recorder] write_no_change: {}", err); }
                }
            }
        }
    }
}

// Pick the `k` highest-activity frames from a temporally-ordered collection, returned in temporal
// order (jpegs + acts). If there are <= k, returns them all.
fn select_top(col: &[(Vec<u8>, f32, i64)], k: usize) -> (Vec<Vec<u8>>, Vec<u16>) {
    if col.len() <= k {
        return (col.iter().map(|c| c.0.clone()).collect(), col.iter().map(|c| act_to_u16(c.1)).collect());
    }
    let mut idx: Vec<usize> = (0..col.len()).collect();
    idx.sort_by(|&a, &b| col[b].1.partial_cmp(&col[a].1).unwrap_or(std::cmp::Ordering::Equal));
    idx.truncate(k);
    idx.sort_unstable();
    (idx.iter().map(|&i| col[i].0.clone()).collect(), idx.iter().map(|&i| act_to_u16(col[i].1)).collect())
}

fn capture_loop(gop_tx: mpsc::SyncSender<GopMsg>, thin_tx: mpsc::SyncSender<thin::Frame>) -> std::io::Result<()> {
    let dev = Device::with_path(VIDEO_DEVICE)?;
    let mut fmt: Format = Capture::format(&dev)?;
    fmt.width = WIDTH;
    fmt.height = HEIGHT;
    fmt.fourcc = FourCC::new(b"MJPG");
    Capture::set_format(&dev, &fmt)?;
    let mut stream = MmapStream::with_buffers(&dev, Type::VideoCapture, 8)?;

    let mut model = ActivityModel::new();
    let mut col: Vec<(Vec<u8>, f32, i64)> = Vec::new(); // decoded frames of the current GOP
    let mut have_encoded = false;
    let mut last_hour_key: Option<i64> = None;
    let mut raw_i: u64 = 0;
    let mut errs = 0u32;
    let mut last_drop = Instant::now();

    loop {
        let (buf, _meta) = match stream.next() {
            Ok(v) => { errs = 0; v }
            Err(e) => {
                eprintln!("[recorder] capture next() error: {}", e);
                errs += 1;
                if errs > 150 { return Err(e); }
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        FRAMES.fetch_add(1, Ordering::Relaxed);
        raw_i += 1;

        let rung = RUNG.load(Ordering::Relaxed);
        let (stride, decode_target, enc_budget) = rung_params(rung);

        // Skip decoding for non-stride frames (cheap path — just consume the camera frame).
        if stride > 1 && raw_i % stride as u64 != 0 { continue; }

        let t = now_ms();
        let jpeg = buf.to_vec();
        let d0 = Instant::now();
        let gray = decode_gray(&jpeg);
        DEC_SUM_US.fetch_add(d0.elapsed().as_micros() as u64, Ordering::Relaxed);
        DEC_CNT.fetch_add(1, Ordering::Relaxed);
        let act = match gray {
            Some(g) => {
                let a0 = Instant::now();
                let a = model.compute(&g);
                ACT_SUM_US.fetch_add(a0.elapsed().as_micros() as u64, Ordering::Relaxed);
                ACT_CNT.fetch_add(1, Ordering::Relaxed);
                a
            }
            None => 0.0,
        };
        // Feed the thinner (best-effort: drop if it's behind — never stall capture).
        let _ = thin_tx.try_send((jpeg.clone(), act, t));
        col.push((jpeg, act, t));

        if col.len() < decode_target { continue; }

        // ---- finalize this GOP ----
        let gop_t = col[0].2;
        let mut mx = 0f32;
        for c in &col { if c.1 > mx { mx = c.1; } }
        let hour_key = file_hour_key(gop_t);
        let new_file = last_hour_key != Some(hour_key); // first GOP of a new hour file -> must encode
        last_hour_key = Some(hour_key);
        let active = (mx as f64) >= ACTIVITY_THRESHOLD || !have_encoded || new_file || always_encode();
        let frames = std::mem::take(&mut col);

        if active {
            have_encoded = true;
            let (jpegs, acts) = select_top(&frames, enc_budget);
            match gop_tx.try_send(GopMsg::Active { t: gop_t, acts, jpegs }) {
                Ok(()) => {}
                Err(mpsc::TrySendError::Full(_)) => {
                    // Encoder is behind — drop this GOP and climb a rung (do less next time).
                    DROPS.fetch_add(1, Ordering::Relaxed);
                    last_drop = Instant::now();
                    if rung < MAX_RUNG { RUNG.store(rung + 1, Ordering::Relaxed); }
                }
                Err(mpsc::TrySendError::Disconnected(_)) => return Ok(()),
            }
        } else {
            let acts: Vec<u16> = frames.iter().map(|c| act_to_u16(c.1)).collect();
            let _ = gop_tx.try_send(GopMsg::Static { t: gop_t, acts });
        }

        // Descend a rung after a calm stretch with no drops.
        if rung > 0 && last_drop.elapsed() >= Duration::from_secs(RECOVER_SECS) {
            RUNG.store(rung - 1, Ordering::Relaxed);
            last_drop = Instant::now();
        }
    }
}

// --- stats: fps (capture), combined recorder+ffmpeg CPU, stage timings, drops, rung ---
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
    let mut last_drops = 0u64;
    let mut last_proc = proc_jiffies(self_pid) + enc_jiffies();
    let mut last_total = cpu_total_jiffies();
    let mut last = Instant::now();
    loop {
        std::thread::sleep(Duration::from_secs(5));
        let now = now_ms();
        let frames = FRAMES.load(Ordering::Relaxed);
        let drops = DROPS.load(Ordering::Relaxed);
        let dt = last.elapsed().as_secs_f64().max(0.001);
        let fps = (frames - last_frames) as f64 / dt;
        let dropped_fps = (drops - last_drops) as f64 / dt;
        last_frames = frames; last_drops = drops; last = Instant::now();

        let proc = proc_jiffies(self_pid) + enc_jiffies();
        let total = cpu_total_jiffies();
        let cpu = if total > last_total { proc.saturating_sub(last_proc) as f64 / (total - last_total) as f64 * 100.0 } else { 0.0 };
        last_proc = proc; last_total = total;

        let dc = DEC_CNT.swap(0, Ordering::Relaxed);
        let dsum = DEC_SUM_US.swap(0, Ordering::Relaxed);
        let ac = ACT_CNT.swap(0, Ordering::Relaxed);
        let asum = ACT_SUM_US.swap(0, Ordering::Relaxed);
        let ec = ENC_CNT.swap(0, Ordering::Relaxed);
        let esum = ENC_SUM_MS.swap(0, Ordering::Relaxed);
        let decode_ms = if dc > 0 { dsum as f64 / dc as f64 / 1000.0 } else { 0.0 };
        let activity_ms = if ac > 0 { asum as f64 / ac as f64 / 1000.0 } else { 0.0 };
        let encode_ms = if ec > 0 { esum as f64 / ec as f64 } else { 0.0 };

        let json = format!(
            "{{\"fps\":{:.1},\"cpuPct\":{},\"updatedMs\":{},\"jpegDecodeMs\":{:.2},\"activityMs\":{:.2},\"encodeMs\":{:.1},\"droppedFps\":{:.1},\"rung\":{}}}",
            (fps * 10.0).round() / 10.0, cpu.round() as i64, now, decode_ms, activity_ms, encode_ms,
            (dropped_fps * 10.0).round() / 10.0, RUNG.load(Ordering::Relaxed)
        );
        let _ = std::fs::write(STATS_FILE, json);
    }
}
