export function KpiBlock({
  label,
  value,
  live,
  valueClass,
}: {
  label: string;
  value: string;
  live?: boolean;
  valueClass?: string;
}) {
  return (
    <div>
      <div className="smallcaps text-[10px] text-ink-3 flex items-center gap-1.5">
        {label}
        {live && <span className="h-1 w-1 rounded-full bg-success dot-live" aria-hidden />}
      </div>
      <div
        className={`font-display text-[32px] tabular leading-none mt-1 tracking-tight ${valueClass ?? 'text-ink-0'}`}
      >
        {value}
      </div>
    </div>
  );
}
