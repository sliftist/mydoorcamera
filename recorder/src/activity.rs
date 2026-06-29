// Activity detector — port of src/activityDetect.ts. Measures how much a small grayscale frame
// differs from a robust median-background, keeping only changes that are both strong AND spatially
// clustered. No timestamp mask (the clock is no longer burned into the video). The median
// background is refreshed every BG_EVERY frames; per-frame cost is just the cheap diff + density.

pub const W: usize = 120;
pub const H: usize = 68;
pub const FRAME: usize = W * H;

const STRONG: f32 = 12.0;       // a pixel must differ from background by > this to be a candidate
const DENSITY_R: i32 = 2;       // clustering radius
const DENSITY_THR: f32 = 0.18;  // a candidate counts only where >18% of its neighborhood is strong
const RING: usize = 60;         // background = per-pixel median over this many recent frames
const MIN_RING: usize = 20;     // warm-up
const LOWVAR: f32 = 50.0;       // frame variance below this = blank/corrupt -> skip
const BG_EVERY: i32 = 15;       // recompute the (expensive) median background every N frames

fn box_blur(src: &[f32], r: i32, tmp: &mut [f32], out: &mut [f32]) {
    let (w, h) = (W as i32, H as i32);
    for y in 0..h {
        for x in 0..w {
            let (mut s, mut c) = (0.0f32, 0.0f32);
            for dx in -r..=r {
                let xx = x + dx;
                if xx >= 0 && xx < w { s += src[(y * w + xx) as usize]; c += 1.0; }
            }
            tmp[(y * w + x) as usize] = s / c;
        }
    }
    for y in 0..h {
        for x in 0..w {
            let (mut s, mut c) = (0.0f32, 0.0f32);
            for dy in -r..=r {
                let yy = y + dy;
                if yy >= 0 && yy < h { s += tmp[(yy * w + x) as usize]; c += 1.0; }
            }
            out[(y * w + x) as usize] = s / c;
        }
    }
}

pub struct ActivityModel {
    ring: Vec<Vec<u8>>,
    bg: Option<Vec<f32>>,
    since: i32,
    s: Vec<f32>,
    mask: Vec<f32>,
    blur_tmp: Vec<f32>,
    blur_out: Vec<f32>,
}

impl ActivityModel {
    pub fn new() -> Self {
        ActivityModel {
            ring: Vec::new(), bg: None, since: 0,
            s: vec![0.0; FRAME], mask: vec![0.0; FRAME],
            blur_tmp: vec![0.0; FRAME], blur_out: vec![0.0; FRAME],
        }
    }

    fn background_median(&self) -> Vec<f32> {
        let n = self.ring.len();
        let mut bg = vec![0.0f32; FRAME];
        let mut col = vec![0u8; n];
        for i in 0..FRAME {
            for k in 0..n { col[k] = self.ring[k][i]; }
            col.sort_unstable();
            bg[i] = col[n >> 1] as f32;
        }
        bg
    }

    fn activity_of(&mut self, cur: &[u8], bg: &[f32]) -> f32 {
        let mut sum = 0.0f32;
        for i in 0..FRAME { let d = cur[i] as f32 - bg[i]; self.s[i] = d; sum += d; }
        let shift = sum / FRAME as f32; // global brightness shift (mean — robust enough, cheap)
        for i in 0..FRAME { self.mask[i] = if (self.s[i] - shift).abs() > STRONG { 1.0 } else { 0.0 }; }
        box_blur(&self.mask, DENSITY_R, &mut self.blur_tmp, &mut self.blur_out);
        let mut area = 0usize;
        for i in 0..FRAME { if self.blur_out[i] > DENSITY_THR { area += 1; } }
        area as f32 / FRAME as f32
    }

    pub fn compute(&mut self, gray: &[u8]) -> f32 {
        let mut mean = 0.0f32;
        for &p in &gray[..FRAME] { mean += p as f32; }
        mean /= FRAME as f32;
        let mut var = 0.0f32;
        for &p in &gray[..FRAME] { let d = p as f32 - mean; var += d * d; }
        var /= FRAME as f32;
        if var < LOWVAR { return 0.0; } // blank/corrupt -> skip

        if self.since <= 0 || self.bg.is_none() {
            self.ring.push(gray[..FRAME].to_vec());
            if self.ring.len() > RING { self.ring.remove(0); }
            if self.ring.len() >= MIN_RING { self.bg = Some(self.background_median()); }
            self.since = BG_EVERY;
        }
        self.since -= 1;

        if let Some(bg) = self.bg.take() {
            let a = self.activity_of(gray, &bg);
            self.bg = Some(bg);
            a
        } else {
            0.0
        }
    }
}
