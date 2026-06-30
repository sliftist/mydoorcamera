// V4L2 hardware-codec probe + scaffold for the no-ffmpeg rewrite (WIP).
//
// FINDINGS (established by this probe + v4l2-ctl):
//   * /dev/video10 (bcm2835-codec-decode) decodes MJPG -> NV12/YU12 in hardware.
//   * /dev/video11 (bcm2835-codec-encode) encodes NV12/YU12 -> H264 in hardware.
//   * Both are VIDEO MEMORY-TO-MEMORY *MULTIPLANAR* (caps 0x...4000) — they require the
//     V4L2 *_MPLANE buffer types and v4l2_pix_format_mplane / v4l2_plane[] structs.
//   * The `v4l` crate only implements SINGLE-planar S_FMT/QBUF (single-planar S_FMT here
//     returns EINVAL), so the rewrite must use RAW V4L2 multiplanar ioctls. The kernel
//     structs/consts come from `v4l2-sys-mit` (added as a dep); ioctl/mmap/poll from `libc`.
//
// PLAN (the all-hardware pipeline, replacing the ffmpeg encoder + software JPEG decode):
//   camera MJPEG (v4l capture) -> video10 [MJPG->NV12, HW] -> video11 [NV12->H264, HW] -> store.
//   First cut: MMAP buffers + one NV12 memcpy between decoder-CAPTURE and encoder-OUTPUT.
//   Optimization: DMABUF-export the decoder CAPTURE buffers and import as encoder OUTPUT (zero-copy)
//   — needs raw VIDIOC_EXPBUF + V4L2_MEMORY_DMABUF (not in the v4l crate).
//
// This probe (single-planar via the v4l crate) is kept only to document the EINVAL that proves the
// multiplanar requirement; the real implementation is the raw-mplane module being built next.

fn main() {
    eprintln!("hwtest: see header — bcm2835 codec is multiplanar M2M; raw V4L2 mplane impl is WIP.");
}
