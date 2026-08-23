/**
 * Deck illustrations.
 *
 * Hand-authored inline SVG — no libraries, no images, no runtime. Each figure
 * shows a mechanism rather than decorating a heading, and carries a real
 * aria-label so it is not a hole in the page for a screen reader.
 *
 * Conventions:
 *  - structural strokes use `currentColor`, inherited from the wrapper's text
 *    colour, so the whole figure re-tones by changing one class;
 *  - EMERALD marks the one element that carries the claim;
 *  - AMBER marks the honest-gap cases (unknown, inferred);
 *  - labels are 14–15 user units so they stay legible when the figure is
 *    scaled down to a phone.
 */

const EMERALD = "#34d399";
const AMBER = "#fbbf24";

type FigureProps = { caption: string; className?: string };

function Arrowhead({ id, color = "currentColor" }: { id: string; color?: string }) {
  return (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX="9"
      refY="5"
      markerWidth="5"
      markerHeight="5"
      orient="auto-start-reverse"
    >
      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
    </marker>
  );
}

function Figure({
  caption,
  label,
  viewBox,
  maxWidth,
  className,
  children,
}: FigureProps & {
  label: string;
  viewBox: string;
  maxWidth: string;
  children: React.ReactNode;
}) {
  return (
    <figure className={className}>
      <svg
        role="img"
        aria-label={label}
        viewBox={viewBox}
        className="h-auto w-full text-zinc-600"
        style={{ maxWidth }}
        fill="none"
      >
        {children}
      </svg>
      <figcaption className="mt-3 text-[0.75rem] leading-relaxed text-zinc-500 sm:text-[0.8rem]">
        {caption}
      </figcaption>
    </figure>
  );
}

/* ────────────────────────────────────────────────────── 1. Two journeys */

export function TwoJourneys({ caption, className }: FigureProps) {
  return (
    <Figure
      className={className}
      caption={caption}
      label="One starting point forking into two questions: which vehicle should I buy, and will the one I own run on E20."
      viewBox="0 0 460 132"
      maxWidth="540px"
    >
      <defs>
        <Arrowhead id="aj" color={EMERALD} />
      </defs>

      <circle cx="12" cy="66" r="5" fill={EMERALD} />
      <path d="M17 66 H62" stroke={EMERALD} strokeWidth="1.5" />
      <path
        d="M62 66 C92 66 92 26 122 26"
        stroke={EMERALD}
        strokeWidth="1.5"
        markerEnd="url(#aj)"
      />
      <path
        d="M62 66 C92 66 92 106 122 106"
        stroke={EMERALD}
        strokeWidth="1.5"
        markerEnd="url(#aj)"
      />

      <rect x="132" y="8" width="322" height="36" rx="9" stroke="currentColor" />
      <text x="150" y="31" fontSize="15" fill="#e4e4e7">
        Which vehicle should I buy?
      </text>

      <rect x="132" y="88" width="322" height="36" rx="9" stroke="currentColor" />
      <text x="150" y="111" fontSize="15" fill="#e4e4e7">
        Will the one I own run on E20?
      </text>
    </Figure>
  );
}

/* ──────────────────────────────────────────────────── 2. Five powertrains */

export function FivePowertrains({ caption, className }: FigureProps) {
  const rays: [number, string][] = [
    [18, "Petrol"],
    [62, "Diesel"],
    [106, "CNG"],
    [150, "Electric"],
    [194, "Hybrid"],
  ];

  return (
    <Figure
      className={className}
      caption={caption}
      label="One buyer at the left, five powertrain options fanning out to the right, all passing through a dashed line marked unknowns."
      viewBox="0 0 460 224"
      maxWidth="520px"
    >
      <circle cx="14" cy="106" r="6" fill={EMERALD} />
      <text x="4" y="130" fontSize="13" fill="#a1a1aa">
        You
      </text>

      {rays.map(([y, label]) => (
        <g key={label}>
          <path
            d={`M22 106 L296 ${y}`}
            stroke="currentColor"
            strokeWidth="1.25"
          />
          <circle cx="296" cy={y} r="3.5" fill="currentColor" />
          <text x="310" y={y + 5} fontSize="15" fill="#d4d4d8">
            {label}
          </text>
        </g>
      ))}

      <path
        d="M186 8 V204"
        stroke={AMBER}
        strokeWidth="1.5"
        strokeDasharray="5 5"
        opacity="0.85"
      />
      <text x="186" y="220" fontSize="13" fill={AMBER} textAnchor="middle">
        unknowns
      </text>
    </Figure>
  );
}

/* ─────────────────────────────────────────────────────── 3. Advisor flow */

