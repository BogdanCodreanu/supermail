import type { LucideIcon } from 'lucide-react';

/** One full-width row of a phone sheet. */
export function ActionRow({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick(): void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-12 w-full cursor-pointer items-center gap-3 px-4 text-left text-base active:bg-hover">
      <Icon size={20} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
