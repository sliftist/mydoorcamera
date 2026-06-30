// Self-contained activity-gated recorder (Rust), ALL HARDWARE — no ffmpeg, no software JPEG decode.
// Camera MJPEG (V4L2) -> HW JPEG decode (/dev/video10) -> NV12 -> {activity from luma; HW H.264
// encode (/dev/video11)} -> GOPs -> activity-gated storage. One pipeline thread; the HW codecs
// (hwcodec.rs) carry the heavy lifting. Reducing the frame rate = longer GOP period (drop whole
// camera frames before decode), keeping GOP_FRAMES frames with exact per-frame timing.

mod activity;
mod hwcodec;
mod storage;
mod thin;

use activity::{ActivityModel, FRAME, H as GH, W as GW};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
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
const CAP_H: u32 = 1088; // the HW JPEG decoder pads height to a 16-multiple; encode at that height
const BITRATE: i32 = 5_000_000;
const GOP_FRAMES: usize = 30;
const STATS_FILE: &str = "/var/lib/mydoorcamera/encoder-stats.json";
const CONTROL_FILE: &str = "/var/lib/mydoorcamera/control.json";
const ACTIVITY_THRESHOLD: f64 = 0.0001;
const MAX_RUNG: usize = 5;
const RECOVER_SECS: u64 = 8;
const MEM_CRIT_KB: u64 = 250_000;

// rung -> capture stride (drop whole camera frames before decode): fps = 30/stride.
fn rung_stride(r: usize) -> usize { match r { 0 => 1, 1 => 2, 2 => 3, 3 => 6, 4 => 15, _ => 30 } }

fn now_ms() -> i64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64 }
fn file_hour_key(ms: i64) -> i64 {
    let dt = Local.timestamp_millis_opt(ms).single().unwrap_or_else(|| Local.timestamp_opt(0, 0).unwrap());
    dt.year() as i64 * 1_000_000 + dt.ordinal() as i64 * 100 + dt.hour() as i64
}
fn act_to_u16(a: f32) -> u16 { (a.max(0.0).min(1.0) * 65535.0).round() as u16 }

static FRAMES: AtomicU64 = AtomicU64::new(0);
static DEC_SUM_US: AtomicU64 = AtomicU64::new(0);
static DEC_CNT: AtomicU64 = AtomicU64::new(0);
static ACT_SUM_US: AtomicU64 = AtomicU64::new(0);
static ACT_CNT: AtomicU64 = AtomicU64::new(0);
static ENC_SUM_MS: AtomicU64 = AtomicU64::new(0);
static ENC_CNT: AtomicU64 = AtomicU64::new(0);
static DROPS: AtomicU64 = AtomicU64::new(0);
static RUNG: AtomicUsize = AtomicUsize::new(0);

// Encode EVERY GOP regardless of activity when the manual toggle is on or someone is watching live.
fn encode_all() -> bool {
    std::fs::read_to_string(CONTROL_FILE)
        .map(|s| s.contains("\"alwaysEncode\":true") || s.contains("\"liveStreaming\":true"))
        .unwrap_or(false)
}

fn mem_available_kb() -> u64 {
    if let Ok(s) = std::fs::read_to_string("/proc/meminfo") {
        for line in s.lines() {
            if let Some(r) = line.strip_prefix("MemAvailable:") {
                return r.split_whitespace().next().and_then(|x| x.parse().ok()).unwrap_or(u64::MAX);
            }
        }
    }
    u64::MAX
}

// Split a complete Annex-B buffer into NAL payloads (start codes stripped).
fn split_nals(buf: &[u8]) -> Vec<Vec<u8>> {
    let mut starts = Vec::new();
    let mut i = 0usize;
    while i + 2 < buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 { starts.push(i); i += 3; } else { i += 1; }
    }
    let mut out = Vec::new();
    for s in 0..starts.len() {
        let ps = starts[s] + 3;
        let mut pe = if s + 1 < starts.len() { starts[s + 1] } else { buf.len() };
        while pe > ps && buf[pe - 1] == 0 { pe -= 1; }
        if pe > ps { out.push(buf[ps..pe].to_vec()); }
    }
    out
}

// Downsample the NV12 luma plane (sw x sh, stride sw) to the GWxGH activity frame.
fn downsample_luma(nv12: &[u8], sw: usize, sh: usize, out: &mut [u8; FRAME]) {
    for oy in 0..GH {
        let y0 = oy * sh / GH;
        let y1 = (((oy + 1) * sh / GH).max(y0 + 1)).min(sh);
        for ox in 0..GW {
            let x0 = ox * sw / GW;
            let x1 = (((ox + 1) * sw / GW).max(x0 + 1)).min(sw);
            let (mut sum, mut cnt) = (0u32, 0u32);
            for yy in y0..y1 { for xx in x0..x1 { sum += nv12[yy * sw + xx] as u32; cnt += 1; } }
            out[oy * GW + ox] = if cnt > 0 { (sum / cnt) as u8 } else { 0 };
        }
    }
}

