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
const MOTION_COOLDOWN_MS: i64 = 12_000; // keep recording this long after the last above-threshold GOP (hysteresis)
const THUMB_DIR: &str = "/var/lib/mydoorcamera/thumbs";
const SECTION_DIR: &str = "/var/lib/mydoorcamera/sections";
const THUMB_SECTION_GAP_MS: i64 = 3_000; // no activity for this long ends a thumbnail section
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

// Thumbnail resolutions (px wide, 16:9) stored per activity section, plus "full" (the raw camera
// JPEG). The UI grid loads a small one so the activity view is near-instant.
const THUMB_SIZES: [(usize, usize); 4] = [(480, 270), (240, 135), (120, 68), (60, 34)];

// Box-downscale an NV12 frame to a small RGB image (also does YUV->RGB, BT.601). Reads luma over
// WIDTH x HEIGHT (ignoring the decoder's pad rows up to CAP_H).
fn nv12_to_rgb(nv12: &[u8], tw: usize, th: usize) -> Vec<u8> {
    let sw = WIDTH as usize; let sh = HEIGHT as usize;
    let uv_off = sw * CAP_H as usize;
    if nv12.len() < uv_off + uv_off / 2 { return Vec::new(); }
    let mut out = vec![0u8; tw * th * 3];
    for oy in 0..th {
        let y0 = oy * sh / th; let y1 = (((oy + 1) * sh / th).max(y0 + 1)).min(sh);
        for ox in 0..tw {
            let x0 = ox * sw / tw; let x1 = (((ox + 1) * sw / tw).max(x0 + 1)).min(sw);
            let (mut ys, mut us, mut vs, mut cy, mut cc) = (0u32, 0u32, 0u32, 0u32, 0u32);
            for yy in y0..y1 { for xx in x0..x1 {
                ys += nv12[yy * sw + xx] as u32; cy += 1;
                let ci = uv_off + (yy / 2) * sw + (xx / 2) * 2;
                us += nv12[ci] as u32; vs += nv12[ci + 1] as u32; cc += 1;
            } }
            let y = (ys / cy.max(1)) as f32;
            let u = (us / cc.max(1)) as f32 - 128.0;
            let v = (vs / cc.max(1)) as f32 - 128.0;
            let o = (oy * tw + ox) * 3;
            out[o] = (y + 1.402 * v).clamp(0.0, 255.0) as u8;
            out[o + 1] = (y - 0.344 * u - 0.714 * v).clamp(0.0, 255.0) as u8;
            out[o + 2] = (y + 1.772 * u).clamp(0.0, 255.0) as u8;
        }
    }
    out
}

// Box-downscale an RGB image (used to derive the smaller thumbnails from the 480px one — a pyramid).
fn downscale_rgb(src: &[u8], sw: usize, sh: usize, tw: usize, th: usize) -> Vec<u8> {
    let mut out = vec![0u8; tw * th * 3];
    for oy in 0..th {
        let y0 = oy * sh / th; let y1 = (((oy + 1) * sh / th).max(y0 + 1)).min(sh);
        for ox in 0..tw {
            let x0 = ox * sw / tw; let x1 = (((ox + 1) * sw / tw).max(x0 + 1)).min(sw);
            let (mut r, mut g, mut b, mut c) = (0u32, 0u32, 0u32, 0u32);
            for yy in y0..y1 { for xx in x0..x1 { let i = (yy * sw + xx) * 3; r += src[i] as u32; g += src[i + 1] as u32; b += src[i + 2] as u32; c += 1; } }
            let o = (oy * tw + ox) * 3; let c = c.max(1);
            out[o] = (r / c) as u8; out[o + 1] = (g / c) as u8; out[o + 2] = (b / c) as u8;
        }
    }
    out
}

fn encode_jpeg(rgb: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut buf = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut buf, 80);
    if enc.encode(rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb).is_err() { return Vec::new(); }
    buf
}

// Append one activity-section record: start/end wall ms, peak-frame time, and peak activity (u16,
// matching the thumbnail filename so the client can fetch the thumb by (t, a)). One JSON line per
// section under sections/YYYY/MM/DD.jsonl. This tiny list is ALL the activity UI loads — it never
// pulls the per-frame index to rebuild sections; that granular data is only for the trackbar.
fn write_section(start: i64, end: i64, peak_t: i64, peak_act: f32) {
    let dt = match Local.timestamp_millis_opt(start).single() { Some(d) => d, None => return };
    let dir = format!("{}/{:04}/{:02}", SECTION_DIR, dt.year(), dt.month());
    if std::fs::create_dir_all(&dir).is_err() { return; }
    let line = format!("{{\"s\":{},\"e\":{},\"t\":{},\"a\":{}}}\n", start, end, peak_t, act_to_u16(peak_act));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{}/{:02}.jsonl", dir, dt.day())) {
        use std::io::Write as _;
        let _ = f.write_all(line.as_bytes());
    }
}

