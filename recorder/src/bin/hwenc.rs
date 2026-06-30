// Raw V4L2 multiplanar M2M hardware H.264 encode probe (/dev/video11): NV12 -> H264, no ffmpeg.
// Feeds an NV12 frame continuously and collects the encoded H.264. Run: hwenc <in.nv12> <out.h264>
#![allow(non_camel_case_types, non_upper_case_globals)]

use std::io::Write;
use std::os::raw::{c_int, c_ulong, c_void};
use std::ptr;
use v4l2_sys_mit::{v4l2_buffer, v4l2_format, v4l2_plane, v4l2_requestbuffers};

const W: u32 = 1920;
const H: u32 = 1088; // decoder pads to 1088; match it for the NV12 input
const CAP: u32 = 9;
const OUT: u32 = 10;
const MMAP: u32 = 1;
const FIELD_NONE: u32 = 1;
fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 { (a as u32) | (b as u32) << 8 | (c as u32) << 16 | (d as u32) << 24 }
fn ioc(dir: u32, nr: u32, size: usize) -> c_ulong { (((dir << 30) | ((size as u32) << 16) | (0x56 << 8) | nr)) as c_ulong }
fn ti(fd: c_int, req: c_ulong, arg: *mut c_void) -> i32 { unsafe { libc::ioctl(fd, req, arg) } }
fn xi(fd: c_int, req: c_ulong, arg: *mut c_void, what: &str) { if ti(fd, req, arg) < 0 { panic!("{} failed: {}", what, std::io::Error::last_os_error()); } }

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let inp = a.get(1).cloned().unwrap_or_else(|| "/tmp/real.nv12".into());
    let outp = a.get(2).cloned().unwrap_or_else(|| "/tmp/out.h264".into());
    let nv12 = std::fs::read(&inp).expect("read nv12");
    println!("nv12 {} bytes", nv12.len());

    let path = std::ffi::CString::new("/dev/video11").unwrap();
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR) };
    if fd < 0 { panic!("open: {}", std::io::Error::last_os_error()); }

    let s_fmt = ioc(3, 5, std::mem::size_of::<v4l2_format>());
    let reqbufs = ioc(3, 8, std::mem::size_of::<v4l2_requestbuffers>());
    let querybuf = ioc(3, 9, std::mem::size_of::<v4l2_buffer>());
    let qbuf = ioc(3, 15, std::mem::size_of::<v4l2_buffer>());
    let dqbuf = ioc(3, 17, std::mem::size_of::<v4l2_buffer>());
    let streamon = ioc(1, 18, std::mem::size_of::<c_int>());

    let mut h264 = std::fs::File::create(&outp).unwrap();

    unsafe {
        // OUTPUT = NV12 in.
        let mut f: v4l2_format = std::mem::zeroed();
        f.type_ = OUT;
        f.fmt.pix_mp.width = W; f.fmt.pix_mp.height = H;
        f.fmt.pix_mp.pixelformat = fourcc(b'N', b'V', b'1', b'2');
        f.fmt.pix_mp.field = FIELD_NONE; f.fmt.pix_mp.num_planes = 1;
        f.fmt.pix_mp.plane_fmt[0].sizeimage = nv12.len() as u32;
        xi(fd, s_fmt, &mut f as *mut _ as *mut c_void, "S_FMT output");
        // CAPTURE = H264 out.
        let mut cf: v4l2_format = std::mem::zeroed();
        cf.type_ = CAP;
        cf.fmt.pix_mp.width = W; cf.fmt.pix_mp.height = H;
        cf.fmt.pix_mp.pixelformat = fourcc(b'H', b'2', b'6', b'4');
        cf.fmt.pix_mp.field = FIELD_NONE; cf.fmt.pix_mp.num_planes = 1;
        cf.fmt.pix_mp.plane_fmt[0].sizeimage = 1 << 21;
        xi(fd, s_fmt, &mut cf as *mut _ as *mut c_void, "S_FMT capture");
        let cnp = cf.fmt.pix_mp.num_planes;

        let map_q = |btype: u32, count: u32, nplanes: u32| -> Vec<(*mut u8, u32)> {
            let mut rb: v4l2_requestbuffers = std::mem::zeroed();
            rb.count = count; rb.type_ = btype; rb.memory = MMAP;
            xi(fd, reqbufs, &mut rb as *mut _ as *mut c_void, "REQBUFS");
            let mut v = Vec::new();
            for i in 0..count {
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = btype; b.memory = MMAP; b.index = i; b.length = nplanes; b.m.planes = pl.as_mut_ptr();
                xi(fd, querybuf, &mut b as *mut _ as *mut c_void, "QUERYBUF");
                let len = pl[0].length; let off = pl[0].m.mem_offset;
                let p = libc::mmap(ptr::null_mut(), len as usize, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, off as i64) as *mut u8;
                v.push((p, len));
            }
            v
        };
        let out_bufs = map_q(OUT, 2, 1);
        let cap_bufs = map_q(CAP, 4, cnp as u32);
        println!("out buf {} bytes, cap bufs {} x {}", out_bufs[0].1, cap_bufs.len(), cap_bufs[0].1);

        for i in 0..cap_bufs.len() {
            let mut pl: [v4l2_plane; 8] = std::mem::zeroed(); pl[0].length = cap_bufs[i].1;
            let mut b: v4l2_buffer = std::mem::zeroed();
            b.type_ = CAP; b.memory = MMAP; b.index = i as u32; b.length = cnp as u32; b.m.planes = pl.as_mut_ptr();
            xi(fd, qbuf, &mut b as *mut _ as *mut c_void, "QBUF capture");
        }
        let mut t = OUT as c_int; xi(fd, streamon, &mut t as *mut _ as *mut c_void, "STREAMON output");
        let mut t2 = CAP as c_int; xi(fd, streamon, &mut t2 as *mut _ as *mut c_void, "STREAMON capture");

        // queue both output buffers with the NV12 frame to prime the pipeline.
        let feed = |idx: u32| {
            ptr::copy_nonoverlapping(nv12.as_ptr(), out_bufs[idx as usize].0, nv12.len().min(out_bufs[idx as usize].1 as usize));
            let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
            pl[0].bytesused = nv12.len() as u32; pl[0].length = out_bufs[idx as usize].1;
            let mut b: v4l2_buffer = std::mem::zeroed();
            b.type_ = OUT; b.memory = MMAP; b.index = idx; b.length = 1; b.m.planes = pl.as_mut_ptr();
            xi(fd, qbuf, &mut b as *mut _ as *mut c_void, "QBUF output");
        };
        feed(0); feed(1);
        let mut feeds = 2u32;
        let mut got = 0u32;

        for iter in 0..60 {
            let mut pfd = libc::pollfd { fd, events: libc::POLLIN | libc::POLLOUT, revents: 0 };
            let pr = libc::poll(&mut pfd, 1, 300);
            if iter < 3 || pfd.revents & libc::POLLIN != 0 { println!("[{}] poll={} revents=0x{:x} feeds={} got={}", iter, pr, pfd.revents, feeds, got); }
            if pfd.revents & libc::POLLOUT != 0 {
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = OUT; b.memory = MMAP; b.length = 1; b.m.planes = pl.as_mut_ptr();
                if ti(fd, dqbuf, &mut b as *mut _ as *mut c_void) == 0 && feeds < 30 { feed(b.index); feeds += 1; }
            }
            if pfd.revents & libc::POLLIN != 0 {
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = CAP; b.memory = MMAP; b.length = cnp as u32; b.m.planes = pl.as_mut_ptr();
                xi(fd, dqbuf, &mut b as *mut _ as *mut c_void, "DQBUF capture");
                let used = pl[0].bytesused as usize;
                let data = std::slice::from_raw_parts(cap_bufs[b.index as usize].0, used.min(cap_bufs[b.index as usize].1 as usize));
                h264.write_all(data).unwrap();
                got += 1;
                if got <= 3 { println!("  H264 packet idx={} {} bytes (first bytes {:02x} {:02x} {:02x} {:02x} {:02x})", b.index, used, data[0], data[1], data[2], data[3], data.get(4).copied().unwrap_or(0)); }
                // recycle the capture buffer
                let mut rp: [v4l2_plane; 8] = std::mem::zeroed(); rp[0].length = cap_bufs[b.index as usize].1;
                let mut rb: v4l2_buffer = std::mem::zeroed();
                rb.type_ = CAP; rb.memory = MMAP; rb.index = b.index; rb.length = cnp as u32; rb.m.planes = rp.as_mut_ptr();
                xi(fd, qbuf, &mut rb as *mut _ as *mut c_void, "re-QBUF capture");
                if got >= 10 { break; }
            }
        }
        println!("encoded {} H264 packets -> {}", got, outp);
        libc::close(fd);
    }
}