fn main() {
    if std::env::var("MYDOORCAMERA_HWCHAIN").is_ok() { hwchain_selftest(); return; }
    println!("[recorder] starting ALL-HARDWARE recorder {}x{} (V4L2 HW decode + encode, no ffmpeg)", WIDTH, HEIGHT);
    let session = now_ms() as u64;

    let (thin_tx, thin_rx) = mpsc::sync_channel::<thin::Frame>(60);
    std::thread::spawn(move || thin::run(session, thin_rx));
    std::thread::spawn(stats_loop);
    std::thread::spawn(mem_guard);

    loop {
        if let Err(e) = capture_loop_hw(session, &thin_tx) {
            eprintln!("[recorder] pipeline error: {} — restarting in 2s", e);
            std::thread::sleep(Duration::from_secs(2));
        }
    }
}

fn mem_guard() {
    loop {
        std::thread::sleep(Duration::from_secs(1));
        if mem_available_kb() < MEM_CRIT_KB { RUNG.store(MAX_RUNG, Ordering::Relaxed); }
    }
}

fn hwchain_selftest() {
    use std::io::Write;
    let inp = std::env::var("HWCHAIN_IN").unwrap_or_else(|_| "/tmp/real.mjpg".into());
    let outp = std::env::var("HWCHAIN_OUT").unwrap_or_else(|_| "/tmp/chain.h264".into());
    let jpeg = std::fs::read(&inp).expect("read jpeg");
    println!("[hwchain] in={} ({} bytes) out={}", inp, jpeg.len(), outp);
    let mut dec = hwcodec::Codec::decoder(WIDTH, HEIGHT).expect("decoder");
    let mut enc = hwcodec::Codec::encoder(WIDTH, CAP_H, BITRATE, GOP_FRAMES as i32).expect("encoder");
    let mut f = std::fs::File::create(&outp).unwrap();
    let (mut nf, mut np) = (0u32, 0u32);
    for _ in 0..120 {
        for nv12 in dec.process(&jpeg) {
            nf += 1;
            for h in enc.process(&nv12) { f.write_all(&h).unwrap(); np += 1; }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    println!("[hwchain] decoded {} NV12, encoded {} H264 -> {}", nf, np, outp);
}

// One encoded frame waiting to be grouped into a GOP.
struct EncFrame { nals: Vec<Vec<u8>>, t: i64, act: f32 }

fn capture_loop_hw(session: u64, thin_tx: &mpsc::SyncSender<thin::Frame>) -> std::io::Result<()> {
    // Camera (MJPEG).
    let dev = Device::with_path(VIDEO_DEVICE)?;
    let mut fmt: Format = Capture::format(&dev)?;
    fmt.width = WIDTH; fmt.height = HEIGHT; fmt.fourcc = FourCC::new(b"MJPG");
    Capture::set_format(&dev, &fmt)?;
    let mut stream = MmapStream::with_buffers(&dev, Type::VideoCapture, 8)?;

    let mut dec = hwcodec::Codec::decoder(WIDTH, HEIGHT)?;
    let mut enc = hwcodec::Codec::encoder(WIDTH, CAP_H, BITRATE, GOP_FRAMES as i32)?;
    let mut model = ActivityModel::new();
    let mut writer = Writer::new(0, session);

    let mut jpeg_fifo: VecDeque<(Vec<u8>, i64)> = VecDeque::new(); // fed to decoder, awaiting NV12 (FIFO)
    let mut enc_fifo: VecDeque<(i64, f32, Instant)> = VecDeque::new(); // fed to encoder, awaiting H264 (FIFO)
    let mut gop: Vec<EncFrame> = Vec::new();
    let mut last_encoded_t: Option<f64> = None;
    let mut last_hour_key: Option<i64> = None;
    let mut have_encoded = false;
    let mut raw_i: u64 = 0;
    let mut last_drop = Instant::now();
    let mut luma = [0u8; FRAME];

    loop {
        let (buf, _meta) = stream.next()?;
        FRAMES.fetch_add(1, Ordering::Relaxed);
        raw_i += 1;
        let rung = RUNG.load(Ordering::Relaxed);
        let stride = rung_stride(rung);
        if raw_i % stride as u64 != 0 { continue; } // drop whole frames -> lower fps / longer GOP

        let t = now_ms();
        let jpeg = buf.to_vec();
        jpeg_fifo.push_back((jpeg, t));
        let (jp_ref, _) = jpeg_fifo.back().unwrap();
        let jp_for_decode = jp_ref.clone();

        // HW JPEG decode (drains any ready NV12 frames — pipeline depth ~2-3).
        let d0 = Instant::now();
        let nv12s = dec.process(&jp_for_decode);
        DEC_SUM_US.fetch_add(d0.elapsed().as_micros() as u64, Ordering::Relaxed);
        DEC_CNT.fetch_add(1, Ordering::Relaxed);

        for nv12 in nv12s {
            let (jpeg_owned, ct) = jpeg_fifo.pop_front().unwrap_or((Vec::new(), t));
            // activity from the decoded luma (no software JPEG decode).
            let a0 = Instant::now();
            downsample_luma(&nv12, WIDTH as usize, CAP_H as usize, &mut luma);
            let act = model.compute(&luma);
            ACT_SUM_US.fetch_add(a0.elapsed().as_micros() as u64, Ordering::Relaxed);
            ACT_CNT.fetch_add(1, Ordering::Relaxed);
            // feed the thinner (best-effort).
            let _ = thin_tx.try_send((jpeg_owned, act, ct));
            // HW H.264 encode.
            enc_fifo.push_back((ct, act, Instant::now()));
            for h264 in enc.process(&nv12) {
                let (ft, fa, created) = enc_fifo.pop_front().unwrap_or((ct, act, Instant::now()));
                ENC_SUM_MS.fetch_add(created.elapsed().as_millis() as u64, Ordering::Relaxed);
                ENC_CNT.fetch_add(1, Ordering::Relaxed);
                gop.push(EncFrame { nals: split_nals(&h264), t: ft, act: fa });
                if gop.len() >= GOP_FRAMES {
                    finalize_gop(&mut writer, &mut gop, &mut last_encoded_t, &mut last_hour_key, &mut have_encoded);
                }
            }
        }

        if rung > 0 && last_drop.elapsed() >= Duration::from_secs(RECOVER_SECS) {
            RUNG.store(rung - 1, Ordering::Relaxed);
            last_drop = Instant::now();
        }
    }
}

fn finalize_gop(writer: &mut Writer, gop: &mut Vec<EncFrame>, last_encoded_t: &mut Option<f64>, last_hour_key: &mut Option<i64>, have_encoded: &mut bool) {
    if gop.is_empty() { return; }
    let frames = std::mem::take(gop);
    let n = frames.len();
    let t = frames[0].t;
    let last_t = frames[n - 1].t;
    let interval = if n > 1 { (last_t - t) / (n as i64 - 1) } else { 1000 / 30 };
    let e = last_t + interval;
    let mut mx = 0f32;
    for f in &frames { if f.act > mx { mx = f.act; } }
    let hour_key = file_hour_key(t);
    let new_file = *last_hour_key != Some(hour_key);
    *last_hour_key = Some(hour_key);
    let active = (mx as f64) >= ACTIVITY_THRESHOLD || !*have_encoded || new_file || encode_all();
    let acts: Vec<u16> = frames.iter().map(|f| act_to_u16(f.act)).collect();
    let dts: Vec<u16> = frames.iter().map(|f| (f.t - t).clamp(0, 65535) as u16).collect();

    if active {
        *have_encoded = true;
        let mut nals: Vec<Vec<u8>> = Vec::new();
        for f in &frames { for nl in &f.nals { nals.push(nl.clone()); } }
        if let Err(err) = writer.write_gop(&nals, t, e, n, &acts, &dts) { eprintln!("[recorder] write_gop: {}", err); }
        *last_encoded_t = Some(t as f64);
    } else if let Some(rt) = *last_encoded_t {
        if let Err(err) = writer.write_no_change(t, e, rt, &acts, &dts) { eprintln!("[recorder] write_no_change: {}", err); }
    }
}

// --- stats ---
fn proc_jiffies(pid: u32) -> u64 {
    let s = match std::fs::read_to_string(format!("/proc/{}/stat", pid)) { Ok(s) => s, Err(_) => return 0 };
    let after = &s[s.rfind(')').map(|i| i + 1).unwrap_or(0)..];
    let f: Vec<&str> = after.split_whitespace().collect();
    f.get(11).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0) + f.get(12).and_then(|x| x.parse::<u64>().ok()).unwrap_or(0)
}
fn cpu_total_jiffies() -> u64 {
    let s = std::fs::read_to_string("/proc/stat").unwrap_or_default();
    s.lines().next().unwrap_or("").split_whitespace().skip(1).filter_map(|x| x.parse::<u64>().ok()).sum()
}

fn stats_loop() {
    let self_pid = std::process::id();
    let mut last_frames = 0u64;
    let mut last_drops = 0u64;
    let mut last_proc = proc_jiffies(self_pid);
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

        let proc = proc_jiffies(self_pid);
        let total = cpu_total_jiffies();
        let cpu = if total > last_total { proc.saturating_sub(last_proc) as f64 / (total - last_total) as f64 * 100.0 } else { 0.0 };
        last_proc = proc; last_total = total;

        let dc = DEC_CNT.swap(0, Ordering::Relaxed); let dsum = DEC_SUM_US.swap(0, Ordering::Relaxed);
        let ac = ACT_CNT.swap(0, Ordering::Relaxed); let asum = ACT_SUM_US.swap(0, Ordering::Relaxed);
        let ec = ENC_CNT.swap(0, Ordering::Relaxed); let esum = ENC_SUM_MS.swap(0, Ordering::Relaxed);
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
