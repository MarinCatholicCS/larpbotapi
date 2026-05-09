"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Boxes } from "@/components/ui/background-boxes";
import { cn } from "@/lib/utils";

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.02 1.75 2.69 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.27-5.24-5.66 0-1.25.45-2.27 1.18-3.07-.12-.29-.51-1.46.11-3.04 0 0 .96-.31 3.16 1.18a10.97 10.97 0 0 1 5.76 0c2.2-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.75.12 3.04.74.8 1.18 1.82 1.18 3.07 0 4.4-2.69 5.36-5.26 5.65.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.55C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z"/>
    </svg>
  );
}

const MORPH_DURATION = 1.0;

function MorphBlock({
  nodeA,
  nodeB,
  spacer,
  active,
  className,
  gooey = true,
}: {
  nodeA: React.ReactNode;
  nodeB: React.ReactNode;
  spacer: React.ReactNode;
  active: boolean;
  className?: string;
  gooey?: boolean;
}) {
  const refA = useRef<HTMLDivElement>(null);
  const refB = useRef<HTMLDivElement>(null);
  const morphRef = useRef(0);
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    let raf: number;
    let lastTime = performance.now();

    function tick(now: number) {
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      const target = activeRef.current ? 1 : 0;
      const dir = target > morphRef.current ? 1 : -1;
      morphRef.current = Math.max(
        0,
        Math.min(1, morphRef.current + (dt / MORPH_DURATION) * dir)
      );
      const f = morphRef.current;

      if (refA.current && refB.current) {
        if (f <= 0.001) {
          refA.current.style.filter = "";
          refA.current.style.opacity = "1";
          refA.current.style.pointerEvents = "";
          refB.current.style.filter = "blur(40px)";
          refB.current.style.opacity = "0";
          refB.current.style.pointerEvents = "none";
        } else if (f >= 0.999) {
          refB.current.style.filter = "";
          refB.current.style.opacity = "1";
          refB.current.style.pointerEvents = "";
          refA.current.style.filter = "blur(40px)";
          refA.current.style.opacity = "0";
          refA.current.style.pointerEvents = "none";
        } else {
          refA.current.style.pointerEvents = "none";
          refB.current.style.pointerEvents = "none";
          refB.current.style.filter = `blur(${Math.min(8 / f - 8, 100)}px)`;
          refB.current.style.opacity = String(Math.pow(f, 0.4));
          const inv = 1 - f;
          refA.current.style.filter = `blur(${Math.min(8 / inv - 8, 100)}px)`;
          refA.current.style.opacity = String(Math.pow(inv, 0.4));
        }
      }

      raf = requestAnimationFrame(tick);
    }

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      className={cn("relative", className)}
      style={gooey ? { filter: "url(#gooey-threshold)" } : undefined}
    >
      <div className="invisible pointer-events-none">{spacer}</div>
      <div
        ref={refA}
        className="absolute inset-0 flex items-center justify-center"
      >
        {nodeA}
      </div>
      <div
        ref={refB}
        className="absolute inset-0 flex items-center justify-center"
        style={{ filter: "blur(40px)", opacity: "0", pointerEvents: "none" }}
      >
        {nodeB}
      </div>
    </div>
  );
}

export default function Landing() {
  const [howItWorks, setHowItWorks] = useState(false);

  const headingA = (
    <h1
      className="text-5xl md:text-6xl font-black tracking-tight text-white leading-[1.08] text-center"
      style={{ fontFamily: "var(--font-orbitron)" }}
    >
      Stop hiring{" "}
      <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-violet-400">
        LARP
      </span>
      <span className="text-white">ers</span>
    </h1>
  );

  const headingB = (
    <h1
      className="text-5xl md:text-6xl font-black tracking-tight text-white leading-[1.08] text-center"
      style={{ fontFamily: "var(--font-orbitron)" }}
    >
      How it works
    </h1>
  );

  const paraA = (
    <div className="flex flex-col items-center gap-3 w-full max-w-3xl">
      <Link
        href="/dashboard"
        className="w-full flex rounded-lg overflow-hidden border border-slate-700 bg-slate-800/60 hover:border-sky-500 transition-colors"
      >
        <div
          className="flex-1 px-6 py-5 text-base text-slate-400 text-left"
          style={{ fontFamily: "var(--font-inconsolata)" }}
        >
          tungtungrecruiting@gmail.com
        </div>
        <div className="px-6 py-5 bg-sky-500 group-hover:bg-sky-400 text-white text-base font-semibold whitespace-nowrap">
          Open dashboard
        </div>
      </Link>
    </div>
  );

  const paraB = (
    <p className="text-slate-300 text-lg leading-relaxed text-center max-w-xl">
      When a candidate emails the recruiting inbox, Tensorlake activates LARPbot
      — an agent that starts investigating before you ever open their résumé.
      It indexes their GitHub with Nia, cross-references every skill and
      project they&apos;ve claimed, then surfaces a LARP score and a detailed
      evidence report you can act on.
      <span
        className="block mt-4 text-slate-500 italic text-base"
        style={{ fontFamily: "var(--font-edu-cursive)" }}
      >
        The antidote to inflated profiles and AI-generated résumés.
      </span>
    </p>
  );

  return (
    <div
      className="h-screen overflow-hidden bg-slate-900 text-white flex flex-col"
      style={{ fontFamily: "var(--font-rationale)" }}
    >
      <svg className="absolute w-0 h-0" aria-hidden="true">
        <defs>
          <filter id="gooey-threshold">
            <feColorMatrix
              in="SourceGraphic"
              type="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 255 -140"
            />
          </filter>
        </defs>
      </svg>

      <nav className="relative z-30 flex items-center justify-between px-8 py-5 border-b border-slate-800/60 flex-shrink-0">
        <span
          className="text-lg font-bold tracking-tight"
          style={{ fontFamily: "var(--font-orbitron)" }}
        >
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-violet-400">
            LARP
          </span>
          <span className="text-white">bot</span>
        </span>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setHowItWorks((v) => !v)}
            className="text-sm text-slate-400 hover:text-white transition-colors"
          >
            How it works
          </button>
          <Link
            href="/dashboard"
            className="text-sm bg-white text-slate-900 font-semibold px-4 py-1.5 rounded-md hover:bg-slate-100 transition-colors"
          >
            Open dashboard
          </Link>
        </div>
      </nav>

      <section className="relative flex-1 overflow-hidden flex flex-col items-center justify-center">
        <div className="absolute inset-0 w-full h-full bg-slate-900 z-20 [mask-image:radial-gradient(transparent_30%,white_80%)] pointer-events-none" />
        <Boxes />

        <div className="relative z-20 text-center px-4 max-w-2xl mx-auto w-full flex flex-col items-center gap-8">
          <div className="flex flex-col items-center gap-5 w-full">
            <MorphBlock
              nodeA={headingA}
              nodeB={headingB}
              spacer={headingA}
              active={howItWorks}
              className="w-full"
            />
            <MorphBlock
              nodeA={paraA}
              nodeB={paraB}
              spacer={paraB}
              active={howItWorks}
              className="w-full"
              gooey={false}
            />
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/dashboard"
              className="w-full sm:w-auto px-6 py-3 bg-sky-500 hover:bg-sky-400 text-white font-semibold rounded-lg transition-colors text-sm"
            >
              View dashboard
            </Link>
            <a
              href="https://github.com/MarinCatholicCS/larpbotapi"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto px-6 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-semibold rounded-lg transition-colors text-sm flex items-center justify-center gap-2"
            >
              <GithubIcon size={16} />
              View on GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
