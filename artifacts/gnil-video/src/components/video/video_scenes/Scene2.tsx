import { motion } from "framer-motion";

export function Scene2() {
  return (
    <motion.section className="absolute inset-0 z-10 overflow-hidden" initial={{ opacity: 0, clipPath: "polygon(100% 0,100% 0,100% 100%,100% 100%)" }} animate={{ opacity: 1, clipPath: "polygon(0 0,100% 0,100% 100%,0 100%)" }} exit={{ opacity: 0, clipPath: "polygon(0 0,0 0,0 100%,0 100%)" }} transition={{ duration: .85, ease: [0.16, 1, 0.3, 1] }}>
      <div className="absolute left-[9vw] top-[18vh]">
        <motion.div className="mono mb-[1.2vw] text-[.68vw] font-bold uppercase text-[#ef6b59]" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .2 }}>01 / Keep the line moving</motion.div>
        <motion.h2 className="display max-w-[37vw] text-[5.4vw] font-semibold leading-[.93] tracking-[-.08em] text-[#17233f]" initial={{ opacity: 0, x: -40 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .35, duration: .7 }}>A queue that<br /><span className="text-[#ef6b59]">does the talking.</span></motion.h2>
        <motion.p className="mt-[1.7vw] w-[27vw] text-[1.05vw] leading-[1.38] text-[#17233f]/65" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .9, duration: .6 }}>From walk-ins to waitlists, your team sees the whole room. Guests see what matters next.</motion.p>
      </div>

      <motion.div className="absolute right-[9vw] top-[17vh] w-[32vw]" initial={{ opacity: 0, y: 45, scale: .92 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: .35, duration: .8, ease: [0.16, 1, 0.3, 1] }}>
        <div className="rounded-[1.1vw] border border-[#17233f]/15 bg-[#f7f1e7]/70 p-[1.4vw] shadow-[.8vw_.8vw_0_rgba(23,35,63,.08)] backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-[#17233f]/10 pb-[1vw]"><span className="mono text-[.57vw] font-bold uppercase text-[#17233f]/45">LIVE QUEUE / TUESDAY</span><span className="rounded-full bg-[#b9ddcb] px-[.7vw] py-[.35vw] mono text-[.53vw] font-bold uppercase">open</span></div>
          <div className="mt-[1vw] space-y-[.7vw]">
            {[["01", "Maya R.", "In service", "now"], ["02", "Theo J.", "Ready", "2 min"], ["03", "Inez P.", "Waitlist", "12 min"]].map(([n, name, status, eta], i) => (
              <motion.div key={name} className="flex items-center gap-[.8vw] rounded-[.65vw] bg-[#fffaf1]/80 px-[.8vw] py-[.72vw]" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 1 + i * .18, duration: .4 }}>
                <span className="mono w-[1vw] text-[.62vw] text-[#17233f]/35">{n}</span><span className="h-[1.8vw] w-[1.8vw] rounded-full" style={{ background: i === 0 ? "#ef6b59" : i === 1 ? "#f5c75a" : "#9ec9d4" }} />
                <span className="flex-1 text-[.78vw] font-semibold text-[#17233f]">{name}<small className="ml-[.5vw] font-normal text-[#17233f]/40">{status}</small></span><span className="mono text-[.55vw] font-bold text-[#17233f]/60">{eta}</span>
              </motion.div>
            ))}
          </div>
          <motion.div className="mt-[1vw] flex items-center gap-[.6vw] rounded-[.6vw] bg-[#17233f] px-[.8vw] py-[.72vw] text-[#f7f1e7]" animate={{ x: [0, 3, 0] }} transition={{ duration: 3, repeat: Infinity }}><span className="h-[.45vw] w-[.45vw] rounded-full bg-[#b9ddcb] pulse-dot" /><span className="text-[.68vw]">Next up: Theo J.</span><span className="ml-auto mono text-[.56vw] text-[#b9ddcb]">SMS READY</span></motion.div>
        </div>
      </motion.div>
      <motion.div className="absolute right-[4.8vw] bottom-[8vw] h-[8vw] w-[8vw] rounded-full border-[.13vw] border-[#ef6b59]/60" animate={{ scale: [1, 1.13, 1], rotate: [0, 25, 0] }} transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }} />
      <div className="absolute bottom-[5.2vw] left-[9vw] mono text-[.62vw] font-bold uppercase text-[#17233f]/45">02 / 05 — your next guest already knows</div>
    </motion.section>
  );
}