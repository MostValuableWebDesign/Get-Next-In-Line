import { AnimatePresence, motion } from "framer-motion";
import { useVideoPlayer } from "@/lib/video";
import { Scene1 } from "./video_scenes/Scene1";
import { Scene2 } from "./video_scenes/Scene2";
import { Scene3 } from "./video_scenes/Scene3";
import { Scene4 } from "./video_scenes/Scene4";
import { Scene5 } from "./video_scenes/Scene5";

const SCENE_DURATIONS = {
  opening: 5600,
  booking: 6400,
  operations: 6800,
  perks: 7200,
  closing: 6200,
};

const orbitPositions = [
  { left: "72%", top: "20%", scale: 1.65, rotate: 0 },
  { left: "9%", top: "72%", scale: 0.9, rotate: 32 },
  { left: "83%", top: "64%", scale: 1.15, rotate: 78 },
  { left: "18%", top: "17%", scale: 1.3, rotate: 142 },
  { left: "64%", top: "78%", scale: 1.7, rotate: 192 },
];

export default function VideoTemplate() {
  const { currentScene } = useVideoPlayer({ durations: SCENE_DURATIONS });
  const orb = orbitPositions[currentScene];

  return (
    <main className="relative h-screen w-full overflow-hidden" style={{ background: "var(--paper)" }}>
      <div className="absolute inset-0 overflow-hidden" style={{ background: "radial-gradient(circle at 50% 10%, #fff9ed 0%, var(--paper) 55%, #ecdfcf 100%)" }}>
        <motion.div
          className="absolute h-[36vw] w-[36vw] rounded-full opacity-80"
          style={{ left: orb.left, top: orb.top, background: "radial-gradient(circle at 35% 30%, #f7c758, #ef6b59 58%, transparent 70%)", filter: "blur(1px)" }}
          animate={{ left: orb.left, top: orb.top, scale: orb.scale, rotate: orb.rotate }}
          transition={{ duration: 1.15, ease: [0.16, 1, 0.3, 1] }}
        />
        <motion.div
          className="absolute -left-[12vw] -top-[15vw] h-[48vw] w-[48vw] rounded-full opacity-80"
          style={{ background: "radial-gradient(circle at 70% 70%, rgba(185,221,203,.78), rgba(158,201,212,.04) 67%)" }}
          animate={{ x: ["0vw", "7vw", "1vw"], y: ["0vh", "2vh", "-1vh"] }}
          transition={{ duration: 14, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute inset-x-0 top-[16%] h-px"
          style={{ background: "rgba(23,35,63,.14)" }}
          animate={{ scaleX: [0.3, 1, 0.45], opacity: [0.2, .6, .2] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="absolute inset-0 opacity-25" style={{ backgroundImage: "linear-gradient(rgba(23,35,63,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(23,35,63,.08) 1px, transparent 1px)", backgroundSize: "7vw 7vw", maskImage: "linear-gradient(to bottom, black, transparent 75%)" }} />
      </div>

      <motion.div className="absolute left-[5vw] top-[4.2vw] z-30 flex items-center gap-[.8vw]" animate={{ x: [0, 5, 0] }} transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}>
        <span className="flex h-[2.8vw] w-[2.8vw] items-center justify-center rounded-[.55vw] bg-[#17233f] text-[1.45vw] font-bold text-[#f7f1e7] display">G</span>
        <span className="display text-[1.55vw] font-semibold tracking-[-.05em] text-[#17233f]">get next in line</span>
      </motion.div>
      <div className="absolute right-[5vw] top-[4.7vw] z-30 mono text-[.63vw] font-bold uppercase text-[#17233f]/55">the local operating layer / 01—05</div>

      <motion.div className="absolute right-[5vw] top-1/2 z-20 h-[4vw] w-[4vw] rounded-[1vw] border border-[#17233f]/20 bg-[#f7f1e7]/20 backdrop-blur-sm" animate={{ rotate: [0, 90, 180], y: [0, -14, 0] }} transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }} />
      <motion.div className="absolute bottom-[7vw] left-[7vw] z-20 h-[1vw] w-[1vw] rounded-full bg-[#ef6b59]" animate={{ scale: [1, 1.8, 1], opacity: [.5, 1, .5] }} transition={{ duration: 2.2, repeat: Infinity }} />
      <div className="video-grain" />

      <AnimatePresence mode="sync" initial={false}>
        {currentScene === 0 && <Scene1 key="opening" />}
        {currentScene === 1 && <Scene2 key="booking" />}
        {currentScene === 2 && <Scene3 key="operations" />}
        {currentScene === 3 && <Scene4 key="perks" />}
        {currentScene === 4 && <Scene5 key="closing" />}
      </AnimatePresence>
    </main>
  );
}