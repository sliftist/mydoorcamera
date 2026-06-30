// Raw V4L2 multiplanar M2M hardware JPEG decode probe (/dev/video10): MJPG -> NV12, no ffmpeg.
// Capture queue set up upfront; after feeding, DECODER_CMD STOP drains the (single) decoded frame.
// Run: hwtest <in.jpg> <out.nv12>
#![allow(non_camel_case_types, non_upper_case_globals)]

use std::os::raw::{c_int, c_ulong, c_void};
use std::ptr;
use v4l2_sys_mit::{v4l2_buffer, v4l2_decoder_cmd, v4l2_format, v4l2_plane, v4l2_requestbuffers};

const W: u32 = 1920;
const H: u32 = 1080;
const CAP: u32 = 9;
const OUT: u32 = 10;
const MMAP: u32 = 1;
const FIELD_NONE: u32 = 1;
fn fourcc(a: u8, b: u8, c: u8, d: u8) -> u32 { (a as u32) | (b as u32) << 8 | (c as u32) << 16 | (d as u32) << 24 }
fn ioc(dir: u32, nr: u32, size: usize) -> c_ulong { (((dir << 30) | ((size as u32) << 16) | (0x56 << 8) | nr)) as c_ulong }
fn try_ioctl(fd: c_int, req: c_ulong, arg: *mut c_void) -> i32 { unsafe { libc::ioctl(fd, req, arg) } }
fn xioctl(fd: c_int, req: c_ulong, arg: *mut c_void, what: &str) {
    if try_ioctl(fd, req, arg) < 0 { panic!("{} failed: {}", what, std::io::Error::last_os_error()); }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let inp = a.get(1).cloned().unwrap_or_else(|| "/tmp/one.jpg".into());
    let outp = a.get(2).cloned().unwrap_or_else(|| "/tmp/out.nv12".into());
    let jpeg = std::fs::read(&inp).expect("read jpeg");
    println!("jpeg {} bytes", jpeg.len());

    let path = std::ffi::CString::new("/dev/video10").unwrap();
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDWR) };
    if fd < 0 { panic!("open: {}", std::io::Error::last_os_error()); }

    let s_fmt = ioc(3, 5, std::mem::size_of::<v4l2_format>());
    let reqbufs = ioc(3, 8, std::mem::size_of::<v4l2_requestbuffers>());
    let querybuf = ioc(3, 9, std::mem::size_of::<v4l2_buffer>());
    let qbuf = ioc(3, 15, std::mem::size_of::<v4l2_buffer>());
    let dqbuf = ioc(3, 17, std::mem::size_of::<v4l2_buffer>());
    let streamon = ioc(1, 18, std::mem::size_of::<c_int>());
    let decoder_cmd = ioc(3, 96, std::mem::size_of::<v4l2_decoder_cmd>());

    unsafe {
        // S_FMT output (MJPG) + capture (NV12).
        let mut f: v4l2_format = std::mem::zeroed();
        f.type_ = OUT;
        f.fmt.pix_mp.width = W; f.fmt.pix_mp.height = H;
        f.fmt.pix_mp.pixelformat = fourcc(b'M', b'J', b'P', b'G');
        f.fmt.pix_mp.field = FIELD_NONE; f.fmt.pix_mp.num_planes = 1;
        f.fmt.pix_mp.plane_fmt[0].sizeimage = 1 << 21;
        xioctl(fd, s_fmt, &mut f as *mut _ as *mut c_void, "S_FMT output");

        let mut cf: v4l2_format = std::mem::zeroed();
        cf.type_ = CAP;
        cf.fmt.pix_mp.width = W; cf.fmt.pix_mp.height = H;
        cf.fmt.pix_mp.pixelformat = fourcc(b'N', b'V', b'1', b'2');
        cf.fmt.pix_mp.field = FIELD_NONE; cf.fmt.pix_mp.num_planes = 1;
        xioctl(fd, s_fmt, &mut cf as *mut _ as *mut c_void, "S_FMT capture");
        let cnp = cf.fmt.pix_mp.num_planes;

        // mmap helper for a queue.
        let map_q = |btype: u32, count: u32, nplanes: u32| -> Vec<(*mut u8, u32)> {
            let mut rb: v4l2_requestbuffers = std::mem::zeroed();
            rb.count = count; rb.type_ = btype; rb.memory = MMAP;
            xioctl(fd, reqbufs, &mut rb as *mut _ as *mut c_void, "REQBUFS");
            let mut v = Vec::new();
            for i in 0..count {
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = btype; b.memory = MMAP; b.index = i; b.length = nplanes; b.m.planes = pl.as_mut_ptr();
                xioctl(fd, querybuf, &mut b as *mut _ as *mut c_void, "QUERYBUF");
                let len = pl[0].length; let off = pl[0].m.mem_offset;
                let p = libc::mmap(ptr::null_mut(), len as usize, libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, fd, off as i64) as *mut u8;
                v.push((p, len));
            }
            v
        };
        let out_bufs = map_q(OUT, 1, 1);
        let cap_bufs = map_q(CAP, 2, cnp as u32);
        println!("out buf {} bytes, cap bufs {} x {} bytes", out_bufs[0].1, cap_bufs.len(), cap_bufs[0].1);

        // Queue all capture buffers.
        for i in 0..cap_bufs.len() {
            let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
            pl[0].length = cap_bufs[i].1;
            let mut b: v4l2_buffer = std::mem::zeroed();
            b.type_ = CAP; b.memory = MMAP; b.index = i as u32; b.length = cnp as u32; b.m.planes = pl.as_mut_ptr();
            xioctl(fd, qbuf, &mut b as *mut _ as *mut c_void, "QBUF capture");
        }

        // STREAMON both.
        let mut t = OUT as c_int; xioctl(fd, streamon, &mut t as *mut _ as *mut c_void, "STREAMON output");
        let mut t2 = CAP as c_int; xioctl(fd, streamon, &mut t2 as *mut _ as *mut c_void, "STREAMON capture");

        // Feed the JPEG.
        ptr::copy_nonoverlapping(jpeg.as_ptr(), out_bufs[0].0, jpeg.len().min(out_bufs[0].1 as usize));
        let mut qpl: [v4l2_plane; 8] = std::mem::zeroed();
        qpl[0].bytesused = jpeg.len() as u32; qpl[0].length = out_bufs[0].1;
        let mut qb: v4l2_buffer = std::mem::zeroed();
        qb.type_ = OUT; qb.memory = MMAP; qb.index = 0; qb.length = 1; qb.m.planes = qpl.as_mut_ptr();
        xioctl(fd, qbuf, &mut qb as *mut _ as *mut c_void, "QBUF output");

        let _ = decoder_cmd; // (drain not used — feeding continuously instead)
        let mut feeds = 1u32;

        for iter in 0..40 {
            let mut pfd = libc::pollfd { fd, events: libc::POLLIN | libc::POLLOUT | libc::POLLPRI, revents: 0 };
            let pr = libc::poll(&mut pfd, 1, 300);
            if iter < 4 || pfd.revents & (libc::POLLIN | libc::POLLERR) != 0 { println!("[{}] poll={} revents=0x{:x} feeds={}", iter, pr, pfd.revents, feeds); }
            if pfd.revents & libc::POLLOUT != 0 {
                // Output buffer consumed -> dequeue and re-feed the same JPEG (continuous stream).
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = OUT; b.memory = MMAP; b.length = 1; b.m.planes = pl.as_mut_ptr();
                if try_ioctl(fd, dqbuf, &mut b as *mut _ as *mut c_void) == 0 && feeds < 30 {
                    let mut rp: [v4l2_plane; 8] = std::mem::zeroed();
                    rp[0].bytesused = jpeg.len() as u32; rp[0].length = out_bufs[0].1;
                    let mut rb: v4l2_buffer = std::mem::zeroed();
                    rb.type_ = OUT; rb.memory = MMAP; rb.index = 0; rb.length = 1; rb.m.planes = rp.as_mut_ptr();
                    let _ = try_ioctl(fd, qbuf, &mut rb as *mut _ as *mut c_void);
                    feeds += 1;
                }
            }
            if pfd.revents & libc::POLLIN != 0 {
                let mut pl: [v4l2_plane; 8] = std::mem::zeroed();
                let mut b: v4l2_buffer = std::mem::zeroed();
                b.type_ = CAP; b.memory = MMAP; b.length = cnp as u32; b.m.planes = pl.as_mut_ptr();
                xioctl(fd, dqbuf, &mut b as *mut _ as *mut c_void, "DQBUF capture");
                let used = pl[0].bytesused as usize;
                let yuv = std::slice::from_raw_parts(cap_bufs[b.index as usize].0, used.min(cap_bufs[b.index as usize].1 as usize));
                let nl = (W * H) as usize;
                let mean: u64 = yuv[..nl.min(yuv.len())].iter().map(|&x| x as u64).sum::<u64>() / nl.max(1) as u64;
                println!("DECODED NV12 idx={} bytesused={} mean_luma={} -> HW JPEG DECODE OK", b.index, used, mean);
                std::fs::write(&outp, yuv).unwrap();
                println!("wrote {} ({} bytes)", outp, yuv.len());
                libc::close(fd); return;
            }
        }
        println!("no frame after drain");
        libc::close(fd);
    }
}
