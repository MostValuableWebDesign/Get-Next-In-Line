import { motion } from "framer-motion";

export function Scene1() {
  return (
    <motion.section className="absolute inset-0 z-10 overflow-hidden" initial={{ opacity: 0, clipPath: "circle(0% at 80% 20%)" }} animate={{ opacity: 1, clipPath: "circle(150% at 80% 20%)" }} exit={{ opacity: 0, clipPath: "circle(0% at 20% 80%)" }} transition={{ duration: .9, ease: [0.16, 1, 0.3, 1] }}>
      <div className="absolute left-[8vw] top-[19vh] w-[45vw]">
        <motion.div className="mono mb-[1.4vw] flex items-center gap-[.7vw] text-[.7vw] font-bold uppercase text-[#ef6b59]" initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .2, duration: .55 }}>
          <span className="h-[.55vw] w-[.55vw] rounded-full bg-[#ef6b59]" /> A better kind of busy
        </motion.div>
        <motion.h1 className="display m-0 text-[8.1vw] font-semibold leading-[.84] tracking-[-.095em] text-[#17233f]" initial={{ opacity: 0, y: 55, rotate: 2 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ delay: .35, duration: .9, ease: [0.16, 1, 0.3, 1] }}>
          Skip<br /><span className="text-[#ef6b59]">the wait.</span>
        </motion.h1>
        <motion.p className="mt-[2vw] max-w-[31vw] text-[1.18vw] leading-[1.35] text-[#17233f]/70" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .95, duration: .65 }}>
          GNIL helps local businesses turn every “not today” into a next visit.
        </motion.p>
      </div>

      <motion.div className="absolute right-[9vw] top-[22vh] w-[28vw] rotate-[5deg]" initial={{ opacity: 0, x: 80, scale: .84 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ delay: .55, duration: 1, type: "spring", stiffness: 120, damping: 18 }}>
        <div className="rounded-[1.5vw] bg-[#17233f] p-[1.1vw] shadow-[1.1vw_1.1vw_0_rgba(23,35,63,.14)]">
          <div className="rounded-[.8vw] bg-[#f7f1e7] p-[1.5vw]">
            <div className="mb-[2vw] flex items-center justify-between">
              <span className="mono text-[.58vw] font-bold uppercase text-[#17233f]/45">PUBLIC BOOKING</span>
              <span className="h-[.55vw] w-[.55vw] rounded-full bg-[#b9ddcb]" />
            </div>
            <div className="display text-[2.4vw] font-semibold tracking-[-.06em] text-[#17233f]">Morrow Studio</div>
            <div className="mt-[.6vw] text-[.82vw] text-[#17233f]/55">Choose a time that works.</div>
            <div className="mt-[1.5vw] flex gap-[.6vw]">
              {["9:30", "11:15", "1:45"].map((time, i) => <motion.div key={time} className={`rounded-[.5vw] px-[.9vw] py-[.7vw] text-[.72vw] font-semibold ${i === 1 ? "bg-[#ef6b59] text-[#f7f1e7]" : "bg-[#b9ddcb]/45 text-[#17233f]"}`} animate={{ y: [0, -3, 0] }} transition={{ delay: 1.1 + i * .12, duration: 2.5, repeat: Infinity }}>{time}</motion.div>)}
            </div>
          </div>
        </div>
        <motion.div className="absolute -right-[3.8vw] -top-[2vw] rounded-full bg-[#f5c75a] px-[1vw] py-[.7vw] mono text-[.58vw] font-bold uppercase text-[#17233f]" animate={{ rotate: [5, -2, 5], y: [0, -6, 0] }} transition={{ duration: 3, repeat: Infinity }}>no phone tag</motion.div>
      </motion.div>

      <div className="absolute bottom-[5.2vw] left-[8vw] flex items-center gap-[1.2vw] mono text-[.62vw] font-bold uppercase text-[#17233f]/45">
        <span>BOOK / QUEUE / BELONG</span><span className="h-px w-[7vw] bg-[#17233f]/20" /><span>01</span>
      </div>
    </motion.section>
  );
}