// All-hardware video codecs via raw V4L2 multiplanar M2M (no ffmpeg, no software JPEG decode).
//   Decoder: /dev/video10  MJPG -> NV12   (hardware JPEG decode)
//   Encoder: /dev/video11  NV12 -> H264   (hardware H.264 encode)
// Both bcm2835-codec nodes are MULTIPLANAR M2M and need a CONTINUOUS stream (a few frames of
// pipeline fill before the first output appears). `Codec::process(input)` feeds one frame and
// returns whatever finished frames are ready (0..n). The fd is O_NONBLOCK so we drain without
// blocking, and only block (via poll) when we must reclaim an input buffer.

#![allow(non_camel_case_types)]
use std::os::raw::{c_int, c_ulong, c_void};
use std::ptr;
use v4l2_sys_mit::{v4l2_buffer, v4l2_control, v4l2_format, v4l2_plane, v4l2_requestbuffers};

const CAP: u32 = 9; // V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE
const OUT: u32 = 10; // V4L2_BUF_TYPE_VIDEO_OUTPUT_MPLANE
const MMAP: u32 = 1; // V4L2_MEMORY_MMAP
const FIELD_NONE: u32 = 1;
const CID_GOP_SIZE: u32 = 10029515;
const CID_BITRATE: u32 = 10029519;
const CID_REPEAT_SEQ_HEADER: u32 = 10029538; // 0x009909e2: repeat SPS/PPS before every IDR
const CID_H264_I_PERIOD: u32 = 10029670; // 0x00990a66: IDR interval in frames (governs keyframe spacing)

fn fourcc(s: &[u8; 4]) -> u32 { (s[0] as u32) | (s[1] as u32) << 8 | (s[2] as u32) << 16 | (s[3] as u32) << 24 }
fn ioc(dir: u32, nr: u32, size: usize) -> c_ulong { (((dir << 30) | ((size as u32) << 16) | (0x56 << 8) | nr)) as c_ulong }
fn ti(fd: c_int, req: c_ulong, arg: *mut c_void) -> i32 { unsafe { libc::ioctl(fd, req, arg) } }
fn xi(fd: c_int, req: c_ulong, arg: *mut c_void, what: &str) -> std::io::Result<()> {
    if ti(fd, req, arg) < 0 { Err(std::io::Error::new(std::io::ErrorKind::Other, format!("{}: {}", what, std::io::Error::last_os_error()))) } else { Ok(()) }
}

struct Buf { ptr: *mut u8, len: u32 }
unsafe impl Send for Buf {}

pub struct Codec {
    fd: c_int,
    out: Vec<Buf>,
    out_free: Vec<u32>,
    cap: Vec<Buf>,
    cnp: u32,
}

impl Codec {
    fn s_fmt(fd: c_int, btype: u32, w: u32, h: u32, pixfmt: u32, sizeimage: u32) -> std::io::Result<u32> {
        let s_fmt = ioc(3, 5, std::mem::size_of::<v4l2_format>());
        unsafe {
            let mut f: v4l2_format = std::mem::zeroed();
            f.type_ = btype;
            f.fmt.pix_mp.width = w; f.fmt.pix_mp.height = h;
            f.fmt.pix_mp.pixelformat = pixfmt; f.fmt.pix_mp.field = FIELD_NONE; f.fmt.pix_mp.num_planes = 1;
            if sizeimage > 0 { f.fmt.pix_mp.plane_fmt[0].sizeimage = sizeimage; }
            xi(fd, s_fmt, &mut f as *mut _ as *mut c_void, "S_FMT")?;
            Ok(f.fmt.pix_mp.num_planes as u32)
        }
    }
    fn reqbufs_mmap(fd: c_int, btype: u32, count: u32, nplanes: u32) -> std::io::Result<Vec<Buf>> {
        let reqbufs = ioc(3, 8, std::mem::size_of::<v4l2_requestbuffers>());
        let querybuf = ioc(3, 9, std::mem::size_of::<v4l2_buffer>());
        unsafe {
            let mut rb: v4l2_requestbuffers = std::mem::zeroed();
            rb.count = count; rb.type_ = btype; rb.memory = MMAP;
            xi(fd, reqbufs, &mut rb as *mut _ as *mut c_void, "REQBUFS")?;
            let mut v = Vec::new();
            for i in 0..count {
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = btype; b.memory = MMAP; b.index = i; b.length = nplanes; b.m.planes = pl.as_mut_ptr();
                xi(fd, querybuf, &mut b as *mut _ as *mut c_void, "QUERYBUF")?;
                let len = pl[0].length;
                let p = libc::mmap(ptr::null_mut(), len as usize, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, pl[0].m.mem_offset as i64) as *mut u8;
                if p == libc::MAP_FAILED as *mut u8 { return Err(std::io::Error::last_os_error()); }
                v.push(Buf { ptr: p, len });
            }
            Ok(v)
        }
    }
    fn qbuf_cap(&self, idx: u32) {
        unsafe {
            let mut pl: [v4l2_plane; 8] = std::mem::zeroed(); pl[0].length = self.cap[idx as usize].len;
            let mut b: v4l2_buffer = std::mem::zeroed();
            b.type_ = CAP; b.memory = MMAP; b.index = idx; b.length = self.cnp; b.m.planes = pl.as_mut_ptr();
            let _ = ti(self.fd, ioc(3, 15, std::mem::size_of::<v4l2_buffer>()), &mut b as *mut _ as *mut c_void);
        }
    }
    fn streamon(fd: c_int, btype: u32) -> std::io::Result<()> {
        let mut t = btype as c_int;
        xi(fd, ioc(1, 18, std::mem::size_of::<c_int>()), &mut t as *mut _ as *mut c_void, "STREAMON")
    }
    fn set_ctrl(fd: c_int, id: u32, value: i32) {
        unsafe {
            let mut c: v4l2_control = std::mem::zeroed(); c.id = id; c.value = value;
            let _ = ti(fd, ioc(3, 28, std::mem::size_of::<v4l2_control>()), &mut c as *mut _ as *mut c_void);
        }
    }

