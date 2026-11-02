import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Composer, type ComposeMode } from '../components/Composer';
import { Layout } from '../components/Layout';
import { whenBackSettled } from '../components/phone/backStack';
import { useIsPhone } from '../lib/useIsPhone';
import { useAccountFilter } from '../state/ui';

export { composeUrl, draftFor, type ComposeMode, type Draft } from '../components/Composer';

function parseMode(raw: string | null, threadId: string | null): ComposeMode {
  if (!threadId) return 'new';
  return raw === 'replyAll' || raw === 'forward' ? raw : 'reply';
}

/**
 * `/compose` (new message) and `/compose?thread=<id>&mode=reply|replyAll|forward`: the composer as a
 * page. Ctrl+Enter sends (with 5 s to undo), Esc closes and keeps the draft. On the phone it fills the screen by itself.
 */
export function Compose() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [accountFilter] = useAccountFilter();
  const phone = useIsPhone();
  const threadId = params.get('thread');
  const mode = parseMode(params.get('mode'), threadId);

  const close = () => {
    const leave = () => {
      if (location.key !== 'default') navigate(-1);
      else navigate('/');
    };
    // Discard comes here from the confirmation sheet, on the phone.
    if (phone) whenBackSettled(leave);
    else leave();
  };

  const composer = (
    <Composer
      key={`${threadId ?? ''}:${mode}`}
      mode={mode}
      threadId={threadId ?? undefined}
      accountId={accountFilter ?? undefined}
      onClose={close}
      variant="page"
      autoFocus
    />
  );
  return phone ? composer : <Layout context="compose">{composer}</Layout>;
}
