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
    // Exact per-frame timing: each picked frame's ms offset from the GOP start (clamped to u16).
    let dts: Vec<u16> = gop.iter().map(|f| (f.2 - t).clamp(0, 65535) as u16).collect();
    if (mx as f64) < THRESH && !crate::encode_all() {
        if let Some(rt) = lv.last_t {
            let _ = lv.writer.write_no_change(t, e, rt, &acts, &dts);
        }
        return;
    }
    let want = gop.len();
    let jpegs: Vec<Vec<u8>> = gop.into_iter().map(|f| f.0).collect();
    match encode(jpegs) {
        Some((nals, fc)) if fc > 0 => {
            if fc < want { eprintln!("[thin] L? GOP short: encoded {}/{} frames", fc, want); }
            if let Err(err) = lv.writer.write_gop(&nals, t, e, fc, &acts, &dts) { eprintln!("[thin] write_gop: {}", err); }
            lv.last_t = Some(t as f64);
        }
        _ => eprintln!("[thin] flush: encode produced no frames (codec open failed?)"),
    }
}

// Encode the picked JPEGs into one H.264 GOP entirely in HARDWARE (no ffmpeg): decode each JPEG on
// /dev/video10 and encode the NV12 on /dev/video11 (fresh per-GOP contexts — thinned GOPs are
// infrequent). Returns the GOP's NALs (SPS/PPS + slices) and the frame count.
fn encode(jpegs: Vec<Vec<u8>>) -> Option<(Vec<Vec<u8>>, usize)> {
    let want = jpegs.len();
    let mut dec = crate::hwcodec::Codec::decoder(1920, 1080).ok()?;
    let mut enc = crate::hwcodec::Codec::encoder(1920, 1088, THIN_BITRATE as i32, SLOTS as i32).ok()?;
    // Each thinned GOP is an isolated encode session, so the decode+encode pipelines must be fully
    // drained: feed every picked JPEG, then keep feeding copies of the last frame until all `want`
    // frames have emerged (both codecs have ~2-3 frames of latency, chained). Bounded flush count
    // guards against a stuck pipeline.
    let last = jpegs.last().cloned();
    let mut nals: Vec<Vec<u8>> = Vec::new();
    let mut fc = 0usize;
    let mut flushes = 0usize;
    let mut iter = jpegs.into_iter();
    loop {
        let j = match iter.next() {
            Some(j) => j,
            None => match &last {
                Some(l) if flushes < 32 => { flushes += 1; l.clone() }
                _ => break,
            },
        };
        for nv12 in dec.process(&j) {
            for h in enc.process(&nv12) {
                if fc < want { for nl in crate::split_nals(&h) { nals.push(nl); } fc += 1; }
            }
        }
        if fc >= want { break; }
    }
    Some((nals, fc))
}