export function AdvisorFlow({ caption, className }: FigureProps) {
  const inputs = ["distance", "budget", "state", "payload"];

  return (
    <Figure
      className={className}
      caption={caption}
      label="Four inputs are collected into one profile, which feeds a deterministic engine; the engine emits a ranked shortlist of three vehicles."
      viewBox="0 0 470 196"
      maxWidth="560px"
    >
      <defs>
        <Arrowhead id="af" color={EMERALD} />
      </defs>

      {inputs.map((t, i) => {
        const cy = 30 + i * 46;
        return (
          <g key={t}>
            <rect x="2" y={cy - 16} width="104" height="32" rx="7" stroke="currentColor" />
            <text x="54" y={cy + 5} fontSize="14" fill="#d4d4d8" textAnchor="middle">
              {t}
            </text>
            <path d={`M106 ${cy} H126`} stroke="currentColor" strokeWidth="1.25" />
          </g>
        );
      })}
      <path d="M126 30 V168" stroke={EMERALD} strokeWidth="1.5" />

      <path d="M126 99 H164" stroke={EMERALD} strokeWidth="1.5" markerEnd="url(#af)" />
      <text x="145" y="90" fontSize="11.5" fill={EMERALD} textAnchor="middle">
        profile
      </text>

      <rect x="166" y="40" width="128" height="118" rx="10" stroke={EMERALD} strokeWidth="1.5" />
      <text x="230" y="88" fontSize="15" fill="#e4e4e7" textAnchor="middle">
        engine
      </text>
      <text x="230" y="110" fontSize="12.5" fill="#a1a1aa" textAnchor="middle">
        TCO · ₹/km
      </text>
      <text x="230" y="128" fontSize="12.5" fill="#a1a1aa" textAnchor="middle">
        break-even · CO₂
      </text>

      <path d="M294 99 H336" stroke={EMERALD} strokeWidth="1.5" markerEnd="url(#af)" />
      <text x="315" y="90" fontSize="11.5" fill={EMERALD} textAnchor="middle">
        ranked
      </text>

      {[0, 1, 2].map((i) => (
        <g key={i}>
          <rect
            x="342"
            y={43 + i * 40}
            width="124"
            height="32"
            rx="7"
            stroke={i === 0 ? EMERALD : "currentColor"}
            strokeWidth={i === 0 ? 1.5 : 1}
          />
          <text x="358" y={63 + i * 40} fontSize="14" fill={i === 0 ? EMERALD : "#a1a1aa"}>
            {i + 1}
          </text>
          <rect
            x="374"
            y={55 + i * 40}
            width={80 - i * 22}
            height="8"
            rx="4"
            fill={i === 0 ? EMERALD : "currentColor"}
            opacity={i === 0 ? 0.9 : 0.45}
          />
        </g>
      ))}
    </Figure>
  );
}

/* ────────────────────────────────────────────────────────── 4. E20 verdict */

export function E20Verdict({ caption, className }: FigureProps) {
  const verdicts = ["compliant", "tolerant", "E10-only", "n/a", "unknown"];

  return (
    <Figure
      className={className}
      caption={caption}
      label="A row of five possible E20 verdicts with one selected, above a bracketed range showing that the efficiency delta is reported with both bounds rather than as a single point."
      viewBox="0 0 460 196"
      maxWidth="540px"
    >
      <defs>
        <Arrowhead id="ev" color={EMERALD} />
      </defs>

      {verdicts.map((v, i) => {
        const x = 2 + i * 92;
        const on = i === 0;
        const gap = v === "unknown";
        return (
          <g key={v}>
            <rect
              x={x}
              y="26"
              width="86"
              height="34"
              rx="17"
              stroke={on ? EMERALD : gap ? AMBER : "currentColor"}
              strokeWidth={on ? 1.75 : 1}
              strokeDasharray={gap ? "4 4" : undefined}
              fill={on ? EMERALD : "none"}
              fillOpacity={on ? 0.14 : 0}
            />
            <text
              x={x + 43}
              y="48"
              fontSize="13"
              textAnchor="middle"
              fill={on ? EMERALD : gap ? AMBER : "#a1a1aa"}
            >
              {v}
            </text>
          </g>
        );
      })}
      <path d="M45 4 V18" stroke={EMERALD} strokeWidth="1.5" markerEnd="url(#ev)" />

      <text x="0" y="108" fontSize="13" fill="#a1a1aa">
        efficiency delta
      </text>

      <path d="M92 138 H392" stroke="currentColor" />
      <path d="M148 122 V154" stroke={EMERALD} strokeWidth="2" />
      <path d="M284 122 V154" stroke={EMERALD} strokeWidth="2" />
      <path d="M148 138 H284" stroke={EMERALD} strokeWidth="4" strokeLinecap="round" />
      <text x="216" y="176" fontSize="13.5" fill={EMERALD} textAnchor="middle">
        a range, both bounds
      </text>

      <circle cx="352" cy="138" r="5" stroke={AMBER} strokeWidth="1.5" />
      <path d="M345 131 L359 145 M359 131 L345 145" stroke={AMBER} strokeWidth="1.5" />
      <text x="352" y="176" fontSize="13.5" fill={AMBER} textAnchor="middle">
        never a point
      </text>
    </Figure>
  );
}

/* ─────────────────────────────────────────────────────── 5. The boundary */

