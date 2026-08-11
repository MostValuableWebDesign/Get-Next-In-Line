import { motion } from "framer-motion";

export function Scene5() {
  return (
    <motion.section className="absolute inset-0 z-10 overflow-hidden" initial={{ opacity: 0, scale: .7, rotate: -2 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: 1.4, rotate: 3 }} transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}>
      <motion.div className="absolute left-1/2 top-[48%] h-[34vw] w-[34vw] -translate-x-1/2 -translate-y-1/2 rounded-full border-[.1vw] border-[#17233f]/20" animate={{ scale: [1, 1.08, 1], rotate: [0, 12, 0] }} transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }} />
      <motion.div className="absolute left-1/2 top-[48%] h-[24vw] w-[24vw] -translate-x-1/2 -translate-y-1/2 rounded-full border-[.1vw] border-[#ef6b59]/35" animate={{ scale: [1.05, .93, 1.05], rotate: [20, -5, 20] }} transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }} />
      <div className="absolute inset-x-0 top-[18vh] text-center">
        <motion.div className="mono mb-[1.2vw] text-[.68vw] font-bold uppercase text-[#ef6b59]" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .2, duration: .5 }}>One simple promise</motion.div>
        <motion.h2 className="display text-[7.2vw] font-semibold leading-[.86] tracking-[-.095em] text-[#17233f]" initial={{ opacity: 0, y: 45, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ delay: .35, duration: .9, ease: [0.16, 1, 0.3, 1] }}>Keep the<br /><span className="text-[#ef6b59]">good line</span> moving.</motion.h2>
        <motion.p className="mx-auto mt-[1.6vw] max-w-[32vw] text-[1.05vw] leading-[1.38] text-[#17233f]/65" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.05, duration: .7 }}>Bookings, queues, payments, and perks — in one neighborhood-first operating system.</motion.p>
      </div>
      <motion.div className="absolute bottom-[11vh] left-1/2 flex -translate-x-1/2 items-center gap-[.8vw]" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.3, duration: .6 }}>
        <span className="flex h-[2.7vw] w-[2.7vw] items-center justify-center rounded-[.55vw] bg-[#17233f] text-[1.4vw] font-bold text-[#f7f1e7] display">G</span>
        <span className="display text-[1.65vw] font-semibold tracking-[-.05em] text-[#17233f]">get next in line</span>
      </motion.div>
      <motion.div className="absolute bottom-[5.2vw] left-1/2 -translate-x-1/2 mono text-[.62vw] font-bold uppercase text-[#17233f]/45" animate={{ opacity: [.5, 1, .5] }} transition={{ duration: 3, repeat: Infinity }}>05 / 05 — built for the places that make a place</motion.div>
    </motion.section>
  );
}