import { motion } from "framer-motion";

export function Scene4() {
  const base = import.meta.env.BASE_URL;
  return (
    <motion.section className="absolute inset-0 z-10 overflow-hidden" initial={{ opacity: 0, clipPath: "circle(0% at 18% 80%)" }} animate={{ opacity: 1, clipPath: "circle(150% at 18% 80%)" }} exit={{ opacity: 0, clipPath: "circle(0% at 82% 20%)" }} transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}>
      <motion.img src={`${base}neighborhood-cutout.png`} alt="" className="absolute bottom-0 left-0 h-[44vh] w-full object-cover object-bottom opacity-35 mix-blend-multiply" initial={{ y: 40, scale: 1.05 }} animate={{ y: 0, scale: 1 }} transition={{ duration: 1.2 }} />
      <div className="absolute left-[9vw] top-[16vh] w-[41vw]">
        <motion.div className="mono mb-[1.2vw] text-[.68vw] font-bold uppercase text-[#ef6b59]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .2 }}>03 / Turn visits into belonging</motion.div>
        <motion.h2 className="display text-[5vw] font-semibold leading-[.9] tracking-[-.08em] text-[#17233f]" initial={{ opacity: 0, x: -35 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: .35, duration: .75 }}>The wallet<br />for <span className="text-[#ef6b59]">local.</span></motion.h2>
        <motion.p className="mt-[1.7vw] w-[28vw] text-[1.05vw] leading-[1.38] text-[#17233f]/65" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .95, duration: .6 }}>Local Perks turns one good stop into a neighborhood passport — shared by the places you already love.</motion.p>
      </div>
      <motion.div className="absolute right-[11vw] top-[13vh] h-[28vw] w-[20vw] rotate-[7deg]" initial={{ opacity: 0, x: 80, rotate: 18 }} animate={{ opacity: 1, x: 0, rotate: 7 }} transition={{ delay: .25, duration: 1, type: "spring", stiffness: 100, damping: 18 }}>
        <div className="h-full rounded-[1.3vw] bg-[#17233f] p-[.9vw] shadow-[1vw_1vw_0_rgba(23,35,63,.15)]">
          <div className="relative h-full overflow-hidden rounded-[.75vw] bg-[#f7f1e7] p-[1.2vw]">
            <div className="absolute -right-[4vw] -top-[4vw] h-[12vw] w-[12vw] rounded-full bg-[#f5c75a]" />
            <div className="relative flex items-center justify-between"><span className="display text-[.95vw] font-semibold">Local Perks</span><span className="mono text-[.47vw] font-bold uppercase text-[#17233f]/45">WALLET</span></div>
            <div className="relative mt-[3.2vw]"><div className="mono text-[.48vw] font-bold uppercase text-[#17233f]/45">NEIGHBORHOOD PASSPORT</div><div className="mt-[.55vw] display text-[2.4vw] font-semibold leading-none tracking-[-.08em]">03 <span className="text-[1vw] font-normal tracking-normal">stops</span></div></div>
            <div className="relative mt-[2.3vw] flex items-center justify-center"><motion.img src={`${base}passport-stamp.png`} alt="" className="h-[8vw] w-[8vw] object-contain" animate={{ rotate: [7, -3, 7], scale: [1, 1.04, 1] }} transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }} /></div>
            <div className="absolute bottom-[1.1vw] left-[1.2vw] right-[1.2vw] flex items-end justify-between border-t border-[#17233f]/10 pt-[.7vw]"><span className="text-[.57vw] text-[#17233f]/55">Morrow · Hazel · Vale</span><span className="mono text-[.5vw] font-bold text-[#ef6b59]">+ 1 perk</span></div>
          </div>
        </div>
      </motion.div>
      <motion.div className="absolute bottom-[15vw] right-[36vw] rounded-full bg-[#b9ddcb] px-[1vw] py-[.55vw] mono text-[.54vw] font-bold uppercase text-[#17233f]" animate={{ y: [0, -10, 0], rotate: [3, -4, 3] }} transition={{ duration: 3, repeat: Infinity }}>share the good stuff</motion.div>
      <div className="absolute bottom-[5.2vw] left-[9vw] mono text-[.62vw] font-bold uppercase text-[#17233f]/45">04 / 05 — the neighborhood is the product</div>
    </motion.section>
  );
}