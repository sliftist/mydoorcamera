// Direct thinning, folded into capture. The recorder already has every original full-quality JPEG
// and its per-frame activity, so it builds the thinned levels itself — no re-decode, and it can pick
// ANY frame (not just keyframes), so a thinned frame is the single highest-activity original frame
// in its window. A cascade does this with O(1) memory per level:
//   L1: the best frame of each 1s window  -> 30 of them = one L1 GOP (covers 30s)
//   L2: the best of each L1 frame over 30s -> one L2 GOP (covers 900s)   ... up to L4.
// The best-of-best-of-... is the global best original frame for the window. Thinned GOPs are encoded
// on the HARDWARE codec (h264_v4l2m2m) — software is far too slow on this Pi. Thinned encodes are
// infrequent (an L1 GOP every 30s, L2 every 15min, ...), and the bcm2835 codec handles concurrent
// encode contexts, so this coexists with the L0 recorder's encoder.

use crate::storage::Writer;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::Receiver;

const SLOTS: usize = 30;            // frames per thinned GOP
const THIN_BITRATE: u32 = 12_000_000;
const THRESH: f64 = 0.0001;        // GOP max activity below this -> no-change (don't encode)
const LEVELS: usize = 4;           // L1..L4

pub type Frame = (Vec<u8>, f32, i64); // jpeg, activity, wall_ms

struct Level {
    sub_span_ms: i64,   // wall span each frame represents (1000 * 30^(level-1))
    gop_span_ms: i64,   // sub_span_ms * SLOTS (= 1000 * 30^level)
    writer: Writer,
    cur_sub_idx: Option<i64>,
    cur_best: Option<Frame>,
    cur_gop_idx: Option<i64>,
    gop: Vec<Frame>,
    last_t: Option<f64>,
}

pub fn run(session: u64, rx: Receiver<Frame>) {
    let mut levels: Vec<Level> = (1..=LEVELS).map(|l| {
        let sub = 1000i64 * 30i64.pow((l - 1) as u32);
        Level {
            sub_span_ms: sub, gop_span_ms: sub * SLOTS as i64, writer: Writer::new(l, session),
            cur_sub_idx: None, cur_best: None, cur_gop_idx: None, gop: Vec::new(), last_t: None,
        }
    }).collect();
    for frame in rx { ingest(&mut levels, 0, frame); }
}

// Feed `frame` into level index `li` (0=L1 .. 3=L4); cascade the finalized best upward.
fn ingest(levels: &mut [Level], mut li: usize, mut frame: Frame) {
    loop {
        if li >= levels.len() { break; }
        match feed_one(&mut levels[li], frame) {
            Some(best) if li + 1 < levels.len() => { li += 1; frame = best; }
            _ => break,
        }
    }
}

fn feed_one(lv: &mut Level, frame: Frame) -> Option<Frame> {
    let sub_idx = frame.2 / lv.sub_span_ms;
    let mut produced = None;
    if lv.cur_sub_idx != Some(sub_idx) {
        if let Some(best) = lv.cur_best.take() {
            let gop_idx = best.2 / lv.gop_span_ms;
            if lv.cur_gop_idx.map_or(false, |g| g != gop_idx) { flush_gop(lv); }
            lv.cur_gop_idx = Some(gop_idx);
            lv.gop.push(best.clone());
            if lv.gop.len() >= SLOTS { flush_gop(lv); }
            produced = Some(best);
        }
        lv.cur_sub_idx = Some(sub_idx);
    }
    if lv.cur_best.as_ref().map_or(true, |b| frame.1 > b.1) { lv.cur_best = Some(frame); }
    produced
}

fn flush_gop(lv: &mut Level) {
    if lv.gop.is_empty() { return; }
    let gop = std::mem::take(&mut lv.gop);
    let t = gop[0].2;
    let e = t + lv.gop_span_ms;
    let mut mx = 0f32;
    for f in &gop { if f.1 > mx { mx = f.1; } }
    let acts: Vec<u16> = gop.iter().map(|f| crate::act_to_u16(f.1)).collect();
    if (mx as f64) < THRESH {
        if let Some(rt) = lv.last_t {
            let _ = lv.writer.write_no_change(t, e, rt, &acts);
        }
        return;
    }
    let jpegs: Vec<Vec<u8>> = gop.into_iter().map(|f| f.0).collect();
    if let Some((nals, fc)) = encode(jpegs) {
        if fc > 0 {
            if let Err(err) = lv.writer.write_gop(&nals, t, e, fc, &acts) { eprintln!("[thin] write_gop: {}", err); }
            lv.last_t = Some(t as f64);
        }
    }
}

// Encode the picked JPEGs into one H.264 GOP on the hardware codec (h264_v4l2m2m).
fn encode(jpegs: Vec<Vec<u8>>) -> Option<(Vec<Vec<u8>>, usize)> {
    let mut child = Command::new("ffmpeg").args([
        "-hide_banner", "-loglevel", "error", "-f", "mjpeg", "-i", "pipe:0",
        "-vf", "format=yuv420p", "-c:v", "h264_v4l2m2m",
        "-b:v", &THIN_BITRATE.to_string(), "-g", &SLOTS.to_string(), "-f", "h264", "pipe:1",
    ]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let mut stdout = child.stdout.take()?;
    // Feed on a thread so a full stdout pipe can't deadlock the writer.
    let feeder = std::thread::spawn(move || { for j in jpegs { if stdin.write_all(&j).is_err() { break; } } let _ = stdin.flush(); });
    let mut out = Vec::new();
    let _ = stdout.read_to_end(&mut out);
    let _ = feeder.join();
    let _ = child.wait();

    let mut sps: Option<Vec<u8>> = None;
    let mut pps: Option<Vec<u8>> = None;
    let mut slices: Vec<Vec<u8>> = Vec::new();
    for nal in split_annexb(&out) {
        match nal[0] & 0x1f { 7 => sps = Some(nal), 8 => pps = Some(nal), 5 | 1 => slices.push(nal), _ => {} }
    }
    let mut nals = Vec::with_capacity(slices.len() + 2);
    if let Some(s) = sps { nals.push(s); }
    if let Some(p) = pps { nals.push(p); }
    let fc = slices.len();
    nals.extend(slices);
    Some((nals, fc))
}

// Split a complete Annex-B buffer into NAL payloads (start codes stripped).
fn split_annexb(buf: &[u8]) -> Vec<Vec<u8>> {
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