    fn open(dev: &str, out_fmt: [u8; 4], cap_fmt: [u8; 4], w: u32, h: u32, out_sizeimage: u32, ncap: u32, ctrls: &[(u32, i32)]) -> std::io::Result<Codec> {
        let path = std::ffi::CString::new(dev).unwrap();
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR | libc::O_NONBLOCK) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        Self::s_fmt(fd, OUT, w, h, fourcc(&out_fmt), out_sizeimage)?;
        let cnp = Self::s_fmt(fd, CAP, w, h, fourcc(&cap_fmt), 0)?;
        // Encoder controls must be set before STREAMON (post-stream changes are ignored by bcm2835).
        for &(id, value) in ctrls { Self::set_ctrl(fd, id, value); }
        let out = Self::reqbufs_mmap(fd, OUT, 4, 1)?;
        let cap = Self::reqbufs_mmap(fd, CAP, ncap, cnp)?;
        let c = Codec { fd, out, out_free: (0..4).collect(), cap, cnp };
        for i in 0..c.cap.len() as u32 { c.qbuf_cap(i); }
        Self::streamon(fd, OUT)?;
        Self::streamon(fd, CAP)?;
        Ok(c)
    }

    pub fn decoder(w: u32, h: u32) -> std::io::Result<Codec> {
        Codec::open("/dev/video10", *b"MJPG", *b"NV12", w, h, 1 << 21, 6, &[])
    }
    pub fn encoder(w: u32, h: u32, bitrate: i32, gop: i32) -> std::io::Result<Codec> {
        // REPEAT_SEQ_HEADER=1 makes every IDR carry SPS/PPS, so each GOP decodes standalone
        // (the player decodes one GOP at a time). Without it the encoder emits parameter sets
        // only once at stream start and every later GOP fails to decode (0 frames).
        Codec::open("/dev/video11", *b"NV12", *b"H264", w, h, 0, 6,
            &[(CID_GOP_SIZE, gop), (CID_H264_I_PERIOD, gop), (CID_BITRATE, bitrate), (CID_REPEAT_SEQ_HEADER, 1)])
    }

    // Non-blocking dequeue from a queue. Returns (index, bytesused) or None (EAGAIN/nothing ready).
    fn dq(&self, btype: u32) -> Option<(u32, usize)> {
        unsafe {
            let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
            let mut b: v4l2_buffer = std::mem::zeroed();
            b.type_ = btype; b.memory = MMAP; b.length = if btype == CAP { self.cnp } else { 1 }; b.m.planes = pl.as_mut_ptr();
            if ti(self.fd, ioc(3, 17, std::mem::size_of::<v4l2_buffer>()), &mut b as *mut _ as *mut c_void) < 0 { None }
            else { Some((b.index, pl[0].bytesused as usize)) }
        }
    }

    // Feed one input frame and return any finished output frames now available (copies).
    pub fn process(&mut self, input: &[u8]) -> Vec<Vec<u8>> {
        // Reclaim finished input buffers.
        while let Some((idx, _)) = self.dq(OUT) { self.out_free.push(idx); }
        // Ensure a free input buffer (block via poll if all are in flight).
        if self.out_free.is_empty() {
            let mut pfd = libc::pollfd { fd: self.fd, events: libc::POLLOUT, revents: 0 };
            unsafe { libc::poll(&mut pfd, 1, 1000); }
            while let Some((idx, _)) = self.dq(OUT) { self.out_free.push(idx); }
        }
        if let Some(idx) = self.out_free.pop() {
            unsafe {
                let dst = self.out[idx as usize].ptr;
                let n = input.len().min(self.out[idx as usize].len as usize);
                ptr::copy_nonoverlapping(input.as_ptr(), dst, n);
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                pl[0].bytesused = n as u32; pl[0].length = self.out[idx as usize].len;
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = OUT; b.memory = MMAP; b.index = idx; b.length = 1; b.m.planes = pl.as_mut_ptr();
                let _ = ti(self.fd, ioc(3, 15, std::mem::size_of::<v4l2_buffer>()), &mut b as *mut _ as *mut c_void);
            }
        }
        // Collect finished output frames.
        let mut out = Vec::new();
        while let Some((idx, used)) = self.dq(CAP) {
            let b = &self.cap[idx as usize];
            let data = unsafe { std::slice::from_raw_parts(b.ptr, used.min(b.len as usize)) };
            out.push(data.to_vec());
            self.qbuf_cap(idx);
        }
        out
    }
}

impl Drop for Codec {
    fn drop(&mut self) {
        let off = ioc(1, 19, std::mem::size_of::<c_int>());
        let mut t1 = OUT as c_int; let _ = ti(self.fd, off, &mut t1 as *mut _ as *mut c_void);
        let mut t2 = CAP as c_int; let _ = ti(self.fd, off, &mut t2 as *mut _ as *mut c_void);
        for b in self.out.iter().chain(self.cap.iter()) { unsafe { libc::munmap(b.ptr as *mut c_void, b.len as usize); } }
        unsafe { libc::close(self.fd); }
    }
}
