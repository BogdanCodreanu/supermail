import { LogIn } from 'lucide-react';

/** Public sign-in page: one Google sign-in button (allowed only for connected accounts, spec §4.1). */
export function Login() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 px-4 md:h-full">
      <span className="text-lg font-semibold">SuperMail</span>
      <a
        href="/auth/login"
        className="inline-flex h-12 w-full max-w-xs cursor-pointer items-center justify-center gap-2 rounded bg-accent px-4 text-base font-medium text-on-accent hover:opacity-90 active:opacity-80 md:h-8 md:w-auto md:max-w-none md:justify-start md:text-sm"
      >
        <LogIn size={16} strokeWidth={1.75} aria-hidden className="h-5 w-5 md:h-4 md:w-4" />
        Sign in with Google
      </a>
      <a href="/privacy" className="inline-flex h-11 cursor-pointer items-center px-2 text-xs text-muted hover:text-fg hover:underline md:h-6 md:px-0">
        Privacy
      </a>
    </div>
  );
}
