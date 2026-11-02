import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../api/client';
import { pushStatus, turnOffPush, turnOnPush, type PushStatus } from './push';

/** Asked again on every look: the owner can change the permission in the browser while the app is open. */
export function usePushStatus() {
  return useQuery({ queryKey: qk.pushStatus(), queryFn: pushStatus, staleTime: 0, retry: false });
}

function useAfterPush() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.pushStatus() });
    void qc.invalidateQueries({ queryKey: qk.pushDevices() });
  };
}

export function useTurnOnPush() {
  return useMutation({ mutationFn: turnOnPush, onSettled: useAfterPush() });
}

export function useTurnOffPush() {
  return useMutation({ mutationFn: turnOffPush, onSettled: useAfterPush() });
}

export type { PushStatus };
