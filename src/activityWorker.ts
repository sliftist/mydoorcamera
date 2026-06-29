// Activity worker thread. The capture daemon's main loop must stay free to shuttle bytes
// between the ffmpeg pipes (feed the encoder, drain its H.264 stdout) at 30 fps — any
// synchronous per-frame work there backpressures the encoder below realtime. So the activity
// detector runs HERE, on its own thread: the main loop posts each small grayscale frame in,
// and gets back {seq, act, ms} without ever blocking. Launched with the same -r typenode
// loader as its parent (execArgv), so it can import the shared detector.

import { parentPort } from "worker_threads";
import { ActivityModel } from "./activityDetect";

const model = new ActivityModel();

parentPort!.on("message", (m: { seq: number; gray: Uint8Array }) => {
    const t0 = performance.now();
    const gray = Buffer.from(m.gray.buffer, m.gray.byteOffset, m.gray.byteLength);
    const act = model.compute(gray);
    parentPort!.postMessage({ seq: m.seq, act, ms: performance.now() - t0 });
});