// Write the section's peak frame at every resolution: `full` = the raw camera JPEG; 480/240/120/60
// = downscaled JPEGs (derived from the 480px RGB pyramid). Each under thumbs/<res>/YYYY/MM/DD/.
fn write_thumbnails(t: i64, act: f32, full_jpeg: &[u8], rgb480: &[u8]) {
    let dt = match Local.timestamp_millis_opt(t).single() { Some(d) => d, None => return };
    let day = format!("{:04}/{:02}/{:02}", dt.year(), dt.month(), dt.day());
    let name = format!("{}_{}.jpg", t, act_to_u16(act));
    let put = |res: &str, bytes: &[u8]| {
        if bytes.is_empty() { return; }
        let dir = format!("{}/{}/{}", THUMB_DIR, res, day);
        if std::fs::create_dir_all(&dir).is_ok() { let _ = std::fs::write(format!("{}/{}", dir, name), bytes); }
    };
    put("full", full_jpeg);
    if rgb480.len() == 480 * 270 * 3 {
        for &(w, h) in &THUMB_SIZES {
            let rgb = if w == 480 { rgb480.to_vec() } else { downscale_rgb(rgb480, 480, 270, w, h) };
            put(&w.to_string(), &encode_jpeg(&rgb, w, h));
        }
    }
}

static FRAMES: AtomicU64 = AtomicU64::new(0);
static DEC_SUM_US: AtomicU64 = AtomicU64::new(0);
static DEC_CNT: AtomicU64 = AtomicU64::new(0);
static ACT_SUM_US: AtomicU64 = AtomicU64::new(0);
static ACT_CNT: AtomicU64 = AtomicU64::new(0);
static ENC_SUM_MS: AtomicU64 = AtomicU64::new(0);
static ENC_CNT: AtomicU64 = AtomicU64::new(0);
static DROPS: AtomicU64 = AtomicU64::new(0);
static SEQGAPS: AtomicU64 = AtomicU64::new(0);  // camera-sequence gaps (frames the driver dropped before we got them)
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
    let mut last_active_t: Option<i64> = None; // wall ms of the last above-threshold GOP (motion cooldown)
    let mut last_hour_key: Option<i64> = None;
    let mut have_encoded = false;
    let mut raw_i: u64 = 0;
    let mut last_drop = Instant::now();
    let mut luma = [0u8; FRAME];
    let mut ts_anchor: Option<(i64, i64)> = None; // (wall_ms, camera_mono_ms) — accurate per-frame timing
    let mut prev_seq: i64 = -1;
    // Activity-thumbnail section: while a subject is present, keep the peak-activity frame's raw
    // camera JPEG (which we already have, pre-encode) in memory, replacing it whenever a
    // higher-activity frame arrives; when the section ends, write that JPEG straight to disk. No
    // re-decoding an encoded GOP, no re-encoding — the thumbnail IS the raw camera frame.
    let mut sec_active = false;
    let mut sec_peak_act = 0f32;
    let mut sec_peak_t = 0i64;
    let mut sec_start_t = 0i64; // wall ms of the section's first active frame
    let mut sec_peak_jpeg: Vec<u8> = Vec::new(); // raw camera JPEG of the peak frame ("full")
    let mut sec_peak_rgb: Vec<u8> = Vec::new();  // 480px RGB of the peak frame (for the small sizes)
    let mut sec_last_active = 0i64;

    loop {
        let (buf, meta) = stream.next()?;
        FRAMES.fetch_add(1, Ordering::Relaxed);
        // Frames the driver dropped before we read them show up as gaps in the camera sequence.
        let seq = meta.sequence as i64;
        if prev_seq >= 0 && seq > prev_seq + 1 { SEQGAPS.fetch_add((seq - prev_seq - 1) as u64, Ordering::Relaxed); }
        prev_seq = seq;
        raw_i += 1;
        let rung = RUNG.load(Ordering::Relaxed);
        let stride = rung_stride(rung);
        if raw_i % stride as u64 != 0 { continue; } // drop whole frames -> lower fps / longer GOP

        // Use the camera's hardware capture timestamp (monotonic), anchored once to wall-clock, so
        // every frame gets its TRUE capture time — not the bursty now_ms() at read time. Resync if
        // it drifts (NTP step) or fall back to now_ms() if the driver gives no timestamp.
        let mono = meta.timestamp.sec as i64 * 1000 + meta.timestamp.usec as i64 / 1000;
        let wall = now_ms();
        let t = if mono > 0 {
            let (aw, am) = *ts_anchor.get_or_insert((wall, mono));
            let est = aw + (mono - am);
            if (wall - est).abs() > 2000 { ts_anchor = Some((wall, mono)); wall } else { est }
        } else { wall };

        // The V4L2 buffer is allocated at the MJPG max (~4 MB); only `bytesused` bytes are the
        // actual JPEG. Copy just that — otherwise every frame (decode feed, thinner, thumbnails)
        // drags ~3.8 MB of trailing padding.
        let used = (meta.bytesused as usize).min(buf.len());
        let jpeg = buf[..used].to_vec();
        jpeg_fifo.push_back((jpeg, t));
        let jp_for_decode = jpeg_fifo.back().unwrap().0.clone();

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
            // Activity-thumbnail section tracking (in-pipeline, from the raw camera JPEG).
            if (act as f64) >= ACTIVITY_THRESHOLD {
                if !sec_active { sec_active = true; sec_peak_act = 0.0; sec_start_t = ct; }
                sec_last_active = ct;
                if act >= sec_peak_act && !jpeg_owned.is_empty() {
                    let rgb = nv12_to_rgb(&nv12, 480, 270);
                    if !rgb.is_empty() {
                        sec_peak_act = act; sec_peak_t = ct;
                        sec_peak_jpeg.clear(); sec_peak_jpeg.extend_from_slice(&jpeg_owned);
                        sec_peak_rgb = rgb;
                    }
                }
            } else if sec_active && ct - sec_last_active > THUMB_SECTION_GAP_MS {
                write_section(sec_start_t, sec_last_active, sec_peak_t, sec_peak_act);
                write_thumbnails(sec_peak_t, sec_peak_act, &sec_peak_jpeg, &sec_peak_rgb);
                sec_active = false; sec_peak_jpeg = Vec::new(); sec_peak_rgb = Vec::new();
            }
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
                    finalize_gop(&mut writer, &mut gop, &mut last_encoded_t, &mut last_active_t, &mut last_hour_key, &mut have_encoded);
                }
            }
        }

        if rung > 0 && last_drop.elapsed() >= Duration::from_secs(RECOVER_SECS) {
            RUNG.store(rung - 1, Ordering::Relaxed);
            last_drop = Instant::now();
        }
    }
}