export function EngineBoundary({ caption, className }: FigureProps) {
  const steps: [string, number, number][] = [
    ["Profile", 0, 92],
    ["Filter", 104, 92],
    ["Economics", 208, 112],
    ["Rank", 332, 92],
  ];

  return (
    <Figure
      className={className}
      caption={caption}
      label="Four deterministic stages — profile, filter, economics and rank — computed in TypeScript and SQL, separated by a dashed boundary from a narrate stage that only produces language; a number in the narration that is not in the payload is rejected."
      viewBox="0 0 600 182"
      maxWidth="620px"
    >
      <defs>
        <Arrowhead id="eb" color={EMERALD} />
        <Arrowhead id="ebw" color={AMBER} />
      </defs>

      {steps.map(([label, x, w], i) => (
        <g key={label}>
          <rect x={x} y="26" width={w} height="48" rx="9" stroke="currentColor" />
          <text x={x + w / 2} y="55" fontSize="14" fill="#d4d4d8" textAnchor="middle">
            {label}
          </text>
          {i < steps.length - 1 && (
            <path
              d={`M${x + w} 50 H${steps[i + 1][1] - 2}`}
              stroke={EMERALD}
              strokeWidth="1.5"
              markerEnd="url(#eb)"
            />
          )}
        </g>
      ))}

      {/* deterministic span */}
      <path d="M0 88 V100 H424 V88" stroke="currentColor" opacity="0.5" />
      <text x="212" y="118" fontSize="13" fill="#a1a1aa" textAnchor="middle">
        TypeScript + SQL. No model.
      </text>

      {/* the boundary itself */}
      <path d="M450 18 V122" stroke={AMBER} strokeDasharray="5 5" strokeWidth="1.5" />
      <path d="M424 50 H474" stroke={EMERALD} strokeWidth="1.5" markerEnd="url(#eb)" />
      <text x="450" y="12" fontSize="11.5" fill={EMERALD} textAnchor="middle">
        payload
      </text>

      <rect x="476" y="26" width="124" height="48" rx="9" stroke={EMERALD} strokeWidth="1.5" />
      <text x="538" y="48" fontSize="14" fill={EMERALD} textAnchor="middle">
        Narrate
      </text>
      <text x="538" y="65" fontSize="11.5" fill="#a1a1aa" textAnchor="middle">
        language only
      </text>

      {/* the guard */}
      <path d="M538 74 V126" stroke={AMBER} strokeWidth="1.5" strokeDasharray="4 4" markerEnd="url(#ebw)" />
      <rect
        x="292"
        y="130"
        width="308"
        height="36"
        rx="9"
        stroke={AMBER}
        strokeDasharray="4 4"
      />
      <text x="446" y="153" fontSize="12.5" fill={AMBER} textAnchor="middle">
        a number not in the payload → rejected
      </text>
    </Figure>
  );
}

/* ───────────────────────────────────────────────────────── 6. Provenance */

export function Provenance({ caption, className }: FigureProps) {
  const threads = [
    ["its source", 22],
    ["its assumptions", 82],
    ["the date it was true", 142],
  ] as const;

  return (
    <Figure
      className={className}
      caption={caption}
      label="Every figure shown to a user carries three threads: its source, its assumptions, and the date it was true."
      viewBox="0 0 460 180"
      maxWidth="530px"
    >
      <defs>
        <Arrowhead id="pv" color={EMERALD} />
      </defs>

      <rect x="2" y="62" width="140" height="52" rx="10" stroke={EMERALD} strokeWidth="1.5" />
      <text x="72" y="93" fontSize="15" fill={EMERALD} textAnchor="middle">
        every figure
      </text>

      {threads.map(([label, y]) => (
        <g key={label}>
          <path
            d={`M146 88 C196 88 196 ${y + 18} 236 ${y + 18}`}
            stroke={EMERALD}
            strokeWidth="1.25"
            markerEnd="url(#pv)"
          />
          <rect x="246" y={y} width="212" height="36" rx="9" stroke="currentColor" />
          <text x="264" y={y + 23} fontSize="14.5" fill="#d4d4d8">
            {label}
          </text>
        </g>
      ))}
    </Figure>
  );
}

/* ──────────────────────────────────────────────────────── 7. Persona icons */

const iconClass = "size-6 shrink-0 text-emerald-400";

export function IconFirstCar() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} fill="none" aria-hidden="true">
      <path
        d="M3 14l1.6-4.6A2 2 0 0 1 6.5 8h11a2 2 0 0 1 1.9 1.4L21 14v4h-2.5M3 18v-4m0 4h2.5m13 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm-10 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M4 14h16" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconUpgrade() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} fill="none" aria-hidden="true">
      <path
        d="M4 8h13l-3-3m3 3-3 3M20 16H7l3-3m-3 3 3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconFleet() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} fill="none" aria-hidden="true">
      <path
        d="M2 7h11v9H2zM13 10h4l3 3v3h-7z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="17" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function IconPump() {
  return (
    <svg viewBox="0 0 24 24" className={iconClass} fill="none" aria-hidden="true">
      <path
        d="M4 20V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14M3 20h11M6 9h5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M16 8l3 2.5V17a1.5 1.5 0 0 1-3 0v-3h-3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
