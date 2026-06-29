// On-disk store — byte-compatible with src/storage.ts (read by the Node server/player).
//   data file: per GOP, concatenated [u32 BE len][nal bytes] (frameNal).
//   idx  file: per GOP, [u32 LE body][f64 LE t,e,o,l,n][u16 LE acts...][u32 LE body], body = 40+2n.
//             l===0 => no-change (no video bytes), o carries refT.
// Files bucket by LOCAL time: DATA_DIR/YYYY/MM/DD/<HH>.<session>.data + .idx.

use chrono::{Datelike, Local, TimeZone, Timelike};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

pub const FPS: f64 = 30.0;

fn encode_record(t: f64, e: f64, o: f64, l: f64, n: f64, acts: &[u16]) -> Vec<u8> {
    let body = 40 + acts.len() * 2;
    let mut buf = Vec::with_capacity(4 + body + 4);
    buf.extend_from_slice(&(body as u32).to_le_bytes());
    for v in [t, e, o, l, n] { buf.extend_from_slice(&v.to_le_bytes()); }
    for &a in acts { buf.extend_from_slice(&a.to_le_bytes()); }
    buf.extend_from_slice(&(body as u32).to_le_bytes());
    buf
}

pub struct Writer {
    data_dir: String,
    session: u64,
    cur_key: String,
    data_path: PathBuf,
    idx_path: PathBuf,
    offset: u64,
}

impl Writer {
    pub fn new(data_dir: &str, session: u64) -> Self {
        Writer {
            data_dir: data_dir.to_string(),
            session,
            cur_key: String::new(),
            data_path: PathBuf::new(),
            idx_path: PathBuf::new(),
            offset: 0,
        }
    }

    fn ensure(&mut self, t_ms: i64) -> std::io::Result<()> {
        let dt = Local.timestamp_millis_opt(t_ms).single()
            .unwrap_or_else(|| Local.timestamp_opt(0, 0).unwrap());
        let (y, mo, d, h) = (dt.year(), dt.month(), dt.day(), dt.hour());
        let dir = format!("{}/{:04}/{:02}/{:02}", self.data_dir, y, mo, d);
        let key = format!("{}/{:02}", dir, h);
        if key == self.cur_key && !self.data_path.as_os_str().is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&dir)?;
        self.data_path = PathBuf::from(format!("{}/{:02}.{}.data", dir, h, self.session));
        self.idx_path = PathBuf::from(format!("{}/{:02}.{}.idx", dir, h, self.session));
        self.offset = fs::metadata(&self.data_path).map(|m| m.len()).unwrap_or(0);
        self.cur_key = key;
        Ok(())
    }

    fn append(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
        let mut f = OpenOptions::new().create(true).append(true).open(path)?;
        f.write_all(bytes)?;
        Ok(())
    }

    /// Write an encoded GOP: data bytes first (so the idx never points past the data), then idx.
    pub fn write_gop(&mut self, nals: &[Vec<u8>], t_ms: i64, frame_count: usize, acts: &[u16]) -> std::io::Result<()> {
        self.ensure(t_ms)?;
        let mut body = Vec::new();
        for n in nals {
            body.extend_from_slice(&(n.len() as u32).to_be_bytes());
            body.extend_from_slice(n);
        }
        Self::append(&self.data_path, &body)?;
        let o = self.offset;
        self.offset += body.len() as u64;
        let e = t_ms as f64 + ((frame_count as f64 / FPS) * 1000.0).round();
        // Match acts length to the encoder's actual frame count (it may flush one fewer at a
        // burst boundary): truncate or zero-pad rather than discarding the real values.
        let a: Vec<u16> = (0..frame_count).map(|i| acts.get(i).copied().unwrap_or(0)).collect();
        let rec = encode_record(t_ms as f64, e, o as f64, body.len() as f64, frame_count as f64, &a);
        Self::append(&self.idx_path, &rec)?;
        Ok(())
    }

    /// Write a no-change (static) record: idx only, l=0, o=refT.
    pub fn write_no_change(&mut self, t_ms: i64, ref_t: f64, acts: &[u16]) -> std::io::Result<()> {
        self.ensure(t_ms)?;
        let n = acts.len();
        let e = t_ms as f64 + ((n as f64 / FPS) * 1000.0).round();
        let rec = encode_record(t_ms as f64, e, ref_t, 0.0, n as f64, acts);
        Self::append(&self.idx_path, &rec)?;
        Ok(())
    }
}
