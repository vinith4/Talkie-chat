import "./ticks.css";

export type TickState = "sent" | "delivered" | "read";

/** One grey tick = sent, two grey = delivered, two blue = read. */
export function Ticks({ state }: { state: TickState }) {
  const label = state === "read" ? "Read" : state === "delivered" ? "Delivered" : "Sent";
  return (
    <span className={`ticks ${state}`} role="img" aria-label={label} title={label}>
      <svg viewBox="0 0 20 12" width="18" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {state === "sent" ? (
          <path d="M4 6.2l3.2 3.2L14.5 2.2" />
        ) : (
          <>
            <path d="M1.5 6.2l3.2 3.2L12 2.2" />
            <path d="M7.2 8.9l.5.5L17 2.2" />
          </>
        )}
      </svg>
    </span>
  );
}