fn finalize_gop(writer: &mut Writer, gop: &mut Vec<EncFrame>, last_encoded_t: &mut Option<f64>, last_active_t: &mut Option<i64>, last_hour_key: &mut Option<i64>, have_encoded: &mut bool) {
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
    // Motion hysteresis: a distant subject's activity hovers near the gate and briefly dips below
    // it mid-event; without a cooldown those GOPs become no-change and playback FREEZES on the
    // reference frame while the subject is still moving. So once we see real activity, keep
    // encoding for MOTION_COOLDOWN_MS after the last above-threshold GOP — a continuous event is
    // never broken into frozen gaps. Only real (raw) activity extends the window, so a truly
    // static scene still collapses to no-change once the cooldown elapses.
    let raw_active = (mx as f64) >= ACTIVITY_THRESHOLD;
    if raw_active { *last_active_t = Some(last_t); }
    let in_cooldown = last_active_t.map_or(false, |la| t >= la && t - la <= MOTION_COOLDOWN_MS);
    let active = raw_active || in_cooldown || !*have_encoded || new_file || encode_all();
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
        let seqgaps = SEQGAPS.swap(0, Ordering::Relaxed);
        let decode_ms = if dc > 0 { dsum as f64 / dc as f64 / 1000.0 } else { 0.0 };
        let activity_ms = if ac > 0 { asum as f64 / ac as f64 / 1000.0 } else { 0.0 };
        let encode_ms = if ec > 0 { esum as f64 / ec as f64 } else { 0.0 };

        let json = format!(
            "{{\"fps\":{:.1},\"cpuPct\":{},\"updatedMs\":{},\"jpegDecodeMs\":{:.2},\"activityMs\":{:.2},\"encodeMs\":{:.1},\"droppedFps\":{:.1},\"seqGaps\":{},\"rung\":{}}}",
            (fps * 10.0).round() / 10.0, cpu.round() as i64, now, decode_ms, activity_ms, encode_ms,
            (dropped_fps * 10.0).round() / 10.0, seqgaps, RUNG.load(Ordering::Relaxed)
        );
        let _ = std::fs::write(STATS_FILE, json);
    }
}
