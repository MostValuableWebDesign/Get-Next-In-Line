import { motion } from "framer-motion";

export function Scene3() {
  return (
    <motion.section className="absolute inset-0 z-10 overflow-hidden" initial={{ opacity: 0, scale: .9, rotateX: 10 }} animate={{ opacity: 1, scale: 1, rotateX: 0 }} exit={{ opacity: 0, scale: 1.08, rotateX: -8 }} transition={{ duration: .9, ease: [0.16, 1, 0.3, 1] }}>
      <div className="absolute left-[9vw] top-[17vh]">
        <motion.div className="mono mb-[1.2vw] text-[.68vw] font-bold uppercase text-[#ef6b59]" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .2 }}>02 / Make arrival feel easy</motion.div>
        <motion.h2 className="display text-[5.5vw] font-semibold leading-[.9] tracking-[-.08em] text-[#17233f]" initial={{ opacity: 0, y: 38 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .3, duration: .75 }}>Ready.<br /><span className="text-[#ef6b59]">Paid.</span><br />On time.</motion.h2>
        <motion.p className="mt-[1.5vw] w-[27vw] text-[1.05vw] leading-[1.38] text-[#17233f]/65" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .88, duration: .6 }}>Deposits, reminders, and a clean handoff — so nobody has to wonder what happens next.</motion.p>
      </div>

      <motion.div className="absolute right-[10vw] top-[16vh] w-[30vw] [perspective:1000px]" initial={{ opacity: 0, x: 75, rotateY: -18 }} animate={{ opacity: 1, x: 0, rotateY: -4 }} transition={{ delay: .35, duration: .9, ease: [0.16, 1, 0.3, 1] }}>
        <div className="overflow-hidden rounded-[1.25vw] bg-[#17233f] p-[1.2vw] shadow-[1vw_1vw_0_rgba(23,35,63,.14)]">
          <div className="rounded-[.75vw] bg-[#fffaf1] p-[1.4vw]">
            <div className="flex items-center justify-between"><span className="mono text-[.56vw] font-bold uppercase text-[#17233f]/40">ARRIVAL RECEIPT</span><span className="mono text-[.56vw] font-bold text-[#ef6b59]">#GN-1842</span></div>
            <div className="mt-[1.5vw] display text-[2vw] font-semibold tracking-[-.06em]">Morrow Studio</div>
            <div className="mt-[1vw] grid grid-cols-2 gap-[.7vw]">
              <div className="rounded-[.55vw] bg-[#b9ddcb]/50 p-[.8vw]"><div className="mono text-[.5vw] uppercase text-[#17233f]/45">SERVICE</div><div className="mt-[.4vw] text-[.78vw] font-semibold">Shape + Shine</div></div>
              <div className="rounded-[.55vw] bg-[#f5c75a]/50 p-[.8vw]"><div className="mono text-[.5vw] uppercase text-[#17233f]/45">DEPOSIT</div><div className="mt-[.4vw] text-[.78vw] font-semibold">$24.00 paid</div></div>
            </div>
            <div className="mt-[1.2vw] flex items-center gap-[.7vw] border-t border-[#17233f]/10 pt-[1vw]"><span className="flex h-[1.6vw] w-[1.6vw] items-center justify-center rounded-full bg-[#ef6b59] text-[.7vw] text-[#f7f1e7]">✓</span><span className="text-[.7vw] text-[#17233f]/65">You’re on the list. We’ll text when it’s time.</span></div>
          </div>
        </div>
        <motion.div className="absolute -bottom-[3vw] -left-[4vw] rounded-[.8vw] bg-[#ef6b59] px-[1.1vw] py-[.85vw] text-[#f7f1e7] shadow-[.4vw_.4vw_0_rgba(23,35,63,.12)]" animate={{ y: [0, -7, 0], rotate: [-4, -1, -4] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}><div className="mono text-[.5vw] font-bold uppercase opacity-70">TEXT ALERT</div><div className="mt-[.2vw] text-[.75vw] font-semibold">You’re next in line.</div></motion.div>
      </motion.div>

      <div className="absolute bottom-[5.2vw] left-[9vw] mono text-[.62vw] font-bold uppercase text-[#17233f]/45">03 / 05 — fewer gaps, better visits</div>
    </motion.section>
  );
}