/** The list before its first rows arrive, shaped like phone rows so nothing jumps when they do. */
export function RowSkeleton() {
  const bar = 'rounded bg-hover';
  return (
    <div data-testid="list-skeleton" role="status" aria-busy="true" aria-label="Loading" className="min-h-0 flex-1 overflow-hidden">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} aria-hidden className="flex h-[72px] flex-col justify-center gap-2 border-b border-line pl-4 pr-4">
          <span className={`${bar} h-3 w-32`} />
          <span className={`${bar} h-3`} style={{ width: `${55 + ((i * 17) % 35)}%` }} />
          <span className={`${bar} h-2.5`} style={{ width: `${40 + ((i * 23) % 40)}%` }} />
        </div>
      ))}
    </div>
  );
}
