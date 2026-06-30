// On-disk store — byte-compatible with src/storage.ts (read by the Node server/player).
//   data file: per GOP, concatenated [u32 BE len][nal bytes] (frameNal).
//   idx  file: per GOP, [u32 LE body][f64 LE t,e,o,l,n][u16 LE act×n][u16 LE dt×n][u32 LE body],
//             body = 40 + 4n. dt[i] = ms offset of frame i from t (exact per-frame timing; dt[0]=0).
//             l===0 => no-change (no video bytes), o carries refT.
// Level-bucketed paths (mirror of storage.ts bucketOf): L0 under DATA_DIR (folder=day, file=hour);
// thinned levels under THIN_DIR/L<n> (L1 folder=month file=day; L2+ folder=year file=month).

use chrono::{Datelike, Local, TimeZone, Timelike};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

const DATA_DIR: &str = "/var/lib/mydoorcamera/video";
const THIN_DIR: &str = "/var/lib/mydoorcamera/thin";

fn encode_record(t: f64, e: f64, o: f64, l: f64, n: f64, acts: &[u16], dts: &[u16]) -> Vec<u8> {
    let body = 40 + acts.len() * 2 + dts.len() * 2;
    let mut buf = Vec::with_capacity(4 + body + 4);
    buf.extend_from_slice(&(body as u32).to_le_bytes());
    for v in [t, e, o, l, n] { buf.extend_from_slice(&v.to_le_bytes()); }
    for &a in acts { buf.extend_from_slice(&a.to_le_bytes()); }
    for &d in dts { buf.extend_from_slice(&d.to_le_bytes()); }
    buf.extend_from_slice(&(body as u32).to_le_bytes());
    buf
}

pub struct Writer {
    level: usize,
    session: u64,
    cur_key: String,
    data_path: PathBuf,
    idx_path: PathBuf,
    offset: u64,
}

impl Writer {
    pub fn new(level: usize, session: u64) -> Self {
        Writer { level, session, cur_key: String::new(), data_path: PathBuf::new(), idx_path: PathBuf::new(), offset: 0 }
    }

    fn root(&self) -> String {
        if self.level == 0 { DATA_DIR.to_string() } else { format!("{}/L{}", THIN_DIR, self.level) }
    }

    // (relative dir, file stem) for a timestamp at this level.
    fn bucket(&self, t_ms: i64) -> (String, String) {
        let dt = Local.timestamp_millis_opt(t_ms).single().unwrap_or_else(|| Local.timestamp_opt(0, 0).unwrap());
        let (y, mo, d, h) = (dt.year(), dt.month(), dt.day(), dt.hour());
        match self.level {
            0 => (format!("{:04}/{:02}/{:02}", y, mo, d), format!("{:02}", h)),
            1 => (format!("{:04}/{:02}", y, mo), format!("{:02}", d)),
            _ => (format!("{:04}", y), format!("{:02}", mo)),
        }
    }

    fn ensure(&mut self, t_ms: i64) -> std::io::Result<()> {
        let (rel, stem) = self.bucket(t_ms);
        let dir = format!("{}/{}", self.root(), rel);
        let key = format!("{}|{}", dir, stem);
        if key != self.cur_key || self.data_path.as_os_str().is_empty() {
            self.cur_key = key;
            self.data_path = PathBuf::from(format!("{}/{}.{}.data", dir, stem, self.session));
            self.idx_path = PathBuf::from(format!("{}/{}.{}.idx", dir, stem, self.session));
            self.offset = fs::metadata(&self.data_path).map(|m| m.len()).unwrap_or(0);
        }
        fs::create_dir_all(&dir)?; // ensure dir exists every time (cheap; survives a wipe)
        Ok(())
    }

    fn append(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(bytes)?;
        Ok(())
    }

    /// Write an encoded GOP: data bytes first (so the idx never points past the data), then idx.
    /// `e_ms` is the GOP's real end time (L0: ~t+1s; thinned: t + the window span it represents).
    pub fn write_gop(&mut self, nals: &[Vec<u8>], t_ms: i64, e_ms: i64, frame_count: usize, acts: &[u16], dts: &[u16]) -> std::io::Result<()> {
        self.ensure(t_ms)?;
        let mut body = Vec::new();
        for n in nals {
            body.extend_from_slice(&(n.len() as u32).to_be_bytes());
            body.extend_from_slice(n);
        }
        Self::append(&self.data_path, &body)?;
        let o = self.offset;
        self.offset += body.len() as u64;
        let a: Vec<u16> = (0..frame_count).map(|i| acts.get(i).copied().unwrap_or(0)).collect();
        let d: Vec<u16> = (0..frame_count).map(|i| dts.get(i).copied().unwrap_or(0)).collect();
        let rec = encode_record(t_ms as f64, e_ms as f64, o as f64, body.len() as f64, frame_count as f64, &a, &d);
        Self::append(&self.idx_path, &rec)?;
        Ok(())
    }

    /// Write a no-change (static) record: idx only, l=0, o=refT.
    pub fn write_no_change(&mut self, t_ms: i64, e_ms: i64, ref_t: f64, acts: &[u16], dts: &[u16]) -> std::io::Result<()> {
        self.ensure(t_ms)?;
        let n = acts.len();
        let d: Vec<u16> = (0..n).map(|i| dts.get(i).copied().unwrap_or(0)).collect();
        let rec = encode_record(t_ms as f64, e_ms as f64, ref_t, 0.0, n as f64, acts, &d);
        Self::append(&self.idx_path, &rec)?;
        Ok(())
    }
}
